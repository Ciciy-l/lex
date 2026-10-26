import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeMessageSource } from '@cindy/maker-shared/message-presentation';
import { GUI_NATIVE_APPEND, GUI_NATIVE_BODY, ORCA_NATIVE_BODY, TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type AgentSessionHandle, type SendOptions, type OrcaNativeBodySource } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeInputOwnership, AgentNativeMediaResolver } from '../native-input.js';
import { AgentPresentationRuntime, type AgentTerminalDriver } from '../presentation.js';
import { NativeSessionBridge } from '../shared/native-session-bridge.js';
import type { UserContentBlock, UserMessage } from '../../types/common.js';
import type { PiRpcProcess, PiRpcSpawnOptions, PiRpcResponse } from './rpc-client.js';

/** Shared host control contract; the native implementation never starts an RPC frontend. */
export type PiSessionControl = Pick<PiRpcProcess, 'pid' | 'isClosed' | 'request' | 'send' | 'close'>;
export interface PiLocalNativeSessionOptions extends Omit<PiRpcSpawnOptions, 'transport'> {
  sessionId: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  extensionPath: string;
  model: string;
  provider: string;
  hostProviderId?: string | null;
  resumeSessionId?: string;
  registerProcess?(pid: number): void | (() => void);
  /** Reads the live Host role closure; never supplied by renderer or extensions. */
  isDelegatedInputCurrent?(source: OrcaNativeBodySource): boolean;
}
export interface PiNativeTerminalOptions extends PiLocalNativeSessionOptions {
  launch(environment: Record<string, string>): Promise<AgentTerminalDriver & { readonly pid: number }>;
}
type GuiInput = { options: SendOptions; accepted: boolean; refused: boolean; commandId?: number; text?: string; turnRowId?: string; version: number; hostIdentityVersion: number };
type ActiveInput = { rowId: string; owner?: AgentNativeInputResolver; ownership?: AgentNativeInputOwnership; cancelled?: boolean };
type PreparedPrompt = { text: string; images?: readonly unknown[] };

/** One original interactive Pi, its official extension, and the existing Core/Host policy. */
export class PiNativeSessionControl implements PiSessionControl {
  private readonly lifetime = new AbortController();
  private readonly bridge: NativeSessionBridge;
  private terminal?: AgentTerminalDriver & { readonly pid: number };
  private presentation?: AgentPresentationRuntime;
  private nativeId?: string;
  private resolver?: AgentNativeInputResolver;
  private importMedia?: AgentNativeMediaResolver;
  private prepareInput?: (message: UserMessage, options: SendOptions, steering: boolean) => Promise<PreparedPrompt>;
  private gui?: GuiInput;
  private active?: ActiveInput;
  private earlyStart?: Record<string, unknown>;
  private admitting = false;
  private inputVersion = 0;
  private hostIdentityVersion = 0;
  private historyTarget?: (nativeId: string) => Promise<void>;
  private closed = false;
  private cleanIdleExit = false;
  private faulted = false;
  private closing?: Promise<void>;
  private presentationClosed = false;
  private started = false;
  private readonly rows = new Set<string>();
  private readonly uiResponses = new Map<string, (value: Record<string, unknown>) => void>();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });

  constructor(private readonly options: PiNativeTerminalOptions) {
    void this.ready.catch(() => {});
    this.bridge = new NativeSessionBridge({ sessionId: options.sessionId, environmentPrefix: 'LEX_PI_BRIDGE',
      onFault: () => this.fail(),
      onEvent: event => {
        if (this.closed || this.faulted) return;
        const value = record(event.value);
        if (event.kind === 'ready') {
          const file = value.sessionFile;
          if (this.nativeId || typeof file !== 'string' || !path.isAbsolute(file) ||
              (options.resumeSessionId && !sameFile(file, options.resumeSessionId)) ||
              value.model !== options.model || value.provider !== options.provider) { this.fail(); return; }
          this.nativeId = file; this.readyResolve();
        } else if (event.kind === 'native-queue-retired') {
          if (!this.nativeId || value.sessionFile !== this.nativeId || this.active) { this.fail(); return; }
          void this.close().catch(() => this.options.logger.warn('Pi cancelled input exit could not be confirmed'));
        } else if (event.kind === 'agent-event') {
          if (!this.nativeId || value.sessionFile !== this.nativeId) { this.fail(); return; }
          const frame = record(value.event);
          if (frame.type === 'agent_settled') { this.inputVersion++; this.earlyStart = undefined; }
          if (frame.type === 'agent_start' && !this.active) { this.earlyStart = frame; return; }
          if (this.active) this.publish(frame);
        }
      },
      onRequest: async (request, signal) => {
        this.requireLive();
        const value = record(request.input);
        if (!this.nativeId || value.sessionFile !== this.nativeId) throw new Error('Pi callback belongs to another task');
        if (request.kind === 'history-target') {
          const target = value.targetSessionFile;
          if (!this.historyTarget || this.active || this.gui || typeof target !== 'string' || !path.isAbsolute(target)
            || path.dirname(target) !== path.dirname(this.nativeId)) throw new Error('Pi history target is not owned');
          await this.historyTarget(target); this.requireLive();
          return { accepted: true };
        }
        if (request.kind === 'native-input') return this.admit(value, signal);
        if (request.kind === 'provider-admission') {
          const active = this.active;
          return { accepted: Boolean(active && !active.cancelled && value.turnRowId === active.rowId && !signal.aborted
            && (!active.ownership || active.ownership.isCurrent())) };
        }
        if (request.kind === 'native-fault') {
          const phase = typeof value.phase === 'string' && ['input-association', 'input-admission', 'journal-unavailable', 'runtime-selection'].includes(value.phase) ? value.phase : 'transport';
          options.logger.warn('Pi native bridge interrupted', { phase }); this.fail(); return { reported: true };
        }
        if (request.kind !== 'host-ui') throw new Error('Unknown Pi native callback');
        if (!this.active || this.active.cancelled || (this.active.ownership && !this.active.ownership.isCurrent()))
          throw new Error('Pi request has no current input owner');
        const id = 'pi-native:' + request.requestId;
        let abort: (() => void) | undefined;
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          abort = () => reject(new Error('Pi host interaction cancelled'));
          if (signal.aborted) { abort(); return; }
          this.uiResponses.set(id, resolve);
          signal.addEventListener('abort', abort, { once: true });
          this.options.onEvent({ ...record(value.event), type: 'extension_ui_request', id });
        }).finally(() => { if (abort) signal.removeEventListener('abort', abort); this.uiResponses.delete(id); });
      },
    });
  }

  async start(): Promise<this> {
    if (this.started) throw new Error('Pi native frontend already started');
    this.started = true;
    try {
      await this.bridge.start();
      this.terminal = await this.options.launch(this.bridge.environment());
      this.terminal.onExit(exit => {
        this.cleanIdleExit = Boolean(this.nativeId) && !this.faulted && exit.code === 0 && !exit.signal
          && !this.gui && !this.active && !this.admitting && !this.earlyStart;
        this.closed = true; this.lifetime.abort(); this.readyReject(new Error('Pi native process exited before ready'));
        void this.bridge.close();
        this.options.onExit({ code: exit.code, signal: null });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Pi native extension did not initialize')), 30_000); })]);
      } finally { clearTimeout(timer); }
      this.requireLive();
      this.presentation = new AgentPresentationRuntime(this.nativeId!, this.terminal);
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  /** Keep the existing Pi runtime's configuration/permissions/translator methods. */
  bindHandle(handle: AgentSessionHandle, prepare: (message: UserMessage, options: SendOptions, steering: boolean) => Promise<PreparedPrompt>): AgentSessionHandle {
    this.requireLive(); this.prepareInput = prepare;
    const send = handle.send.bind(handle);
    return { ...handle, get id() { return handle.id; }, get model() { return handle.model; }, presentation: this.presentation,
    capabilityOverrides: { ...handle.capabilityOverrides,
      sameTurnSteer: { supported: true },
      rewind: { supported: false, reason: 'not-implemented' },
      sessionTree: { supported: true } },
    readNativeEditorDraft: async () => {
      const result = await this.request({ type: 'editor_draft' });
      const value = record(result.data).text;
      if (!result.success || typeof value !== 'string') throw new Error('Pi editor draft could not be read');
      return value;
    },
    restoreNativeEditorDraft: async text => {
      if (!(await this.request({ type: 'restore_editor_draft', text })).success) throw new Error('Pi editor draft could not be restored');
    },
    setNativeInputResolver: (resolver, importMedia) => {
      this.requireLive();
      if (this.resolver && this.resolver !== resolver) { this.inputVersion++; if (this.active) this.active.cancelled = true; }
      this.resolver = resolver; this.importMedia = importMedia;
    },
    send: async (message, options = {}) => {
      this.requireLive();
      if (this.gui || this.active || this.admitting || options.signal?.aborted) throw new TurnDispatchRejectedError('Pi native input is busy or cancelled');
      const input: GuiInput = { options: { ...options, messageUuid: options.messageUuid ?? randomUUID() }, accepted: false, refused: false, version: this.inputVersion, hostIdentityVersion: this.hostIdentityVersion }; this.gui = input;
      try { await send(message, options); }
      finally { if (this.gui === input) this.gui = undefined; }
    },
    steer: async (message, options = {}) => {
      this.requireLive();
      if (options[GUI_NATIVE_APPEND] !== true) throw new TurnDispatchRejectedError('Pi native GUI append requires an explicit GUI intent');
      if (this.gui || this.admitting || !this.active || this.active.cancelled || options.signal?.aborted)
        throw new TurnDispatchRejectedError('Pi native steering has no current turn');
      const input: GuiInput = { options: { ...options, messageUuid: options.messageUuid ?? randomUUID() },
        accepted: false, refused: false, turnRowId: this.active.rowId, version: this.inputVersion, hostIdentityVersion: this.hostIdentityVersion };
      this.gui = input;
      try {
        // The dedicated GUI channel sends text, preserving Host policy and
        // media preparation without invoking native input/slash transformations.
        const prepared = await prepare(message, options, true);
        const answer = await this.request({ type: 'steer', message: prepared.text, images: prepared.images });
        if (!answer.success) throw new TurnDispatchRejectedError('Pi GUI append was not consumed');
      }
      finally { if (this.gui === input) this.gui = undefined; }
    },
    getCurrentTurnId: () => this.active?.rowId ?? null,
    // Native context can contain an independent queued row before the
    // agent_start event reaches the translator. Its admitted root already
    // owns this turn; do not reject that addition as an idle new prompt.
    // Admission itself is not running: an idle native row still needs the
    // Session reservation before it becomes active.
    isTurnRunning: () => !this.isClosed && (Boolean(this.active) || (handle.isTurnRunning?.() ?? false)),
    requiresModelSwitchRebuild: (model, target) => model !== handle.model ||
      (target?.providerId !== undefined && target.providerId !== this.options.hostProviderId) ||
      (handle.requiresModelSwitchRebuild?.(model, target) ?? false),
    };
  }

  get pid(): number | undefined { return this.terminal?.pid; }
  invalidateHostIdentity(): void { this.hostIdentityVersion++; }
  async updateHostIdentity(apply: () => void): Promise<void> {
    this.requireLive();
    const version = this.inputVersion;
    const identityVersion = ++this.hostIdentityVersion;
    const release = this.presentation?.suspendInput();
    try {
      const response = await this.request({ type: 'get_host_tools' });
      this.requireLive();
      if (version !== this.inputVersion || identityVersion !== this.hostIdentityVersion)
        throw new Error('Pi host identity owner changed');
      const tools = record(response.data).tools;
      if (!response.success || !Array.isArray(tools) || !tools.includes('cindy_mcp_list_tools') || !tools.includes('cindy_mcp_call_tool'))
        throw new Error('Pi native MCP gateways are unavailable');
      apply();
    } finally { release?.(); }
  }
  async forkHistory(entryId: string, target: (nativeId: string) => Promise<void>): Promise<string> {
    this.requireLive();
    if (this.historyTarget || this.active || this.gui || this.admitting) throw new Error('Pi history is not idle');
    let observed: string | undefined;
    this.historyTarget = async nativeId => { await target(nativeId); observed = nativeId; };
    try {
      const response = await this.request({ type: 'fork_history', entryId }, { timeoutMs: 30_000 });
      const value = record(response.data);
      if (!response.success || typeof value.sessionFile !== 'string') throw new Error('Pi history outcome is unconfirmed');
      if (value.cancelled === true) { await target(value.sessionFile); observed = value.sessionFile; }
      if (observed !== value.sessionFile) throw new Error('Pi replacement target was not checkpointed');
      return value.sessionFile;
    } finally { this.historyTarget = undefined; }
  }
  get isClosed(): boolean { return this.closed || this.faulted; }
  /** Captured before teardown; a pre-agent_start admission still owns work. */
  get exitedCleanlyWhileIdle(): boolean { return this.cleanIdleExit; }
  private requireLive(): void { if (this.isClosed || this.lifetime.signal.aborted) throw new TurnDispatchRejectedError('Pi native session is not active'); }
  private currentInput(): ActiveInput | undefined { return this.active; }
  private publish(frame: Record<string, unknown>): void {
    if (typeof frame.type !== 'string') throw new Error('Invalid Pi native event');
    this.options.onEvent({ ...frame, type: frame.type });
    if (frame.type === 'agent_settled') { this.active = undefined; this.earlyStart = undefined; }
  }
  private fail(): void {
    if (this.closed || this.faulted) return;
    this.faulted = true; this.readyReject(new Error('Pi native task connection interrupted'));
    this.options.onDisconnect?.('stdout-error');
  }

  private async admit(value: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    this.requireLive();
    const row = record(value.row), message = record(row.message), rowId = row.id;
    const root = this.active;
    const steering = Boolean(root);
    const custom = row.type === 'custom_message' && ['lex-gui-append', 'lex-orca-body'].includes(String(row.customType));
    if (this.admitting || root?.cancelled || value.turnRowId !== root?.rowId || (!custom && (row.type !== 'message' || message.role !== 'user')) ||
        typeof rowId !== 'string' || !rowId || rowId.length > 256 || this.rows.has(rowId))
      throw new Error('Pi input has no unique current journal row');
    this.admitting = true; this.rows.add(rowId);
    const version = this.inputVersion;
    try {
      const gui = this.gui;
      if (value.commandId !== undefined) {
        // GUI append identity lives in the original custom journal row. Neither
        // a command echo nor an unrelated ordinary user row proves consumption.
        if (!gui || gui.commandId !== value.commandId || gui.accepted || gui.options.signal?.aborted
            || gui.version !== version || gui.turnRowId !== root?.rowId)
          throw new TurnDispatchRejectedError('Pi GUI journal association changed');
        this.assertDelegatedInputCurrent(gui);
        if (!custom || row.customType !== (gui.options[ORCA_NATIVE_BODY] ? 'lex-orca-body' : 'lex-gui-append')
            || record(row.details).submissionId !== gui.options.messageUuid) return { accepted: false };
        const source = this.source(rowId, gui.options.messageUuid);
        this.active ??= { rowId, owner: this.resolver }; gui.accepted = true;
        try { await gui.options.onNativeUserMessage?.(source); }
        catch { this.options.logger.warn('Pi native journal receipt could not be persisted'); }
        this.requireLive();
        this.assertDelegatedInputCurrent(gui);
        if (signal.aborted || version !== this.inputVersion || gui.options.signal?.aborted || this.gui !== gui || this.active?.cancelled) throw new TurnDispatchRejectedError('Pi GUI owner changed');
        if (this.earlyStart) { this.publish(this.earlyStart); this.earlyStart = undefined; }
        return { accepted: true };
      }
      const owner = this.resolver, prepare = this.prepareInput;
      if (!owner || !prepare || custom || (gui && !root)) throw new TurnDispatchRejectedError('Pi native input has no product owner');
      const content = await this.importContent(rowId, message.content, signal);
      let prepared: PreparedPrompt | undefined;
      await owner({ nativeSessionId: this.nativeId!, nativeMessageId: rowId, source: this.source(rowId), signal,
        ...(root ? { nativeTurnId: root.rowId } : {}),
        message: { type: 'user', content },
        accept: async (input, options, ownership) => {
          this.requireLive();
          if (prepared || version !== this.inputVersion || owner !== this.resolver || signal.aborted || options.signal?.aborted)
            throw new TurnDispatchRejectedError('Pi native input owner changed');
          const candidate = await prepare(input, options, steering);
          this.requireLive();
          if (version !== this.inputVersion || owner !== this.resolver || signal.aborted || options.signal?.aborted
              || (ownership && !ownership.isCurrent())) throw new TurnDispatchRejectedError('Pi native input was cancelled during preparation');
          prepared = candidate;
          this.active ??= { rowId, owner, ownership };
          if (this.earlyStart) { this.publish(this.earlyStart); this.earlyStart = undefined; }
        },
      });
      this.requireLive();
      // The awaited resolver can admit, cancel or settle this input. Read the
      // current state rather than retaining the pre-callback idle narrowing.
      const active = this.currentInput();
      if (!prepared || !active || active.rowId !== (root?.rowId ?? rowId) || active.owner !== owner || active.cancelled
          || signal.aborted || version !== this.inputVersion || owner !== this.resolver
          || (active.ownership && !active.ownership.isCurrent()))
        throw new TurnDispatchRejectedError('Pi native input was not admitted');
      return { accepted: true, ...prepared };
    } catch {
      // This request already names a durable journal row. Keep an unconfirmed
      // association unknown; only a pre-dispatch/confirmed-retirement receipt
      // below may mark GUI input definitively unconsumed.
      return { accepted: false };
    } finally { this.admitting = false; }
  }
  private source(rowId: string, submission?: string): NativeMessageSource {
    return { version: 1, engine: 'pi', sessionId: this.nativeId!, messageId: rowId,
      origin: submission ? { kind: 'plugin', name: 'lex-pi-native-bridge' } : { kind: 'native' },
      ...(submission ? { bridge: { sessionId: this.nativeId!, messageId: rowId, submissionId: submission, pluginName: 'lex-pi-native-bridge' } } : {}),
    };
  }
  private assertDelegatedInputCurrent(input: GuiInput): void {
    const source = input.options[ORCA_NATIVE_BODY];
    if (!source) return;
    if (source.targetSessionId !== this.options.sessionId || source.clientId !== input.options.messageUuid
        || input.hostIdentityVersion !== this.hostIdentityVersion || input.turnRowId
        || this.options.isDelegatedInputCurrent?.(source) !== true)
      throw new TurnDispatchRejectedError('Pi delegated input no longer belongs to this collaboration identity');
  }
  private async importContent(rowId: string, value: unknown, signal: AbortSignal): Promise<UserMessage['content']> {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) throw new Error('Invalid Pi native user content');
    const content: UserContentBlock[] = [];
    for (const [index, block] of value.entries()) {
      const part = record(block);
      if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
      else if (part.type === 'image' && this.importMedia) content.push(await this.importMedia({ sessionId: this.nativeId!, messageId: rowId, index, block, signal }));
      else throw new Error('Pi native media has no product importer');
    }
    return content;
  }

  async request(command: Record<string, unknown>, options: Parameters<PiRpcProcess['request']>[1] = {}): Promise<PiRpcResponse> {
    this.requireLive();
    const type = command.type;
    if (typeof type !== 'string') throw new Error('Invalid Pi control operation');
    if (type === 'switch_session') {
      // The original CLI resumed before initialization; this is an identity
      // readback, never a fresh session or an emulated native switch.
      return { type: 'response', command: type, success: typeof command.sessionPath === 'string' && sameFile(command.sessionPath, this.nativeId!) };
    }
    if (type === 'abort') { this.inputVersion++; if (this.active) this.active.cancelled = true; }
    if (type === 'prompt' || type === 'steer') {
      const gui = this.gui;
      if (!gui || gui.commandId !== undefined || typeof command.message !== 'string')
        return { type: 'response', command: type, success: false, error: 'Use the original Pi terminal for native extension commands.' };
      if (type === 'prompt' && gui.options[GUI_NATIVE_BODY] !== true && !gui.options[ORCA_NATIVE_BODY])
        throw new TurnDispatchRejectedError('Pi native body requires a trusted local GUI or Orca origin');
      this.assertDelegatedInputCurrent(gui);
      if (gui.version !== this.inputVersion || gui.options.signal?.aborted || this.active?.cancelled
          || gui.turnRowId !== this.active?.rowId || (type === 'steer') !== Boolean(gui.turnRowId))
        throw new TurnDispatchRejectedError('Pi input changed before dispatch');
      const pending = this.bridge.enqueueCommand(type, { text: command.message, images: command.images,
        ...(gui.turnRowId ? { turnRowId: gui.turnRowId } : {}),
        ...(gui.options[ORCA_NATIVE_BODY] ? { delegated: true } : {}),
        submissionId: gui.options.messageUuid }, options.timeoutMs ?? 120_000);
      gui.commandId = pending.id; gui.text = command.message;
      try {
        const result = record(await pending.result);
        if (result.cancelledBeforeConsumption === true && !gui.accepted) {
          // Pi abort does not clear its native steering queue. The extension
          // fences further provider requests; confirm this owned process exited
          // before treating its unconsumed input as a definitive refusal.
          await this.close(); gui.refused = true;
        }
        if (!gui.accepted && (result.refusedBeforeSubmission === true || gui.refused)) return { type: 'response', command: type, success: false, error: 'Pi input refused before execution' };
        if (!gui.accepted) throw new TurnDispatchUnconfirmedError('Pi native input execution outcome is unknown');
        return { type: 'response', command: type, success: true };
      } catch (error) {
        if (gui.accepted) return { type: 'response', command: type, success: true };
        if (gui.refused) return { type: 'response', command: type, success: false, error: 'Pi input refused before execution' };
        this.fail(); throw error;
      }
    }
    const result = record(await this.bridge.command('control', command, options.timeoutMs ?? 30_000));
    return { type: 'response', command: type, success: result.ok === true,
      ...(result.ok === true ? { data: result.data } : { error: 'This action is available in the original Pi terminal.' }) };
  }
  send(frame: Record<string, unknown>): void {
    if (frame.type === 'extension_ui_response' && typeof frame.id === 'string') this.uiResponses.get(frame.id)?.(frame);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.lifetime.abort(); this.readyReject(new Error('Pi native session closed'));
    const attempt = (async () => {
      await this.bridge.close();
      if (this.presentation && !this.presentationClosed) {
        this.presentationClosed = true;
        await this.presentation.close();
      } else await this.terminal?.close();
    })();
    this.closing = attempt;
    void attempt.catch(() => { if (this.closing === attempt) this.closing = undefined; });
    return attempt;
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sameFile(a: string, b: string): boolean {
  const key = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  return key(a) === key(b);
}
