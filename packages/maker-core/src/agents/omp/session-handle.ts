import path from 'node:path';
import os from 'node:os';
import type {
  AgentSessionHandle,
  AgentSessionTeardownOptions,
  SendOptions,
} from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentKind, Effort, UserMessage } from '../../types/common.js';
import type {
  AgentEvent,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import {
  NotSupportedError,
  type ManualCompactResult,
} from '../../types/capabilities.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { isOmpRecord } from './commands.js';
import type { OmpProcessHost } from './process-host.js';
import type { OmpApprovalMode } from './permission-map.js';
import { OmpPermissionBridge } from './permission-bridge.js';
import { OmpTranslator } from './translator.js';

/**
 * OMP 会话句柄。
 *
 * `id` = OMP 会话文件绝对路径（= Lex `sessions.sdkSessionId`，架构 §5）——
 * `switch_session` 只接受 `sessionPath`，不是上游的 `sessionId`。
 *
 * 事件出口只有一个：`events()`。translator 是唯一生产者（交互帧除外，它们走
 * permission-bridge 且不进事件流）。
 */

const PROMPT_ACCEPT_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 1_000_000;

export interface OmpSessionHandleOptions {
  /** OMP 会话文件绝对路径。 */
  readonly sessionId: string;
  readonly model: string;
  readonly providerId: string;
  readonly workingDir: string;
  readonly approvalMode: OmpApprovalMode;
  readonly host: OmpProcessHost;
  readonly translator: OmpTranslator;
  readonly bridge: OmpPermissionBridge;
  readonly logger: Logger;
  readonly onClosed?: () => void;
}

/** `UserMessage` → OMP `prompt` 需要的纯文本（OMP RPC 只有文本通道）。 */
export function toOmpPromptText(message: UserMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'mention') parts.push(`@${block.name} (${block.path})`);
    else parts.push(`[${block.type}: ${block.path}]`);
  }
  return parts.join('\n');
}

const EFFORT_TO_THINKING_LEVEL: Readonly<Record<Effort, string>> = Object.freeze({
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh',
});

export class OmpSessionHandle implements AgentSessionHandle {
  readonly agentKind: AgentKind = 'omp';
  private sessionFile: string;
  private mutableModel: string;
  private mutableProviderId: string;
  private mutableEffort: Effort | null = null;
  private closed = false;
  private activePromptId: string | undefined;
  private readonly queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();

  constructor(private readonly options: OmpSessionHandleOptions) {
    this.sessionFile = options.sessionId;
    this.mutableModel = options.model;
    this.mutableProviderId = options.providerId;
  }

  /** OMP 会话文件绝对路径（= Lex `sessions.sdkSessionId`）。 */
  get id(): string {
    return this.sessionFile;
  }

  get model(): string {
    return this.mutableModel;
  }

  /**
   * 回填真实的会话文件。
   *
   * 句柄要先于 `new_session` / `switch_session` 建好（否则握手前后的帧没人接），
   * 而会话文件要等 `get_state` —— 因此分两步。只接受第一次回填，之后的值必须
   * 稳定（resume 漂移由 OmpAgent 在回填前拦掉）。
   */
  adoptSessionFile(sessionFile: string): void {
    if (this.sessionFile.length === 0 && sessionFile.length > 0) this.sessionFile = sessionFile;
  }

  /** 当前生效的 OMP 静态档位（只读展示用；授权一律走 InteractionResolver）。 */
  get approvalMode(): OmpApprovalMode {
    return this.options.approvalMode;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  getUsageSnapshot(): UsageSnapshot {
    return this.options.translator.getUsageSnapshot();
  }

  setInteractionResolver(resolver: InteractionResolver): void {
    this.options.bridge.setResolver(resolver);
  }

  isTurnRunning(): boolean {
    return this.options.translator.isStreaming();
  }

  /** permission-bridge 的事件出口（只有 `interaction_dismissed` 走这里）。 */
  dispatchEvent(event: AgentEvent): void {
    if (this.closed) return;
    this.queue.push(event);
  }

  /**
   * 进程意外退出时收口事件流（正常关闭走 `close()`）。
   *
   * 没有这一步，OMP 崩溃后 `events()` 永远不会结束，Session 的 run loop 会一直挂着。
   */
  notifyProcessExit(state: string): void {
    if (this.closed) return;
    this.pushEvent({
      type: 'error',
      data: {
        message: 'OMP process exited unexpectedly',
        isTerminal: true,
        reason: `omp:${state}`,
      },
      source: 'omp',
    });
    this.queue.end();
  }

  /** 进程帧入口（`startOmpProcess` 的 `onEvent` 回调）。 */
  dispatchFrame(frame: Readonly<Record<string, unknown>>): void {
    if (this.closed) return;
    const translation = this.options.translator.translate(frame);
    if (translation.kind === 'ui-request') {
      this.options.bridge.handleRequest(translation.request);
      return;
    }
    if (translation.kind === 'ignored') return;
    for (const event of translation.events) this.pushEvent(event);
  }

  async send(message: UserMessage, opts?: SendOptions): Promise<void> {
    if (this.closed) throw new Error('OMP session is closed');
    if (opts?.signal?.aborted === true) throw new Error('OMP send was cancelled');
    const text = toOmpPromptText(message);
    if (!text || text.length > MAX_MESSAGE_LENGTH)
      throw new Error('Invalid OMP prompt message');
    try {
      const { id, response } = this.options.host.client.request(
        { type: 'prompt', message: text },
        PROMPT_ACCEPT_TIMEOUT_MS,
      );
      this.activePromptId = id;
      await response;
    } catch (error) {
      if (this.activePromptId !== undefined) {
        this.options.host.client.releasePrompt(this.activePromptId);
        this.activePromptId = undefined;
      }
      this.emitTerminalError(error, 'send');
      if (opts?.throwOnStartFailure === true) throw error;
    }
  }

  /**
   * 同 turn 插话：走 OMP 的 `steer` 通道，不重置 per-turn 状态（与 send 的差别
   * 见 `AgentSessionHandle.steer` 的契约注释）。
   */
  async steer(message: UserMessage, opts?: SendOptions): Promise<void> {
    if (this.closed) throw new Error('OMP session is closed');
    if (opts?.signal?.aborted === true) throw new Error('OMP steer was cancelled');
    const text = toOmpPromptText(message);
    if (!text || text.length > MAX_MESSAGE_LENGTH)
      throw new Error('Invalid OMP prompt message');
    try {
      const { response } = this.options.host.client.request(
        { type: 'steer', message: text },
        PROMPT_ACCEPT_TIMEOUT_MS,
      );
      await response;
    } catch (error) {
      this.emitTerminalError(error, 'steer');
      if (opts?.throwOnStartFailure === true) throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    // 先把挂起的权限卡 fail-closed 收掉：用户按了 Stop，等它的调用不能再悬着。
    this.options.bridge.dismissAll('turn_aborted');
    await this.requestAbort('abort');
  }

  /** 只发软中断，不关进程 / 不升级为 kill。 */
  async requestGracefulStop(): Promise<void> {
    if (this.closed) throw new Error('No active OMP turn to stop');
    await this.requestAbort('graceful-stop');
  }

  async setModel(model: string, opts?: { providerId?: string | null; effort?: Effort }): Promise<void> {
    if (this.closed) throw new Error('OMP session is closed');
    if (!model) throw new Error('Invalid OMP model');
    const provider = opts?.providerId === null || opts?.providerId === undefined
      ? this.mutableProviderId
      : opts.providerId;
    const { response } = this.options.host.client.request(
      { type: 'set_model', provider, modelId: model },
      RPC_TIMEOUT_MS,
    );
    await response;
    this.mutableModel = model;
    this.mutableProviderId = provider;
    if (opts?.effort !== undefined) await this.setEffort(opts.effort);
  }

  async setEffort(effort: Effort): Promise<void> {
    if (this.closed) throw new Error('OMP session is closed');
    const { response } = this.options.host.client.request(
      { type: 'set_thinking_level', level: EFFORT_TO_THINKING_LEVEL[effort] },
      RPC_TIMEOUT_MS,
    );
    await response;
    this.mutableEffort = effort;
  }

  getEffort(): Effort | null {
    return this.mutableEffort;
  }

  /**
   * OMP 的设置是启动期加载的：`tools.approvalMode` 在进程重启后才生效。
   * P0 不实现"重启续接"（架构 §4.5 留到 T04 与 host 的进程重建一起收口），
   * 这里显式抛 NotSupportedError —— 宁可拒绝，也不假装已生效（fail-closed）。
   */
  async setPermissionMode(): Promise<void> {
    return Promise.reject(
      new NotSupportedError('setPermissionMode', {
        supported: false,
        reason: 'not-implemented',
        message:
          'OMP applies a permission-mode change when the session restarts; switch it before starting a new session.',
      }),
    );
  }

  async exportSessionHtml(outputPath?: string): Promise<string> {
    if (this.closed) throw new Error('OMP session is closed');
    const target =
      outputPath && outputPath.length > 0 && !outputPath.includes('\0')
        ? outputPath
        : path.join(os.tmpdir(), `omp-session-${safeFilePart(this.id)}.html`);
    const { response } = this.options.host.client.request(
      { type: 'export_html', outputPath: target },
      RPC_TIMEOUT_MS,
    );
    await response;
    return target;
  }

  /** OMP 的 `compact` 不接受聚焦指令；有指令时只在日志里留痕，不伪造行为。 */
  async compactSession(instructions?: string): Promise<ManualCompactResult> {
    if (this.closed) throw new Error('OMP session is closed');
    if (instructions) {
      this.options.logger.debug('omp compact ignores focus instructions', {
        length: instructions.length,
      });
    }
    const { response } = this.options.host.client.request(
      { type: 'compact' },
      RPC_TIMEOUT_MS,
    );
    await response;
    return {};
  }

  async close(opts?: AgentSessionTeardownOptions): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 会话都关了，挂起的卡不可能再有人回答 —— 一律 deny。
    this.options.bridge.dismissAll(`session_closed:${opts?.reason ?? 'navigation'}`);
    try {
      await this.options.host.stopAndWait();
    } catch (error) {
      this.options.logger.warn('omp session stop failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.queue.end();
    this.options.onClosed?.();
  }

  private async requestAbort(reason: string): Promise<void> {
    try {
      const { response } = this.options.host.client.request(
        { type: 'abort' },
        RPC_TIMEOUT_MS,
      );
      await response;
    } catch (error) {
      this.options.logger.warn('omp abort request failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitTerminalError(error: unknown, where: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.logger.warn('omp request failed', { where, message });
    this.pushEvent({
      type: 'error',
      data: { message: `OMP ${where} failed: ${message}`, isTerminal: true },
      source: 'omp',
    });
  }

  private pushEvent(event: AgentEvent): void {
    this.queue.push(event);
    // prompt 的"已接受"响应会先到，真正的结束在 agent_end / error。
    // 到这里才释放，rpc-client 才能在迟到的失败响应里认出这个 id。
    if (
      this.activePromptId !== undefined &&
      (event.type === 'done' ||
        (event.type === 'error' && eventIsTerminal(event)))
    ) {
      this.options.host.client.releasePrompt(this.activePromptId);
      this.activePromptId = undefined;
    }
  }
}

function eventIsTerminal(event: AgentEvent): boolean {
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return true;
  return (data as { isTerminal?: unknown }).isTerminal !== false;
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.slice(-64) || 'session';
}
