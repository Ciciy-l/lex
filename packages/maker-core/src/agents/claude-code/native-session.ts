import { randomUUID } from 'node:crypto';
import { createClaudeNativeContextReader } from './native-context.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import type { UsageTracker } from '../shared/usage-tracker.js';
import type { UserMessage } from '../../types/common.js';
import { NotSupportedError } from '../../types/capabilities.js';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type AgentSessionHandle, type SendOptions } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { createClaudeNativeRuntime, type ClaudeNativeRuntime, type ClaudeNativeRuntimeOptions } from './native-runtime.js';
import type { ClaudeNativeSubmission } from './native-messages.js';

export const CLAUDE_ORCA_IDENTITY_KEYS = ['orcaRole', 'orcaWorkflowId', 'orcaLeadSessionId',
  'orcaWorkerId', 'orcaWorkerSessionId', 'initialWorker'] as const;

/** Existing Claude policy is supplied by the adapter, never rebuilt by the terminal. */
export interface ClaudeNativeSessionPolicy {
  /** Update only host identity for an already registered, fixed Orca catalog. */
  prepareOrcaIdentity?(patch: Record<string, unknown>): (() => void) | undefined;
  /** Same authority object used by the MCP handlers, not a requested-settings cache. */
  readOrcaIdentity?(): Record<string, unknown>;
  revokeOrcaIdentity?(): void;
  setInteractionResolver(resolver: InteractionResolver): void;
  setExtraDirs?(dirs: string[]): Promise<void>;
  setWritableDirs?(dirs: string[]): Promise<void>;
  validateSendOptions?(options: SendOptions): void;
  beforeInput(message: UserMessage, options: SendOptions): void | Promise<void>;
  onEvent?(event: AgentEvent): void;
  close(): void | Promise<void>;
}

export interface ClaudeNativeSessionOptions {
  model: string;
  /** Exact CLI model after the existing host route/capability mapping. */
  nativeModel?: string;
  usageTracker?: UsageTracker;
  disabledSkillPaths?: AgentSessionHandle['disabledSkillPaths'];
  runtime: Omit<ClaudeNativeRuntimeOptions, 'onNativeInput' | 'importNativeMedia' | 'onInputPreparation' | 'onTurnAdmission' | 'onAgentEvent' | 'onUserMessage' | 'onExit' | 'onFault' | 'usageTracker'>;
  policy: ClaudeNativeSessionPolicy;
  /** Uses the existing local/SSH image and mention preparation for this route. */
  prepareInput(message: UserMessage, signal?: AbortSignal, importMedia?: AgentNativeMediaResolver): Promise<Pick<ClaudeNativeSubmission, 'text' | 'imagePaths'>>;
  onFault(reason: string): void;
  /** Shared with the existing policy, so dismissals/notices reach the same consumer. */
  events?: AsyncQueue<AgentEvent>;
}

interface InputEntry {
  id: string;
  nativeId?: string;
  readonly cancelled: boolean;
  readonly signal: AbortSignal;
  cancel(): void;
  accepted: boolean;
  stop(): void;
}

/** Host adapter access for typed controls and native acceptance; never an IPC value. */
export interface ClaudeNativeSessionHandle extends AgentSessionHandle {
  readonly nativeRuntime: ClaudeNativeRuntime;
  readonly nativeModel?: string;
  isTurnRunning(): boolean;
  tryUpdateOrcaIdentity?(patch: Record<string, unknown>): Promise<boolean>;
  readOrcaIdentity?(): Record<string, unknown>;
  revokeOrcaIdentity?(): void;
}

/**
 * Maker's real handle over one interactive process. This owns semantic sends
 * and events; presentation attachments never participate in its lifecycle.
 * Engine selection stays gated until launch, controls and native parity pass.
 */
export async function createClaudeNativeSession(options: ClaudeNativeSessionOptions): Promise<ClaudeNativeSessionHandle> {
  const events = options.events ?? createAsyncQueue<AgentEvent>();
  const lifetime = new AbortController();
  const guiInputs = new Map<string, InputEntry>();
  const nativeInputs = new Map<string, InputEntry>();
  let resolver: AgentNativeInputResolver | undefined, importMedia: AgentNativeMediaResolver | undefined;
  let ownerGeneration = 0;
  let identityGeneration = 0;
  let runtime: ClaudeNativeRuntime | undefined;
  let currentTurn: { id: string; inputs: InputEntry[] } | undefined;
  const observedTurns = new Map<string, InputEntry[]>();
  let closed = false, exited = false, faulted = false, initialized = false;
  let closing: Promise<void> | undefined;
  let usage: UsageSnapshot = options.usageTracker?.snapshot() ?? { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };

  const live = () => !closed && !exited && !faulted;
  const requireLive = () => { if (!live()) throw new TurnDispatchRejectedError('Native Claude session is not active'); };
  const removeInput = (entry: InputEntry) => {
    entry.stop(); guiInputs.delete(entry.id);
    if (entry.nativeId) nativeInputs.delete(entry.nativeId);
  };
  const makeEntry = (id: string, signal?: AbortSignal): InputEntry => {
    if (signal?.aborted) throw new TurnDispatchRejectedError('Claude input cancelled before dispatch');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const entry: InputEntry = { id, get cancelled() { return controller.signal.aborted; },
      signal: controller.signal, cancel, accepted: false, stop: () => signal?.removeEventListener('abort', cancel) };
    signal?.addEventListener('abort', cancel, { once: true });
    return entry;
  };
  const fail = (reason: string) => {
    if (closed || faulted) return;
    faulted = true;
    events.push({ type: 'error', source: 'claude-code', data: { message: 'Claude 原生会话连接已中断。', isTerminal: true, reason: 'native-transport' } });
    events.end();
    try { options.onFault(reason); } finally { void close().catch(() => {}); }
  };
  function close(): Promise<void> {
    if (closing) return closing;
    identityGeneration++; options.policy.revokeOrcaIdentity?.();
    closed = true; lifetime.abort();
    for (const entry of new Set([...guiInputs.values(), ...nativeInputs.values()])) { entry.cancel(); entry.stop(); }
    guiInputs.clear(); nativeInputs.clear(); observedTurns.clear(); currentTurn = undefined;
    closing = Promise.resolve().then(async () => {
      try { await runtime?.close(); }
      finally { try { await options.policy.close(); } finally { events.end(); } }
    });
    return closing;
  }

  try {
    runtime = await createClaudeNativeRuntime({ ...options.runtime, usageTracker: options.usageTracker,
      onEvent(event) {
        const value = event.value as { turnId?: string; agentId?: string; messageIds?: string[]; reason?: string; isAborted?: boolean };
        if (live() && value && value.agentId === undefined && typeof value.turnId === 'string') {
          if (event.kind === 'turn.start' && Array.isArray(value.messageIds)) {
            if (observedTurns.size >= 128) throw new Error('Native turn identity limit');
            observedTurns.set(value.turnId, value.messageIds.flatMap(id => nativeInputs.get(id) ?? []));
          } else if (event.kind === 'turn.complete') {
            const inputs = observedTurns.get(value.turnId) ?? [];
            // A stopped accepted input can be refused at the first-step gate.
            // Its actual aborted terminal still settles that product reservation.
            if (!currentTurn && value.reason === 'aborted' && value.isAborted === true
              && inputs.length === 1 && inputs[0]!.accepted
              && nativeInputs.get(inputs[0]!.nativeId!) === inputs[0]) {
              events.push({ type: 'done', source: 'claude-code', data: { result: '', is_error: false, nativeTurnId: value.turnId, nativeTurnReason: 'aborted' } });
            }
            for (const input of inputs) removeInput(input);
            observedTurns.delete(value.turnId);
          }
        }
        options.runtime.onEvent(event);
      },
      onNativeInput: async input => {
        requireLive();
        const messageId = input.nativeMessageId;
        if (!messageId) throw new TurnDispatchRejectedError('Claude input has no native message identity');
        const owner = resolver;
        if (!owner) throw new TurnDispatchRejectedError('Native input has no product owner');
        await owner({ ...input, accept: async (message, sendOptions) => {
          requireLive();
          if (owner !== resolver || nativeInputs.has(messageId)) throw new TurnDispatchRejectedError('Native input owner changed');
          options.policy.validateSendOptions?.(sendOptions);
          const entry = makeEntry(messageId, sendOptions.signal);
          entry.nativeId = messageId; nativeInputs.set(entry.nativeId, entry);
          try {
            await options.policy.beforeInput(message, sendOptions);
            requireLive();
            if (entry.cancelled || input.signal.aborted || owner !== resolver) throw new TurnDispatchRejectedError('Native input cancelled before acceptance');
            await input.accept(message, sendOptions);
            entry.accepted = true;
          } catch (error) { removeInput(entry); throw error; }
        } });
      },
      importNativeMedia: input => {
        requireLive();
        if (!importMedia) throw new TurnDispatchRejectedError('Native media has no product owner');
        return importMedia(input);
      },
      onUserMessage(message) {
        const entry = message.submission && guiInputs.get(message.submission.submissionId);
        if (!entry) return;
        if (entry.nativeId || nativeInputs.has(message.row.uuid)) throw new Error('Native GUI receipt identity changed');
        entry.nativeId = message.row.uuid; entry.accepted = true;
        nativeInputs.set(message.row.uuid, entry);
      },
      async onTurnAdmission(turn, signal) {
        requireLive();
        if (signal.aborted) throw new Error('Native turn was cancelled');
        if (currentTurn || turn.messages.length !== 1) {
          fail('Native turn has no current product reservation');
          throw new Error('Native turn has no current product reservation');
        }
        const entries = turn.messages.map(message => nativeInputs.get(message.row.uuid));
        if (entries.some(entry => !entry || !entry.accepted)) {
          fail('Native input was not admitted by the product');
          throw new Error('Native input was not admitted by the product');
        }
        if (entries.some(entry => entry!.cancelled)) throw new Error('Native input was not admitted after cancellation');
        currentTurn = { id: turn.turnId, inputs: entries as InputEntry[] };
      },
      onAgentEvent(event) {
        if (!live()) return;
        options.policy.onEvent?.(event);
        if (event.type === 'status') {
          const value = event.data as Partial<UsageSnapshot>;
          if (typeof value.tokenUsage === 'number') usage = { ...usage, ...value };
        }
        if (event.type === 'done') {
          for (const entry of currentTurn?.inputs ?? []) removeInput(entry);
          currentTurn = undefined;
        }
        events.push(event);
      },
      onExit() {
        exited = true; lifetime.abort();
        if (!closed) {
          events.push({ type: 'error', source: 'claude-code', data: { message: 'Claude 原生进程已退出。', isTerminal: true, reason: 'native-exit' } });
          events.end();
        }
      },
      onFault: fail,
    });
    // Publish the already-live terminal before native onboarding finishes. The
    // original CLI can ask for trust/login; its user must be able to answer.
    void runtime.ready.then(() => {
      if (!live()) return;
      initialized = true;
      events.push({ type: 'session_id', data: options.runtime.nativeSessionId, source: 'claude-code' });
    }, () => { if (live()) fail('Native Claude initialization failed'); });
    requireLive();
  } catch (error) { if (closing) await runtime?.close(); await close(); throw error; }
  const native = runtime;
  const requestAbort = async () => {
    requireLive();
    for (const entry of [...guiInputs.values(), ...nativeInputs.values()]) entry.cancel();
    const turn = currentTurn;
    if (turn) await native.command('abort', { turnId: turn.id });
  };

  return {
    nativeRuntime: native,
    nativeModel: options.nativeModel ?? options.model,
    disabledSkillPaths: options.disabledSkillPaths,
    get id() { return initialized ? options.runtime.nativeSessionId : '<pending>'; },
    requestSessionId: options.runtime.nativeSessionId, agentKind: 'claude-code', model: options.model,
    presentation: native.presentation,
    capabilityOverrides: {
      sameTurnSteer: { supported: false, reason: 'not-implemented' },
      switchModel: { supported: false, reason: 'not-implemented', recovery: 'idle-restart' },
      effort: { supported: false, reason: 'not-implemented', recovery: 'idle-restart' },
      setPermissionModeMidSession: { supported: false, reason: 'not-implemented', recovery: 'idle-restart' },
      planMode: { supported: false, reason: 'not-implemented' },
    },
    setNativeInputResolver(next, media) {
      requireLive();
      if (resolver !== next || importMedia !== media) ownerGeneration++;
      resolver = next; importMedia = media;
    },
    async tryUpdateOrcaIdentity(patch) {
      requireLive();
      // Revoke the old role synchronously, before catalog IO can fail or race
      // an account change. A missing catalog cannot retain old authorization.
      const apply = options.policy.prepareOrcaIdentity?.({ ...patch });
      if (!apply) return false;
      const owner = ownerGeneration;
      const identity = ++identityGeneration;
      const tools = await native.command('tool-list', {}) as Array<{ name?: unknown }>;
      requireLive();
      if (owner !== ownerGeneration) throw new TurnDispatchRejectedError('Claude native input owner changed');
      if (identity !== identityGeneration) throw new TurnDispatchRejectedError('Claude native role changed');
      // These are native readbacks, not a claim that mutating a host closure
      // registered a new MCP server. Missing/disconnected catalogs need reopen.
      if (!Array.isArray(tools)
        || !tools.some(tool => tool.name === 'mcp__cindy_orca__start_team')
        || !tools.some(tool => tool.name === 'mcp__orca_worker_bridge__send_to_lead')) return false;
      apply(); return true;
    },
    readOrcaIdentity: options.policy.readOrcaIdentity && (() => ({ ...options.policy.readOrcaIdentity!() })),
    revokeOrcaIdentity() { identityGeneration++; options.policy.revokeOrcaIdentity?.(); },
    setInteractionResolver(next) { requireLive(); options.policy.setInteractionResolver(next); },
    async setExtraDirs(dirs) {
      requireLive();
      if (!options.policy.setExtraDirs) throw new NotSupportedError(
        'extraDirs', { supported: false, reason: 'not-implemented' });
      await options.policy.setExtraDirs(dirs);
    },
    async setWritableDirs(dirs) {
      requireLive();
      if (!options.policy.setWritableDirs) throw new NotSupportedError(
        'writableDirs', { supported: false, reason: 'not-implemented' });
      await options.policy.setWritableDirs(dirs);
    },
    validateSendOptions(sendOptions) { requireLive(); options.policy.validateSendOptions?.(sendOptions); },
    async send(message, sendOptions = {}) {
      requireLive(); options.policy.validateSendOptions?.(sendOptions);
      const id = sendOptions.messageUuid ?? randomUUID();
      if (currentTurn || guiInputs.size || nativeInputs.size) throw new TurnDispatchRejectedError('Native input is already pending');
      const owned = structuredClone(message);
      const entry = makeEntry(id, sendOptions.signal); guiInputs.set(id, entry);
      let dispatched = false;
      try {
        // A startup wait is definitively pre-dispatch: cancellation/timeout may
        // reject this input, but must not replay it or restart the native task.
        await waitForNativeReady(native.ready, entry.signal);
        requireLive();
        const input = await options.prepareInput(owned, entry.signal, importMedia);
        requireLive();
        if (entry.cancelled) throw new TurnDispatchRejectedError('Claude input cancelled before dispatch');
        await options.policy.beforeInput(owned, sendOptions);
        requireLive();
        if (entry.cancelled) throw new TurnDispatchRejectedError('Claude input cancelled before dispatch');
        dispatched = true;
        await native.submit({ ...input, messageId: id, originalContent: typeof owned.content === 'string'
          ? [{ type: 'text', text: owned.content }] : owned.content, onNativeUserMessage: sendOptions.onNativeUserMessage });
      } catch (error) {
        if (!dispatched) { removeInput(entry); throw error instanceof TurnDispatchRejectedError ? error : new TurnDispatchRejectedError('Claude input preparation failed before dispatch'); }
        // An accepted row is stronger evidence than a lost command response.
        // Without that receipt, Session must fence the runtime, never replay.
        if (!entry.accepted) throw new TurnDispatchUnconfirmedError('Native Claude input acceptance is unconfirmed');
      }
    },
    async steer() { throw new NotSupportedError('steer', { supported: false, reason: 'sdk-missing', upstreamRef: 'Mods prompt.submit queues a new turn' }); },
    abort: requestAbort,
    requestGracefulStop: requestAbort,
    getCurrentTurnId: () => currentTurn?.id ?? null,
    isTurnRunning: () => Boolean(currentTurn || guiInputs.size || nativeInputs.size),
    events: () => events,
    getUsageSnapshot: () => ({ ...usage }),
    getContextUsage: createClaudeNativeContextReader(native, lifetime.signal, live),
    async readNativeEditorDraft() {
      requireLive();
      if (currentTurn || guiInputs.size || nativeInputs.size) throw new TurnDispatchRejectedError('Native Claude input is not idle');
      const snapshot = await native.command('snapshot', {}) as { draft?: { text?: unknown } };
      if (typeof snapshot.draft?.text !== 'string') throw new Error('Native Claude draft could not be read');
      return snapshot.draft.text;
    },
    async restoreNativeEditorDraft(text) {
      requireLive();
      if (currentTurn || guiInputs.size || nativeInputs.size) throw new TurnDispatchRejectedError('Native Claude input is not idle');
      await native.command('restore-draft', { text });
    },
    close,
  };
}

/** Bound only the pending GUI input, never a native dialog awaiting its user. */
function waitForNativeReady(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve();
    };
    const cancelled = () => finish(new TurnDispatchRejectedError('Claude input cancelled before initialization'));
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => finish(new TurnDispatchRejectedError('Native Claude is not ready to accept GUI input')), 120_000);
    timer.unref();
    void ready.then(() => finish(), error => finish(error));
  });
}
