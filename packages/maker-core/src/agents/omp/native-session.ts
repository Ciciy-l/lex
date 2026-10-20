import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeMessageSource } from '@cindy/maker-shared/message-presentation';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type AgentSessionHandle, type SendOptions } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeInputOwnership } from '../native-input.js';
import { AgentPresentationRuntime, type AgentTerminalDriver } from '../presentation.js';
import type { AgentEvent, InteractionResolver } from '../../types/events.js';
import type { Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { Logger } from '../../interfaces/logger.js';
import type { OmpHostToolDefinition, OmpHostToolResult } from '../../interfaces/mcp-provider.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { NativeSessionBridge, type NativeBridgeRequest } from '../shared/native-session-bridge.js';
import { OmpHostToolBridge } from './host-tools.js';
import { OmpTranslator } from './translator.js';
import { toOmpPromptText } from './session-handle.js';
import type { OmpSessionLaunchPlan } from './launch-plan.js';

/** Host-only launch injection; never accepted over an IPC request. */
export interface OmpLocalNativeSessionOptions {
  sessionId: string;
  model: string;
  providerId: string;
  permissionMode: PermissionMode;
  effort?: Effort;
  resumeSessionId?: string;
  executable: string;
  plan: OmpSessionLaunchPlan;
  hostTools: readonly OmpHostToolDefinition[];
  disabledSkillPaths?: readonly string[];
  logger: Logger;
  registerProcess?(pid: number): void | (() => void);
  /** Called only after native exit is confirmed. */
  releaseResources(): Promise<void>;
}

export interface OmpNativeTerminalOptions extends OmpLocalNativeSessionOptions {
  launch(environment: Record<string, string>, tools: ReturnType<OmpHostToolBridge['definitions']>): Promise<AgentTerminalDriver>;
}

type GuiInput = { commandId: number; text: string; options: SendOptions; accepted: boolean; refused: boolean; messageId: string };
/** A prepared submission is distinct from the journal ID allocated later by OMP. */
type NativeInput = { submissionId: string; fingerprint: string; cancelled?: boolean;
  gui?: GuiInput; owner?: AgentNativeInputResolver; ownership?: AgentNativeInputOwnership; receipt?: SendOptions['onNativeUserMessage'] };
const levels: Record<Effort, string> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh', ultra: 'xhigh' };

/** One original interactive OMP + official extension, with Core as the only product writer. */
export async function createOmpNativeSession(options: OmpNativeTerminalOptions): Promise<AgentSessionHandle> {
  const events = createAsyncQueue<AgentEvent>(), lifetime = new AbortController();
  const translator = new OmpTranslator({ logger: options.logger });
  let terminal: AgentTerminalDriver | undefined, presentation: AgentPresentationRuntime | undefined;
  let resolver: AgentNativeInputResolver | undefined, interactions: InteractionResolver | undefined;
  let nativeId: string | undefined, gui: GuiInput | undefined, activeRow: string | undefined;
  let activeInput: NativeInput | undefined;
  let closed = false, faulted = false, closing: Promise<void> | undefined, admitting = false;
  let effort: Effort | null = options.effort ?? null;
  let earlyStart: Record<string, unknown> | undefined;
  const admittedRows = new Set<string>(), admittedSubmissions = new Set<string>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Launch errors can precede the later await; observe without swallowing it.
  void ready.catch(() => {});
  const toolResults = new Map<string, (value: OmpHostToolResult) => void>();
  const tools = new OmpHostToolBridge(options.hostTools, { logger: options.logger, respond(id, value) { toolResults.get(id)?.(value); } });
  const requireLive = () => {
    if (closed || faulted || lifetime.signal.aborted) throw new TurnDispatchRejectedError('Native OMP session is not active');
  };
  const publish = (frame: Readonly<Record<string, unknown>>) => {
    const translated = translator.translate(frame);
    if (translated.kind !== 'events') return;
    for (const event of translated.events) {
      if (event.type === 'done') { activeRow = undefined; activeInput = undefined; earlyStart = undefined; }
      events.push(event);
    }
  };
  const fail = () => {
    if (closed || faulted) return;
    faulted = true; readyReject(new Error('OMP native task connection interrupted'));
    events.push({ type: 'error', source: 'omp', data: { message: 'OMP 原生会话连接已中断。执行结果未知，请重新打开此任务后继续。', isTerminal: true, reason: 'omp-native-disconnected' } });
    events.end();
    void close().catch(() => options.logger.warn('OMP native exit could not be confirmed'));
  };
  const bridge = new NativeSessionBridge({ sessionId: options.sessionId, environmentPrefix: 'LEX_OMP_BRIDGE', onFault: fail,
    onEvent(event) {
      if (closed || faulted) return;
      const value = record(event.value);
      if (event.kind === 'ready') {
        const file = value.sessionFile;
        if (nativeId || typeof file !== 'string' || !path.isAbsolute(file) ||
          (options.resumeSessionId && !sameFile(file, options.resumeSessionId)) || value.model !== options.model) { fail(); return; }
        nativeId = file;
        if (typeof value.contextWindow === 'number') translator.setContextWindow(value.contextWindow);
        readyResolve();
      } else if (event.kind === 'agent-event') {
        if (!nativeId || value.sessionFile !== nativeId) { fail(); return; }
        const frame = record(value.event);
        // agent_start precedes persistence/admission. No status/output may
        // reach Session until the real native input has its product reservation.
        if (frame.type === 'agent_start' && !activeInput) { earlyStart = frame; return; }
        if (activeInput) publish(frame.type === 'agent_end' ? { ...frame, isTerminal: frame.willContinue !== true } : frame);
        else if (frame.type === 'agent_end') earlyStart = undefined;
      }
    },
    async onRequest(request, signal) {
      requireLive();
      const value = record(request.input);
      if (request.kind === 'native-fault') {
        if (!nativeId || value.sessionFile !== nativeId) throw new Error('OMP diagnostic belongs to another session');
        const phase = typeof value.phase === 'string' && ['input-association', 'gui-input-association',
          'input-admission-refused', 'provider-without-input', 'journal-receipt-unavailable'].includes(value.phase) ? value.phase : 'transport';
        options.logger.warn('OMP native bridge interrupted', { phase }); fail(); return { reported: true };
      }
      if (request.kind === 'prepare-input') return prepare(value, signal);
      if (request.kind === 'input-receipt') return receipt(value, signal);
      if (!nativeId || value.sessionFile !== nativeId || !activeRow || (activeInput?.ownership && !activeInput.ownership.isCurrent()))
        throw new Error('OMP request has no current task input');
      if (request.kind === 'tool-policy') {
        const current = interactions;
        if (!current || typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string' || !value.input || typeof value.input !== 'object') return { allowed: false };
        const decision = await current({ kind: 'permission', requestId: 'omp-native:' + request.requestId, toolName: value.toolName,
          input: record(value.input), metadata: { source: 'omp', toolCallId: value.toolCallId } });
        return { allowed: !signal.aborted && !closed && current === interactions && decision.kind === 'permission' && decision.behavior === 'allow' };
      }
      if (request.kind === 'host-tool') return hostTool(request, signal);
      throw new Error('Unknown OMP native task request');
    },
  });

  async function prepare(value: Record<string, unknown>, requestSignal: AbortSignal): Promise<unknown> {
    requireLive();
    if (!nativeId || value.sessionFile !== nativeId || activeInput || admitting) throw new Error('OMP native admission is not current');
    const message = record(value.message), submissionId = value.submissionId;
    if (typeof submissionId !== 'string' || !submissionId || submissionId.length > 256 || message.role !== 'user'
      || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)
      || admittedSubmissions.has(submissionId) || admittedSubmissions.size >= 4096) throw new Error('OMP input has no new submission identity');
    const text = nativeText(message.content);
    const fingerprint = nativeFingerprint(message);
    admittedSubmissions.add(submissionId);
    admitting = true;
    const signal = AbortSignal.any([lifetime.signal, requestSignal]);
    try {
      if (value.commandId !== undefined) {
        const pending = gui;
        if (!pending || pending.commandId !== value.commandId || pending.accepted || pending.text !== text || pending.options.signal?.aborted || signal.aborted) throw new Error('OMP GUI input association changed');
        pending.accepted = true;
        activeInput = { submissionId, fingerprint,
          gui: pending, receipt: pending.options.onNativeUserMessage };
        if (earlyStart) { publish(earlyStart); earlyStart = undefined; }
        return { accepted: true, text };
      }
      const current = resolver;
      if (!current || gui) throw new Error('OMP native input has no product owner');
      let prepared: string | undefined;
      await current({ nativeSessionId: nativeId, submissionId, signal,
        message: { type: 'user', content: text },
        async accept(input, sendOptions, ownership) {
          requireLive();
          if (prepared !== undefined || current !== resolver || signal.aborted || sendOptions.signal?.aborted) throw new TurnDispatchRejectedError('OMP input owner changed');
          prepared = toOmpPromptText(input);
          activeInput = { submissionId, fingerprint, owner: current, ownership,
            receipt: sendOptions.onNativeUserMessage };
          if (earlyStart) { publish(earlyStart); earlyStart = undefined; }
        },
      });
      requireLive();
      if (prepared === undefined || signal.aborted || current !== resolver) throw new TurnDispatchRejectedError('OMP native input was not admitted');
      return { accepted: true, text: prepared };
    } catch {
      if (gui && value.commandId === gui.commandId) gui.refused = true;
      return { accepted: false };
    } finally { admitting = false; }
  }
  async function receipt(value: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    requireLive();
    const input = activeInput, row = record(value.row), message = record(row.message), rowId = row.id;
    if (!nativeId || value.sessionFile !== nativeId || !input || input.submissionId !== value.submissionId
      || input.cancelled || input.gui?.options.signal?.aborted || signal.aborted || (input.owner && input.owner !== resolver) || activeRow
      || (input.ownership && !input.ownership.isCurrent())
      || row.type !== 'message' || typeof rowId !== 'string' || !rowId || rowId.length > 256
      || message.role !== 'user' || nativeFingerprint(message) !== input.fingerprint
      || admittedRows.has(rowId) || admittedRows.size >= 4096) throw new Error('OMP journal receipt does not match its prepared input');
    activeRow = rowId; admittedRows.add(rowId);
    const submission = input.gui?.messageId;
    const source: NativeMessageSource = { version: 1, engine: 'omp', sessionId: nativeId, messageId: rowId,
      origin: submission ? { kind: 'plugin', name: 'lex-omp-native-bridge' } : { kind: 'native' },
      ...(submission ? { bridge: { sessionId: nativeId, messageId: rowId, submissionId: submission, pluginName: 'lex-omp-native-bridge' } } : {}),
    };
    try { await input.receipt?.(source); }
    catch { options.logger.warn('OMP native journal receipt could not be persisted'); }
    requireLive();
    if (signal.aborted || input.cancelled || input.gui?.options.signal?.aborted || activeInput !== input
      || (input.owner && input.owner !== resolver) || (input.ownership && !input.ownership.isCurrent()))
      throw new Error('OMP journal receipt owner changed');
    return { accepted: true };
  }
  function hostTool(request: NativeBridgeRequest, signal: AbortSignal): Promise<OmpHostToolResult> {
    const value = record(request.input);
    let rejectCall!: (error: Error) => void;
    const cancel = () => { tools.handleFrame({ type: 'host_tool_cancel', targetId: request.requestId }); rejectCall(new Error('OMP host tool cancelled')); };
    return new Promise<OmpHostToolResult>((resolve, reject) => {
      rejectCall = reject;
      if (signal.aborted) { reject(new Error('OMP host tool cancelled')); return; }
      toolResults.set(request.requestId, resolve); signal.addEventListener('abort', cancel, { once: true });
      tools.handleFrame({ type: 'host_tool_call', id: request.requestId, toolCallId: value.toolCallId, toolName: value.toolName, arguments: value.arguments });
    }).finally(() => { toolResults.delete(request.requestId); signal.removeEventListener('abort', cancel); });
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; lifetime.abort(); tools.close(); readyReject(new Error('OMP native session closed'));
    closing = (async () => {
      try { await bridge.close(); await (presentation ? presentation.close() : terminal?.close()); }
      finally { events.end(); }
    })();
    return closing;
  }
  try {
    await bridge.start();
    terminal = await options.launch(bridge.environment(), tools.definitions());
    terminal.onExit(() => { if (!closed) fail(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('OMP native extension did not initialize')), 30_000); })]);
    } finally { clearTimeout(timer); }
    requireLive();
    presentation = new AgentPresentationRuntime(nativeId!, terminal);
    await bridge.command('initialize', { ...(options.resumeSessionId ? { resumeSessionId: nativeId } : {}),
      ...(options.effort ? { effort: levels[options.effort] } : {}) }, 10_000);
    events.push({ type: 'session_id', source: 'omp', data: nativeId! });
  } catch (error) { await close(); throw error; }

  const validate = (sendOptions: SendOptions = {}) => {
    requireLive();
    if (activeInput || gui || sendOptions.signal?.aborted) throw new TurnDispatchRejectedError('Native OMP input is busy or cancelled');
  };
  return {
    id: nativeId!, agentKind: 'omp', model: options.model, presentation, disabledSkillPaths: options.disabledSkillPaths,
    setNativeInputResolver(next) { requireLive(); resolver = next; },
    setInteractionResolver(next) { requireLive(); interactions = next; },
    validateSendOptions: validate,
    async send(message: UserMessage, sendOptions: SendOptions = {}) {
      validate(sendOptions);
      if (admitting) throw new TurnDispatchRejectedError('Native OMP admission is already pending');
      const text = toOmpPromptText(message);
      if (!text || text.length > 1_000_000) throw new TurnDispatchRejectedError('Invalid OMP prompt');
      const command = bridge.enqueueCommand('prompt', { text }, 30_000);
      const input: GuiInput = { commandId: command.id, text, options: sendOptions, accepted: false, refused: false, messageId: sendOptions.messageUuid ?? randomUUID() };
      gui = input;
      try {
        const receipt = record(await command.result);
        if (!input.accepted && receipt.refusedBeforeSubmission === true) throw new TurnDispatchRejectedError('OMP input was busy before submission');
        if (!input.accepted) throw new Error('OMP prompt receipt has no admitted native row');
      }
      catch (error) {
        if (error instanceof TurnDispatchRejectedError) throw error;
        if (input.refused) throw new TurnDispatchRejectedError('OMP refused input before provider execution');
        if (!input.accepted) { fail(); throw new TurnDispatchUnconfirmedError('OMP native input execution outcome is unknown'); }
      } finally { if (gui === input) gui = undefined; }
    },
    async steer() {
      requireLive();
      // A native in-turn steer needs its own consumed-row association. Until
      // that path is available, never turn it into a second ordinary prompt.
      throw new TurnDispatchRejectedError('OMP 原生模式暂不支持从 GUI 插入运行中的输入；请等待完成或停止后发送。');
    },
    async abort() { requireLive(); if (activeInput) activeInput.cancelled = true; await bridge.command('abort', {}, 10_000); },
    // Admission is held before Session reserves the turn. Reporting it as a
    // running turn would make Session reject this very native input.
    isTurnRunning: () => Boolean(gui || activeInput),
    requiresModelSwitchRebuild: (model, selection) => model !== options.model ||
      (selection?.providerId != null && selection.providerId !== options.providerId),
    async setModel(model, selection) {
      requireLive();
      if (model !== options.model || (selection?.providerId != null && selection.providerId !== options.providerId))
        throw new TurnDispatchRejectedError('OMP model/source changes require the existing managed route rebuild');
      if (selection?.effort) { await bridge.command('effort', { level: levels[selection.effort] }, 10_000); effort = selection.effort; }
    },
    async setEffort(next) { requireLive(); await bridge.command('effort', { level: levels[next] }, 10_000); effort = next; },
    getEffort: () => effort,
    async setPermissionMode(mode) {
      requireLive();
      if (mode !== options.permissionMode) throw new Error('OMP 原生权限档位在启动时确定；请空闲后重新打开此任务再更改。');
    },
    events: () => events, getUsageSnapshot: () => translator.getUsageSnapshot(), close,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
function nativeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(part => record(part).type !== 'text' || typeof record(part).text !== 'string')) throw new Error('OMP native input media is not supported by this route');
  return value.map(part => record(part).text as string).join('');
}
function nativeFingerprint(message: Record<string, unknown>): string {
  return JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content });
}
function sameFile(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return path.isAbsolute(right) && normalize(left) === normalize(right);
}
