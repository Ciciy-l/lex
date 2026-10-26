import path from 'node:path';
import { TurnDispatchRejectedError, type AgentSessionHandle } from '../base-agent.js';
import type { AgentEvent, InteractionResolver } from '../../types/events.js';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import type { OmpSessionRuntime } from './session-handle.js';
import type { OmpNativeSessionHandle } from './native-session.js';
import { findNativeJournalEntry } from '../shared/native-session-tree.js';

/** OMP exposes tree mutation in its official RPC frontend, not its TUI extension.
 * Retire the exact TUI first, perform one RPC fork, checkpoint the readback, then
 * reopen that history. The Host transaction owns all input until DB commit. */
export function manageOmpNativeHistory(options: {
  initial: OmpNativeSessionHandle;
  model: string;
  openRpc(nativeId: string): Promise<OmpSessionRuntime>;
  openNative(nativeId: string): Promise<OmpNativeSessionHandle>;
}): AgentSessionHandle {
  let current = options.initial;
  let changing = false, closed = false, usable = true, generation = 0, owner = 0;
  let resolver: AgentNativeInputResolver | undefined, media: AgentNativeMediaResolver | undefined;
  let interaction: InteractionResolver | undefined;
  let rpc: OmpSessionRuntime | undefined, staged: OmpNativeSessionHandle | undefined;
  let change: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let savedDraft: string | undefined;
  let priorTokenUsage = 0, priorCost = 0;
  const events = createAsyncQueue<AgentEvent>();
  const live = () => {
    if (closed || changing || !usable) throw new TurnDispatchRejectedError('OMP history handoff is not ready');
  };
  const usage = () => {
    const value = current.getUsageSnapshot();
    return { ...value, tokenUsage: priorTokenUsage + value.tokenUsage, costUsd: priorCost + value.costUsd };
  };
  const forward = (handle: AgentSessionHandle, replacement: boolean) => {
    const epoch = ++generation;
    void (async () => {
      try {
        for await (const event of handle.events()) {
          if (closed || epoch !== generation) return;
          if (replacement && event.type === 'session_id') continue;
          events.push(event.type === 'status' ? { ...event, data: { ...event.data as object, ...usage() } } : event);
        }
      } finally { if (!closed && epoch === generation) events.end(); }
    })().catch(() => { if (!closed && epoch === generation) { usable = false; events.end(); } });
  };
  forward(current, false);
  const overrides: Partial<AgentSessionHandle> = {
    capabilityOverrides: { ...options.initial.capabilityOverrides, sessionTree: { supported: true } },
    setInteractionResolver(next) { interaction = next; if (usable && !changing) current.setInteractionResolver(next); },
    setNativeInputResolver(next, nextMedia) {
      if (resolver !== next || media !== nextMedia) owner++;
      resolver = next; media = nextMedia;
      if (usable && !changing) current.setNativeInputResolver?.(next, nextMedia);
    },
    validateSendOptions(value) { live(); current.validateSendOptions?.(value); },
    async send(message, value) { live(); await current.send(message, value); },
    async steer(message, value) { live(); await current.steer(message, value); },
    async abort() { live(); await current.abort(); },
    isTurnRunning: () => changing || !usable || (current.isTurnRunning?.() ?? false),
    getCurrentTurnId: () => current.getCurrentTurnId?.() ?? null,
    async setVendorOptions(patch) {
      if (changing && Object.keys(patch).some(key => key.startsWith('orca') || key === 'initialWorker')) {
        owner++; current.revokeOrcaIdentity?.(); staged?.revokeOrcaIdentity?.();
      }
      live(); await current.setVendorOptions!(patch);
    },
    async setPermissionMode(mode) { live(); await current.setPermissionMode!(mode); },
    async setModel(model, selection) { live(); await current.setModel!(model, selection); },
    async setEffort(effort) { live(); await current.setEffort!(effort); },
    getEffort: () => current.getEffort?.() ?? null,
    async getSessionTree() { live(); return { ...(await current.readSessionTree!()).tree, navigationMode: 'fork' }; },
    async readSessionTree() {
      live(); const result = await current.readSessionTree!();
      return { ...result, tree: { ...result.tree, navigationMode: 'fork' } };
    },
    async readNativeEditorDraft() { return savedDraft ?? await current.readNativeEditorDraft!(); },
    async restoreNativeEditorDraft(text) { live(); await current.restoreNativeEditorDraft!(text); },
    async navigateSessionTree(entryId, navigation, handoff) {
      live();
      if (!handoff || current.isTurnRunning?.() || !entryId || entryId.length > 128 || navigation?.summarize)
        throw new TurnDispatchRejectedError('OMP history replacement requires an idle managed task');
      changing = true;
      const old = current, source = old.id, epoch = owner, effort = old.getEffort?.();
      const assertCurrent = () => { if (closed || owner !== epoch) throw new Error('OMP history owner changed'); };
      const task = (async () => {
        const release = old.presentation!.suspendInput!(); handoff.holdInput(release);
        savedDraft = await old.readNativeEditorDraft!();
        assertCurrent();
        if (savedDraft === undefined || old.isTurnRunning?.()) throw new Error('OMP history draft is unavailable');
        await handoff.beforeReplacement(); assertCurrent();
        generation++; usable = false;
        await old.close(); assertCurrent();
        rpc = await options.openRpc(source); assertCurrent();
        const state = (await rpc.host.client.request({ type: 'get_state' }).response).data as { sessionFile?: string; model?: { id?: string; provider?: string } };
        if (state.sessionFile !== source || state.model?.id !== options.model || state.model.provider !== 'cindy') throw new Error('OMP RPC source identity changed');
        const tree = (await rpc.host.client.request({ type: 'get_tree' }).response).data;
        if (!findNativeJournalEntry(tree, entryId)) throw new Error('OMP history entry is unavailable');
        assertCurrent();
        const forked = (await rpc.host.client.request({ type: 'fork', entryId }).response).data as { cancelled?: boolean };
        const after = (await rpc.host.client.request({ type: 'get_state' }).response).data as { sessionFile?: string; model?: { id?: string; provider?: string } };
        const target = after.sessionFile;
        if (!target || !path.isAbsolute(target) || path.dirname(target) !== path.dirname(source)
          || after.model?.id !== options.model || after.model.provider !== 'cindy'
          || (forked.cancelled && target !== source)) throw new Error('OMP RPC target identity changed');
        assertCurrent(); await handoff.target(target); assertCurrent();
        if (!await rpc.stopAndDispose()) throw new Error('OMP RPC exit is unconfirmed');
        rpc = undefined; assertCurrent();
        const next = await options.openNative(target); staged = next;
        handoff.holdInput(next.presentation!.suspendInput!());
        assertCurrent();
        if (next.id !== target || next.model !== options.model) throw new Error('OMP replacement identity changed');
        if (effort != null) {
          await next.setEffort!(effort);
          if (next.getEffort?.() !== effort) throw new Error('OMP replacement effort changed');
        }
        await next.restoreNativeEditorDraft!(savedDraft);
        if (await next.readNativeEditorDraft!() !== savedDraft) throw new Error('OMP replacement draft changed');
        const result = await next.readSessionTree!(); assertCurrent();
        if (resolver) next.setNativeInputResolver?.(resolver, media);
        if (interaction) next.setInteractionResolver(interaction);
        const previous = usage(); priorTokenUsage = previous.tokenUsage; priorCost = previous.costUsd;
        current = next; staged = undefined; usable = true; savedDraft = undefined;
        forward(next, true);
        return { ...result, tree: { ...result.tree, navigationMode: 'fork' as const },
          nativeIdentity: { source, target }, ...(forked.cancelled ? { cancelled: true } : {}) };
      })();
      change = task;
      try { return await task; }
      finally {
        changing = false;
        // Failed handoffs retain the durable fact and input hold. No automatic
        // fork/reopen/replay; confirmed targets are recovered by Host startup.
        if (rpc) { if (await rpc.stopAndDispose()) rpc = undefined; }
        if (staged) { await staged.close(); staged = undefined; }
      }
    },
    getUsageSnapshot: usage, events: () => events,
    close() {
      if (closing) return closing;
      closed = true; generation++;
      closing = (async () => {
        await Promise.all([current.close(), staged?.close(), rpc?.stopAndDispose()]);
        await change?.catch(() => {});
        if (rpc && !await rpc.stopAndDispose()) throw new Error('OMP RPC exit is unconfirmed');
        await staged?.close(); events.end();
      })();
      return closing;
    },
  };
  return new Proxy(overrides as AgentSessionHandle, { get(target, key) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key);
    const value = Reflect.get(current, key);
    return typeof value === 'function' ? (...args: unknown[]) => { live(); return value.apply(current, args); } : value;
  } });
}
