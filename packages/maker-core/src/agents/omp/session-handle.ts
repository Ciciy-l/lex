import path from 'node:path';
import os from 'node:os';
import type {
  AgentSessionHandle,
  AgentSessionTeardownOptions,
  SendOptions,
} from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentKind, Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentRuntimeCommandCatalogSnapshot } from '../../types/palette.js';
import type {
  AgentEvent,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import type { ManualCompactResult } from '../../types/capabilities.js';
import type { ContextUsageData } from '../../types/context-usage.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import type { OmpProcessHost } from './process-host.js';
import { resolveOmpApprovalMode, type OmpApprovalMode } from './permission-map.js';
import { OmpPermissionBridge } from './permission-bridge.js';
import { OmpHostToolBridge } from './host-tools.js';
import { OmpTranslator } from './translator.js';
import {
  OmpCommandCatalog,
  readOmpCommandCatalogPayload,
} from './commands.js';

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
  /** Lex's selected upstream source, retained for session-level bookkeeping. */
  readonly providerId: string;
  /** Provider id visible inside OMP's managed models.yml (`cindy` in Desktop). */
  readonly ompProviderId?: string;
  readonly workingDir: string;
  /** Host-owned review sessions stay fixed at their strict startup mode. */
  readonly reviewMode?: boolean;
  /** Canonical local Skill identities frozen when this native runtime starts. */
  readonly disabledSkillPaths?: readonly string[];
  /**
   * Session-owned mutable object captured by the registered OMP host-tool
   * handlers. It is deliberately always present, including ordinary sessions
   * that have not entered an Orca team yet.
   */
  readonly vendorOptions: Record<string, unknown>;
  /** Optional narrow host-tool bridge for host-owned Orca Lead/Worker controls. */
  /**
   * The initially bootstrapped native runtime. Its transport can be replaced
   * in-place when OMP needs a process restart to apply a startup-only setting.
   */
  readonly runtime: OmpSessionRuntime;
  /**
   * Build a fully resumed replacement runtime for a new permission mode. The
   * handle owns shutdown and only activates the returned transport after its
   * session-file identity has been verified.
   */
  readonly restartRuntime?: OmpPermissionRuntimeFactory;
  readonly logger: Logger;
  readonly onClosed?: () => void;
}

/** Event routes installed only after a freshly spawned runtime is safe to use. */
export interface OmpSessionRuntimeCallbacks {
  readonly onFrame: (frame: Readonly<Record<string, unknown>>) => void;
  readonly onProcessExit: (state: string) => void;
  readonly emit: (event: AgentEvent) => void;
}

/**
 * All process-bound OMP state. Session identity, model source, Orca context
 * and final cleanup remain owned by the outer handle so a restart cannot turn
 * into a new Lex session.
 */
export interface OmpSessionRuntime {
  readonly sessionFile: string;
  readonly permissionMode: PermissionMode;
  readonly approvalMode: OmpApprovalMode;
  readonly host: OmpProcessHost;
  readonly translator: OmpTranslator;
  readonly bridge: OmpPermissionBridge;
  readonly hostTools?: OmpHostToolBridge;
  readonly commandCatalog?: OmpCommandCatalog;
  /** Flush startup frames only after the outer handle has made this runtime current. */
  readonly activate?: (callbacks: OmpSessionRuntimeCallbacks) => void;
  /**
   * Reclaim this process-bound runtime exactly once.  The outer handle keeps
   * the product session alive while a permission-mode restart swaps this
   * object, so runtime-local files, host tools and the process itself must not
   * escape that swap.
   */
  /** Stops the owned tree and reports whether the exit was confirmed. */
  readonly stopAndDispose: () => Promise<boolean>;
}

export interface OmpPermissionRuntimeFactoryInput {
  readonly permissionMode: PermissionMode;
  /** The existing upstream JSONL session must be resumed exactly, never replaced. */
  readonly sessionFile: string;
}

export type OmpPermissionRuntimeFactory = (
  input: OmpPermissionRuntimeFactoryInput,
) => Promise<OmpSessionRuntime>;

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
  readonly disabledSkillPaths?: readonly string[];
  private sessionFile: string;
  /** The only runtime allowed to emit into this product session. */
  private runtime: OmpSessionRuntime;
  private mutableModel: string;
  private mutableProviderId: string;
  private mutableEffort: Effort | null = null;
  private closed = false;
  private activePromptId: string | undefined;
  private lifecycleFinished = false;
  private readonly queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
  private readonly runtimeCommandCatalogListeners = new Set<
    (snapshot: AgentRuntimeCommandCatalogSnapshot | undefined) => void
  >();
  private disposeCatalogSubscription: (() => void) | undefined;
  private commandCatalogProjection:
    | { revision: number; snapshot: AgentRuntimeCommandCatalogSnapshot }
    | undefined;
  /** Serializes startup-only permission changes without blocking later retries. */
  private permissionChangeChain: Promise<void> = Promise.resolve();
  private restarting = false;
  /** A deliberate retire must not be mistaken for an unexpected session death. */
  private retiringRuntime: OmpSessionRuntime | undefined;
  private interactionResolver: InteractionResolver | undefined;

  constructor(private readonly options: OmpSessionHandleOptions) {
    this.runtime = options.runtime;
    this.sessionFile = options.runtime.sessionFile || options.sessionId;
    this.mutableModel = options.model;
    this.mutableProviderId = options.providerId;
    this.disabledSkillPaths = options.disabledSkillPaths;
    this.activateRuntime(options.runtime);
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
    return this.runtime.approvalMode;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  getUsageSnapshot(): UsageSnapshot {
    return this.runtime.translator.getUsageSnapshot();
  }

  /**
   * OMP exposes its effective window and accumulated native usage through the
   * event translator, rather than a Claude-shaped detail RPC.  Project only
   * those facts into the shared /context card; do not invent a tool, MCP, or
   * system-prompt breakdown that OMP did not report.
   */
  async getContextUsage(): Promise<ContextUsageData> {
    this.assertRuntimeAvailable();
    const usage = this.getUsageSnapshot();
    const totalTokens = usage.contextTokens;
    const maxTokens = usage.contextWindow;
    const percentage = maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0;
    return {
      categories: [{ name: 'Messages', tokens: totalTokens, color: '#8b8b8b' }],
      totalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage,
      gridRows: [],
      model: this.mutableModel,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    };
  }

  /**
   * Project the exact OMP process' native catalog onto the engine-neutral
   * palette contract. This intentionally omits OMP-only source metadata: the
   * renderer only needs a command name/description to present and forward it.
   */
  getRuntimeCommandCatalog(): AgentRuntimeCommandCatalogSnapshot | undefined {
    if (this.closed || this.runtime === this.retiringRuntime) return undefined;
    const catalog = this.runtime.commandCatalog;
    if (!catalog) return undefined;
    const revision = catalog.getRevision();
    if (this.commandCatalogProjection?.revision === revision) {
      return this.commandCatalogProjection.snapshot;
    }
    const source = catalog.getSnapshot();
    const snapshot: AgentRuntimeCommandCatalogSnapshot = Object.freeze({
      revision,
      status: source.status,
      commands: Object.freeze(
        source.commands.map((command) =>
          Object.freeze({
            kind: 'agent-builtin' as const,
            name: command.name,
            description: command.description ?? `OMP ${command.source} command`,
          }),
        ),
      ),
    });
    this.commandCatalogProjection = { revision, snapshot };
    return snapshot;
  }

  /**
   * OMP can announce its catalog before or after the session reaches ready.
   * Replay the current state to late subscribers and keep the subscription
   * bounded to this handle's lifecycle, matching the existing Pi runtime
   * capability subscription semantics.
   */
  onRuntimeCommandCatalogChange(
    listener: (snapshot: AgentRuntimeCommandCatalogSnapshot | undefined) => void,
  ): () => void {
    if (this.closed) {
      notifyRuntimeCommandCatalogListener(listener, undefined);
      return () => undefined;
    }
    this.runtimeCommandCatalogListeners.add(listener);
    const catalog = this.runtime.commandCatalog;
    if (!catalog) {
      notifyRuntimeCommandCatalogListener(listener, undefined);
      return () => this.runtimeCommandCatalogListeners.delete(listener);
    }
    if (!this.disposeCatalogSubscription) {
      const runtime = this.runtime;
      this.disposeCatalogSubscription = catalog.subscribe(() => {
        if (runtime === this.runtime && runtime !== this.retiringRuntime) {
          this.publishRuntimeCommandCatalog();
        }
      });
    } else {
      notifyRuntimeCommandCatalogListener(listener, this.getRuntimeCommandCatalog());
    }
    return () => this.runtimeCommandCatalogListeners.delete(listener);
  }

  setInteractionResolver(resolver: InteractionResolver): void {
    this.interactionResolver = resolver;
    this.runtime.bridge.setResolver(resolver);
  }

  isTurnRunning(): boolean {
    return !this.restarting && this.runtime.translator.isStreaming();
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
    this.closed = true;
    const runtime = this.runtime;
    runtime.bridge.dismissAll(`process_exited:${state}`);
    this.finishLifecycle();
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
    void runtime.stopAndDispose().catch((error: unknown) => {
      this.options.logger.warn('omp exited runtime cleanup failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 进程帧入口（`startOmpProcess` 的 `onEvent` 回调）。 */
  dispatchFrame(frame: Readonly<Record<string, unknown>>): void {
    this.dispatchRuntimeFrame(this.runtime, frame);
  }

  private dispatchRuntimeFrame(
    runtime: OmpSessionRuntime,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    if (this.closed || runtime !== this.runtime || runtime === this.retiringRuntime) return;
    // Host tools are a dedicated RPC side-channel, not renderer events or OMP
    // extension UI. Consume them before translation so a malformed/unknown tool
    // call cannot accidentally become a UI interaction.
    if (runtime.hostTools?.handleFrame(frame)) return;
    if (frame.type === 'available_commands_update') {
      this.updateCommandCatalog(runtime, frame);
      return;
    }
    const translation = runtime.translator.translate(frame);
    if (translation.kind === 'ui-request') {
      runtime.bridge.handleRequest(translation.request);
      return;
    }
    if (translation.kind === 'ignored') return;
    for (const event of translation.events) this.pushEvent(event);
  }

  /**
   * Command metadata is advisory UI state, never a reason to terminate an
   * otherwise usable conversation.  A malformed native update revokes the
   * stale palette snapshot atomically and leaves prompt/stream transport live.
   */
  private updateCommandCatalog(
    runtime: OmpSessionRuntime,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    if (runtime !== this.runtime || runtime === this.retiringRuntime) return;
    const catalog = runtime.commandCatalog;
    if (!catalog) return;
    try {
      catalog.replace(readOmpCommandCatalogPayload(frame));
    } catch {
      catalog.invalidate('failed');
      this.options.logger.warn('omp native command catalog update was rejected');
    }
  }

  async send(message: UserMessage, opts?: SendOptions): Promise<void> {
    this.assertRuntimeAvailable();
    if (opts?.signal?.aborted === true) throw new Error('OMP send was cancelled');
    const text = toOmpPromptText(message);
    if (!text || text.length > MAX_MESSAGE_LENGTH)
      throw new Error('Invalid OMP prompt message');
    const runtime = this.runtime;
    try {
      const { id, response } = runtime.host.client.request(
        { type: 'prompt', message: text },
        PROMPT_ACCEPT_TIMEOUT_MS,
      );
      this.activePromptId = id;
      await response;
    } catch (error) {
      if (this.activePromptId !== undefined) {
        runtime.host.client.releasePrompt(this.activePromptId);
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
    this.assertRuntimeAvailable();
    if (opts?.signal?.aborted === true) throw new Error('OMP steer was cancelled');
    const text = toOmpPromptText(message);
    if (!text || text.length > MAX_MESSAGE_LENGTH)
      throw new Error('Invalid OMP prompt message');
    const runtime = this.runtime;
    try {
      const { response } = runtime.host.client.request(
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
    if (this.closed || this.restarting) return;
    // 先把挂起的权限卡 fail-closed 收掉：用户按了 Stop，等它的调用不能再悬着。
    this.runtime.bridge.dismissAll('turn_aborted');
    await this.requestAbort('abort');
  }

  /** 只发软中断，不关进程 / 不升级为 kill。 */
  async requestGracefulStop(): Promise<void> {
    this.assertRuntimeAvailable('No active OMP turn to stop');
    await this.requestAbort('graceful-stop');
  }

  async setModel(model: string, opts?: { providerId?: string | null; effort?: Effort }): Promise<void> {
    this.assertRuntimeAvailable();
    if (!model) throw new Error('Invalid OMP model');
    const provider = opts?.providerId === null || opts?.providerId === undefined
      ? this.mutableProviderId
      : opts.providerId;
    const ompProvider = this.options.ompProviderId ?? provider;
    const { response } = this.runtime.host.client.request(
      { type: 'set_model', provider: ompProvider, modelId: model },
      RPC_TIMEOUT_MS,
    );
    await response;
    this.mutableModel = model;
    this.mutableProviderId = provider;
    if (opts?.effort !== undefined) await this.setEffort(opts.effort);
  }

  /**
   * OMP reads its managed models.yml and credentials when the process starts.
   * That file fixes both the selected source-provider header and its wire
   * protocol, so a later model/source change cannot safely be treated as a
   * native hot switch.  Reuse the common session-rebuild path instead: it
   * preserves the product session while starting a fresh OMP process with a
   * matching managed route.
   */
  requiresModelSwitchRebuild(
    model: string,
    opts?: { providerId?: string | null },
  ): boolean {
    const provider = opts?.providerId === null || opts?.providerId === undefined
      ? this.mutableProviderId
      : opts.providerId;
    return model !== this.mutableModel || provider !== this.mutableProviderId;
  }

  async setEffort(effort: Effort): Promise<void> {
    this.assertRuntimeAvailable();
    const { response } = this.runtime.host.client.request(
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
   * OMP's registered host-tool manifest is stable for the lifetime of this
   * process. Like the other native engines, live Orca role/workflow changes
   * therefore update the captured session context in place rather than
   * rebuilding the process or re-registering an unchanged tool list.
   */
  async setVendorOptions(patch: Record<string, unknown>): Promise<void> {
    this.assertRuntimeAvailable();
    Object.assign(this.options.vendorOptions, patch);
    this.options.logger.debug('omp setVendorOptions', {
      patchKeys: Object.keys(patch),
    });
  }

  /**
   * OMP reads approval mode at process startup.  Keep the Lex session and its
   * JSONL identity. The old process is retired and its exit confirmed before
   * a replacement attaches to that file, avoiding concurrent native writers.
   * That gives the same visible mid-session mode semantics as
   * the other harnesses without pretending OMP can hot-apply this setting.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.options.reviewMode === true) {
      this.options.logger.debug('omp setPermissionMode ignored for host-owned hard read-only session', {
        requested: mode,
      });
      return;
    }
    const next = resolveOmpApprovalMode(mode);
    if (!next.matched) throw new Error('Unsupported OMP permission mode');
    const run = this.permissionChangeChain.then(() =>
      this.replaceRuntimeForPermissionMode(mode, next.approvalMode),
    );
    // A failed replacement must not poison a later explicit retry.
    this.permissionChangeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async exportSessionHtml(outputPath?: string): Promise<string> {
    this.assertRuntimeAvailable();
    const target =
      outputPath && outputPath.length > 0 && !outputPath.includes('\0')
        ? outputPath
        : path.join(os.tmpdir(), `omp-session-${safeFilePart(this.id)}.html`);
    const { response } = this.runtime.host.client.request(
      { type: 'export_html', outputPath: target },
      RPC_TIMEOUT_MS,
    );
    await response;
    return target;
  }

  /** OMP 的 `compact` 不接受聚焦指令；有指令时只在日志里留痕，不伪造行为。 */
  async compactSession(instructions?: string): Promise<ManualCompactResult> {
    this.assertRuntimeAvailable();
    if (instructions) {
      this.options.logger.debug('omp compact ignores focus instructions', {
        length: instructions.length,
      });
    }
    const { response } = this.runtime.host.client.request(
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
    const runtime = this.runtime;
    runtime.bridge.dismissAll(`session_closed:${opts?.reason ?? 'navigation'}`);
    this.finishLifecycle();
    try {
      await runtime.stopAndDispose();
    } catch (error) {
      this.options.logger.warn('omp session stop failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.queue.end();
  }

  private finishLifecycle(): void {
    if (this.lifecycleFinished) return;
    this.lifecycleFinished = true;
    this.disposeCatalogSubscription?.();
    this.disposeCatalogSubscription = undefined;
    this.commandCatalogProjection = undefined;
    for (const listener of this.runtimeCommandCatalogListeners) {
      notifyRuntimeCommandCatalogListener(listener, undefined);
    }
    this.runtimeCommandCatalogListeners.clear();
    this.options.onClosed?.();
  }

  private publishRuntimeCommandCatalog(): void {
    if (this.closed) return;
    const snapshot = this.getRuntimeCommandCatalog();
    for (const listener of this.runtimeCommandCatalogListeners) {
      notifyRuntimeCommandCatalogListener(listener, snapshot);
    }
  }

  private async requestAbort(reason: string): Promise<void> {
    const runtime = this.runtime;
    try {
      const { response } = runtime.host.client.request(
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
      this.runtime.host.client.releasePrompt(this.activePromptId);
      this.activePromptId = undefined;
    }
  }

  private assertRuntimeAvailable(message = 'OMP session is closed'): void {
    if (this.closed) throw new Error(message);
    if (this.restarting) throw new Error('OMP session is restarting');
  }

  /** Attach callbacks with an identity fence so retired process events are inert. */
  private activateRuntime(runtime: OmpSessionRuntime): void {
    if (this.interactionResolver !== undefined) {
      runtime.bridge.setResolver(this.interactionResolver);
    }
    runtime.activate?.({
      onFrame: (frame) => this.dispatchRuntimeFrame(runtime, frame),
      onProcessExit: (state) => {
        if (runtime === this.runtime && runtime !== this.retiringRuntime) {
          this.notifyProcessExit(state);
        }
      },
      emit: (event) => {
        if (runtime === this.runtime && runtime !== this.retiringRuntime && !this.closed) {
          this.dispatchEvent(event);
        }
      },
    });
    this.rebindCommandCatalog();
  }

  private rebindCommandCatalog(): void {
    this.disposeCatalogSubscription?.();
    this.disposeCatalogSubscription = undefined;
    this.commandCatalogProjection = undefined;
    const catalog = this.runtime.commandCatalog;
    if (catalog && this.runtimeCommandCatalogListeners.size > 0 && !this.closed) {
      const runtime = this.runtime;
      this.disposeCatalogSubscription = catalog.subscribe(() => {
        if (runtime === this.runtime && runtime !== this.retiringRuntime) {
          this.publishRuntimeCommandCatalog();
        }
      });
    }
    if (this.runtimeCommandCatalogListeners.size > 0 && !this.closed) {
      this.publishRuntimeCommandCatalog();
    }
  }

  private async replaceRuntimeForPermissionMode(
    permissionMode: PermissionMode,
    approvalMode: OmpApprovalMode,
  ): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.runtime.permissionMode === permissionMode) return;
    // Replacing an OMP process during a native turn can lose tool state or
    // leave an action half-applied.  The caller can stop the turn and retry.
    if (this.runtime.translator.isStreaming() || this.activePromptId !== undefined) {
      throw new Error('OMP permission mode can only change while the session is idle');
    }
    const buildReplacement = this.options.restartRuntime;
    if (!buildReplacement) throw new Error('OMP permission-mode restart is unavailable');

    const previous = this.runtime;
    this.restarting = true;
    let replacement: OmpSessionRuntime | undefined;
    this.retiringRuntime = previous;
    try {
      // OMP persists its JSONL while it runs. Starting/switching a second
      // process against the same file races history writes, so never overlap.
      previous.bridge.dismissAll(`permission_mode_changed_to_${permissionMode}`);
      const stopped = await previous.stopAndDispose();
      if (!stopped) {
        throw new Error('OMP runtime exit could not be confirmed before permission-mode restart');
      }
      if (this.closed || this.runtime !== previous) {
        throw new Error('OMP session closed while permission mode was restarting');
      }

      replacement = await buildReplacement({ permissionMode, sessionFile: this.sessionFile });
      if (this.closed || this.runtime !== previous) {
        throw new Error('OMP session closed while permission mode was restarting');
      }
      if (!sameSessionFile(replacement.sessionFile, this.sessionFile)) {
        throw new Error('OMP permission-mode restart resumed a different session');
      }
      if (replacement.approvalMode !== approvalMode || replacement.permissionMode !== permissionMode) {
        throw new Error('OMP permission-mode restart did not apply the requested mode');
      }

      this.runtime = replacement;
      this.activateRuntime(replacement);
      if (this.closed) throw new Error('OMP replacement exited while permission mode was restarting');
    } catch (error) {
      if (replacement !== undefined) {
        await replacement.stopAndDispose().catch(() => undefined);
      }
      // Once the old runtime was asked to retire, we cannot honestly leave this
      // product session live if a replacement was not activated. Fail closed
      // rather than claiming the old permission mode is still usable.
      if (!this.closed) this.failClosedPermissionRestart(error);
      throw error;
    } finally {
      if (this.retiringRuntime === previous) this.retiringRuntime = undefined;
      this.restarting = false;
    }
  }

  private failClosedPermissionRestart(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.finishLifecycle();
    this.activePromptId = undefined;
    this.queue.push({
      type: 'error',
      data: {
        message: 'OMP permission-mode restart failed; reopen the task to continue',
        isTerminal: true,
      },
      source: 'omp',
    });
    this.queue.end();
    this.options.logger.warn('omp permission-mode restart failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function eventIsTerminal(event: AgentEvent): boolean {
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return true;
  return (data as { isTerminal?: unknown }).isTerminal !== false;
}

function notifyRuntimeCommandCatalogListener(
  listener: (snapshot: AgentRuntimeCommandCatalogSnapshot | undefined) => void,
  snapshot: AgentRuntimeCommandCatalogSnapshot | undefined,
): void {
  try {
    listener(snapshot);
  } catch {
    // UI/host catalog observers are advisory and must not interrupt OMP cleanup.
  }
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.slice(-64) || 'session';
}

type SessionFilePathStyle = 'posix' | 'win32';

/**
 * Classify the persisted path itself instead of relying on the host that happens
 * to compare it. A Linux CI process can legitimately exercise a resumed Windows
 * session fixture, while a mixed path style must never be treated as the same
 * logical session.
 */
function sessionFilePathStyle(value: string): SessionFilePathStyle | undefined {
  if (!value || value.includes('\0')) return undefined;
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return 'win32';
  return value.startsWith('/') ? 'posix' : undefined;
}

/** Normalized logical identity; Windows session paths are case-insensitive. */
function sameSessionFile(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftStyle = sessionFilePathStyle(left);
  const rightStyle = sessionFilePathStyle(right);
  if (!leftStyle || leftStyle !== rightStyle) return false;

  if (leftStyle === 'win32') {
    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  }
  return path.posix.normalize(left) === path.posix.normalize(right);
}
