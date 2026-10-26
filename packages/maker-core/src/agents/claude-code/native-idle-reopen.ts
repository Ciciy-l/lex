import path from 'node:path';
import { TurnDispatchRejectedError, type AgentSessionHandle } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { CLAUDE_ORCA_IDENTITY_KEYS, type ClaudeNativeSessionHandle } from './native-session.js';
import type { Effort } from '../../types/common.js';

/** Internal recursion guard: a renderer cannot request an unwrapped executor. */
export const CLAUDE_NATIVE_RAW = Symbol('claude-native-raw');
export const CLAUDE_NATIVE_USAGE = Symbol('claude-native-usage');

/** A configuration replacement is an idle lifecycle operation, never a prompt.
 * The factory must rebuild the complete policy/MCP context, after confirmed
 * shutdown. Only native readback may publish the replacement model. */
export function manageClaudeNativeModel(options: {
  initial: ClaudeNativeSessionHandle;
  cwd: string;
  providerId?: string | null;
  effort?: Effort;
  vendorOptions?: Record<string, unknown>;
  reopen(model: string, nativeId: string, vendorOptions: Record<string, unknown>): Promise<ClaudeNativeSessionHandle>;
}): AgentSessionHandle {
  let current = options.initial;
  let model = current.model;
  let vendorOptions = { ...options.vendorOptions };
  let resolver: AgentNativeInputResolver | undefined, media: AgentNativeMediaResolver | undefined;
  let interaction: InteractionResolver | undefined;
  let changing = false, closed = false, usable = true, generation = 0;
  let identityUpdating = false;
  let ownerGeneration = 0;
  let changingTask: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let savedDraft: string | undefined;
  let staged: ClaudeNativeSessionHandle | undefined;
  let exitConfirmed = false;
  let heldUsage: UsageSnapshot | undefined;
  const events = createAsyncQueue<AgentEvent>();
  const syncIdentity = () => {
    const identity = current.readOrcaIdentity?.();
    if (identity) vendorOptions = { ...vendorOptions, ...identity };
  };
  const live = () => {
    if (closed) throw new TurnDispatchRejectedError('Native Claude session is not active');
    if (changing || !usable) throw new TurnDispatchRejectedError('Claude native configuration is not ready');
  };
  const forward = (handle: ClaudeNativeSessionHandle) => {
    const epoch = ++generation;
    void (async () => {
      try { for await (const event of handle.events()) {
        if (closed || epoch !== generation) return;
        if (event.type === 'status' && typeof (event.data as Partial<UsageSnapshot>)?.tokenUsage === 'number') heldUsage = undefined;
        events.push(event);
      } } catch {
        if (!closed && epoch === generation) {
          usable = false;
          events.push({ type: 'error', source: 'claude-code', data: {
            message: 'Claude 原生会话连接已中断。', isTerminal: true, reason: 'native-transport',
          } });
        }
      } finally { if (!closed && epoch === generation) events.end(); }
    })();
  };
  forward(current);
  const snapshot = async (handle: ClaudeNativeSessionHandle, expectedModel: string, nativeId: string) => {
    await handle.nativeRuntime.ready;
    const state = await handle.nativeRuntime.command('snapshot', {}) as { sessionId?: unknown; cwd?: unknown; model?: unknown; draft?: { text?: unknown } };
    const cwd = typeof state.cwd === 'string' ? path.resolve(state.cwd) : '';
    const expectedCwd = path.resolve(options.cwd);
    if (handle.id !== nativeId || state.sessionId !== nativeId || handle.model !== expectedModel || state.model !== (handle.nativeModel ?? expectedModel)
      || (process.platform === 'win32' ? cwd.toLowerCase() !== expectedCwd.toLowerCase() : cwd !== expectedCwd)
      || typeof state.draft?.text !== 'string') throw new Error('Native Claude identity or exact model readback changed');
    return state.draft.text;
  };
  const install = async (nextModel: string, nativeId: string, draft: string, owner: number, nextVendorOptions: Record<string, unknown>) => {
    // A factory rejection alone cannot prove no executor was launched. Until
    // a returned handle has confirmed its exit, another writer is forbidden.
    exitConfirmed = false;
    const next = await options.reopen(nextModel, nativeId, { ...nextVendorOptions });
    staged = next;
    const release = next.presentation?.suspendInput?.();
    try {
      if (closed || owner !== ownerGeneration) throw new Error('Claude task closed or owner changed during replacement');
      await snapshot(next, nextModel, nativeId);
      if (closed || owner !== ownerGeneration) throw new Error('Claude task closed or owner changed during replacement');
      if (resolver) next.setNativeInputResolver?.(resolver, media);
      if (interaction) next.setInteractionResolver(interaction);
      await next.restoreNativeEditorDraft!(draft);
      if (await snapshot(next, nextModel, nativeId) !== draft || closed || owner !== ownerGeneration) throw new Error('Claude replacement draft or owner changed');
      current = next; model = nextModel; vendorOptions = nextVendorOptions; usable = true;
      syncIdentity();
      exitConfirmed = false;
      staged = undefined;
      forward(next);
    } catch (error) {
      // If exit cannot be confirmed, propagate that fact. No second executor
      // may open the same history after an unconfirmed close.
      await next.close();
      staged = undefined;
      exitConfirmed = true;
      throw error;
    } finally { release?.(); }
  };
  const changeConfiguration = (nextModel: string, patch?: Record<string, unknown>): Promise<void> => {
    if (closed || changing || (!usable && (!exitConfirmed || staged)))
      throw new TurnDispatchRejectedError('Claude native configuration is not ready');
    if (current.isTurnRunning()) throw new TurnDispatchRejectedError('Claude native configuration changes require an idle task');
    // Retired executors have already revoked their handlers. An explicit
    // recovery uses the last confirmed snapshot, never an unconfirmed request.
    if (usable) syncIdentity();
    const nextVendorOptions = { ...vendorOptions, ...patch };
    const changed = Object.keys(nextVendorOptions).some(key => nextVendorOptions[key] !== vendorOptions[key]);
    if (usable && nextModel === model && !changed) return Promise.resolve();
    changing = true;
    const old = current, nativeId = old.id, oldModel = model;
    const owner = ownerGeneration;
    const release = usable ? old.presentation?.suspendInput?.() : undefined;
    const task = (async () => {
      try {
        if (usable) {
          savedDraft = await snapshot(old, oldModel, nativeId);
          if (closed || owner !== ownerGeneration || old.isTurnRunning()) throw new Error('Claude task changed before replacement');
          heldUsage = heldUsage ?? old.getUsageSnapshot();
          generation++; usable = false;
          // Main revokes the old MCP token before waiting for this exact PTY.
          await old.close(); exitConfirmed = true;
        }
        if (closed || owner !== ownerGeneration) throw new Error('Claude task closed or owner changed during replacement');
        if (savedDraft === undefined) throw new Error('Claude replacement has no saved draft');
        await install(nextModel, nativeId, savedDraft, owner, nextVendorOptions);
        savedDraft = undefined;
      } finally { changing = false; release?.(); }
    })();
    changingTask = task;
    void task.finally(() => { if (changingTask === task) changingTask = undefined; }).catch(() => {});
    return task;
  };
  return {
    ...options.initial,
    get id() { return current.id; },
    get requestSessionId() { return current.requestSessionId; },
    get model() { return model; },
    get disabledSkillPaths() { return current.disabledSkillPaths; },
    get presentation() { return current.presentation; },
    capabilityOverrides: { ...options.initial.capabilityOverrides, switchModel: { supported: true } },
    setNativeInputResolver(next, nextMedia) {
      if (resolver && (resolver !== next || media !== nextMedia)) ownerGeneration++;
      resolver = next; media = nextMedia;
      if (usable && (!changing || identityUpdating)) current.setNativeInputResolver?.(next, nextMedia);
    },
    setInteractionResolver(next) {
      interaction = next;
      if (usable && (!changing || identityUpdating)) current.setInteractionResolver(next);
    },
    validateSendOptions(value) { live(); current.validateSendOptions?.(value); },
    async send(message, value) { live(); await current.send(message, value); },
    async steer(message, value) { live(); await current.steer(message, value); },
    async abort() { live(); await current.abort(); },
    async requestGracefulStop(value) { live(); await current.requestGracefulStop!(value); },
    isTurnRunning: () => changing || current.isTurnRunning(),
    getCurrentTurnId: () => current.getCurrentTurnId?.() ?? null,
    requiresModelSwitchRebuild: (_model, selection) => selection?.providerId !== undefined && selection.providerId !== options.providerId,
    async setModel(next, selection) {
      if (selection?.providerId !== undefined && selection.providerId !== options.providerId)
        throw new TurnDispatchRejectedError('Claude provider changes require the managed route rebuild');
      if (selection?.effort !== undefined && selection.effort !== options.effort)
        throw new TurnDispatchRejectedError('Native Claude effort readback is unavailable');
      await changeConfiguration(next);
    },
    async setVendorOptions(patch) {
      const owned = { ...patch };
      if ((changing || !usable) && Object.keys(owned).some(key => (CLAUDE_ORCA_IDENTITY_KEYS as readonly string[]).includes(key))) {
        // Revocation must win even while a model replacement or an older
        // role readback owns the lifecycle gate. The caller may explicitly
        // retry entry afterwards; no rejected role request is queued. This
        // also supersedes the confirmed snapshot held after a failed settings
        // replacement, even if this explicit recovery fails again.
        ownerGeneration++;
        current.revokeOrcaIdentity?.(); staged?.revokeOrcaIdentity?.();
        syncIdentity();
      }
      if (!usable) { await changeConfiguration(model, owned); return; }
      live();
      syncIdentity();
      if (Object.keys(owned).every(key => owned[key] === vendorOptions[key])) return;
      const identityPatch = Object.keys(owned).length > 0
        && Object.keys(owned).every(key => (CLAUDE_ORCA_IDENTITY_KEYS as readonly string[]).includes(key));
      // A catalog change may need restart after it has revoked the live role.
      // Keep this explicit request separate from the confirmed/revoked cache.
      const requested = identityPatch && current.readOrcaIdentity
        ? { ...current.readOrcaIdentity(), ...owned } : owned;
      // Orca's fixed startup catalog can change its host-authorized identity
      // while start_team/end_team is itself awaiting this operation. General
      // settings or a changed registration set still require idle replacement.
      changing = identityUpdating = true;
      try {
        if (await current.tryUpdateOrcaIdentity?.(requested)) {
          vendorOptions = { ...vendorOptions, ...requested };
          return;
        }
      } finally {
        // prepareOrcaIdentity revokes synchronously. Catalog rejection or
        // timeout must publish that fact just as success publishes new identity.
        syncIdentity();
        changing = identityUpdating = false;
      }
      await changeConfiguration(model, requested);
    },
    async readNativeEditorDraft() { return savedDraft ?? await current.readNativeEditorDraft!(); },
    async restoreNativeEditorDraft(text) { live(); await current.restoreNativeEditorDraft!(text); },
    async setExtraDirs(dirs) { live(); await current.setExtraDirs!(dirs); },
    async setWritableDirs(dirs) { live(); await current.setWritableDirs!(dirs); },
    async getContextUsage() { live(); return current.getContextUsage!(); },
    // Replacements share the original tracker; per-turn token/output fields
    // must never be summed across executors. No synthetic usage events.
    getUsageSnapshot: () => ({ ...(heldUsage ?? current.getUsageSnapshot()) }), events: () => events,
    close() {
      if (closing) return closing;
      closed = true; generation++;
      closing = (async () => {
        // Cancel readiness/readback now, not after an operation waiting on it.
        const retired = Promise.all([current.close(), staged?.close()]);
        void retired.catch(() => {});
        try { await changingTask?.catch(() => {}); await retired; await staged?.close(); }
        finally { events.end(); }
      })();
      return closing;
    },
  };
}
