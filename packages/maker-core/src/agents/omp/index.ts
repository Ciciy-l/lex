import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type StartSessionOptions,
} from '../base-agent.js';
import { NotSupportedError, type Capabilities } from '../../types/capabilities.js';
import type { AgentKind } from '../../types/common.js';
import type { AgentEvent } from '../../types/events.js';
import { isOmpRecord } from './commands.js';
import {
  createOmpSessionLaunchPlan,
  type OmpSessionCredentials,
  type OmpSessionLaunchPlan,
} from './launch-plan.js';
import { OMP_CINDY_PROVIDER_ID } from './models-config.js';
import {
  OMP_PERMISSION_MODES,
  resolveOmpApprovalMode,
  type OmpApprovalMode,
} from './permission-map.js';
import { OmpPermissionBridge } from './permission-bridge.js';
import { startOmpProcess, type OmpProcessHost } from './process-host.js';
import type { OmpProcessState } from './process-lifecycle.js';
import { OmpSessionHandle } from './session-handle.js';
import { OmpTranslator } from './translator.js';

/**
 * OMP Agent —— Lex 的第四个 coding agent（上游 `can1357/oh-my-pi` v18.1.18）。
 *
 * 与另外三个 agent 同构：`OmpAgent extends BaseAgent`，UI 通过统一的
 * `AgentSessionHandle` 消费。范式是「GUI 是壳」：这里只负责 spawn 受管 OMP
 * 进程、用 RPC 对话、把帧投影成 `AgentEvent`。
 *
 * 权限的关键约束（架构 §4.2）：`--approval-mode` 只是递给 OMP 的**节流档位**，
 * 不是授权源。所有交互确认都经 `InteractionResolver`（见 permission-bridge）。
 * OMP 在 `always-ask` 下仍自动放行 read tier（spike §9.3 真机实证）——
 * 没收到审批请求不等于 Lex 授权过。
 */

const READY_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 30_000;
const STARTUP_FRAME_BUFFER = 256;

const REMOTE_UNSUPPORTED = {
  supported: false,
  reason: 'not-implemented',
  message: 'OMP cannot run on a remote host in this version.',
} as const;

export class OmpAgent extends BaseAgent {
  readonly kind: AgentKind = 'omp';
  readonly capabilities: Capabilities;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(OmpAgent.baseCapabilities());
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (opts.remoteHostId) {
      throw new NotSupportedError('omp:remote-session', { ...REMOTE_UNSUPPORTED });
    }
    const providerId = opts.providerId ?? OMP_CINDY_PROVIDER_ID;
    // host 拥有的硬只读会话（Cindy Review）一律按最严档位启动。
    const requestedMode: unknown = opts.reviewMode === true ? 'ask' : opts.permissionMode;
    const approvalMode = resolveOmpApprovalMode(requestedMode);
    if (!approvalMode.matched) {
      this.deps.logger.warn('omp permission mode was not recognized, fell back to always-ask', {
        requested: approvalMode.requested ?? null,
      });
    }

    const plan = createOmpSessionLaunchPlan({
      roots: {
        home: this.resolveAgentHome(),
        workingDir: opts.workingDir,
        platform: process.platform,
        ...(process.env.SystemRoot === undefined
          ? {}
          : { windowsSystemRoot: process.env.SystemRoot }),
      },
      permissionMode: requestedMode,
      model: { provider: providerId, model: opts.model },
      ...(this.resolveCredentials(opts.sessionId, providerId) ?? {}),
    });
    await this.materializeRuntimeFiles(plan, opts.sessionId, providerId, opts.model);

    // 帧出口：握手完成前缓冲，句柄建好后再回放（OMP 会在 `ready` 前后自发发
    // `setWidget`，这些帧必须有人接，否则权限帧可能在没人应答时挂住进程）。
    let frameSink: (frame: Readonly<Record<string, unknown>>) => void = (frame) => {
      if (buffered.length < STARTUP_FRAME_BUFFER) buffered.push(frame);
    };
    const buffered: Readonly<Record<string, unknown>>[] = [];
    let eventSink: ((event: AgentEvent) => void) | undefined;
    let exitSink: ((state: OmpProcessState) => void) | undefined;

    const host = await this.spawnHost(
      plan,
      (frame) => frameSink(frame),
      (state) => exitSink?.(state),
    );
    try {
      const translator = new OmpTranslator({ logger: this.deps.logger });
      const bridge = new OmpPermissionBridge({
        logger: this.deps.logger,
        respond: (id, response, correlation) =>
          host.client.respondToUi(id, response, correlation),
        emit: (event) => eventSink?.(event),
      });
      const handle = new OmpSessionHandle({
        sessionId: opts.resumeSessionId ?? '',
        model: opts.model,
        providerId,
        workingDir: opts.workingDir,
        approvalMode: approvalMode.approvalMode,
        host,
        translator,
        bridge,
        logger: this.deps.logger,
      });
      eventSink = (event) => handle.dispatchEvent(event);
      frameSink = (frame) => handle.dispatchFrame(frame);
      exitSink = (state) => handle.notifyProcessExit(state);
      for (const frame of buffered.splice(0)) frameSink(frame);

      const sessionFile = await this.establishSession(host, opts, translator);
      handle.adoptSessionFile(sessionFile);
      return handle;
    } catch (error) {
      await host.stopAndWait().catch(() => false);
      throw error;
    }
  }

  /**
   * spawn 受管 OMP 进程并等到握手完成。
   *
   * 进程在握手前退出 / 超时 → 停进程并抛错，绝不把半就绪的会话交出去。
   */
  private async spawnHost(
    plan: OmpSessionLaunchPlan,
    onFrame: (frame: Readonly<Record<string, unknown>>) => void,
    onExit: (state: OmpProcessState) => void,
  ): Promise<OmpProcessHost> {
    let settleReady: (() => void) | undefined;
    let failReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      failReady = reject;
    });
    const timer = setTimeout(() => {
      failReady?.(new Error('OMP did not complete its RPC handshake in time'));
    }, READY_TIMEOUT_MS);

    const host = startOmpProcess({
      executablePath: this.deps.binaryPath,
      workingDirectory: plan.roots.workingDir,
      arguments: plan.arguments,
      environment: plan.environment,
      terminateProcessTree: terminateOmpProcessTree,
      onEvent: (frame) => {
        if (frame.type === 'ready') {
          clearTimeout(timer);
          settleReady?.();
        }
        onFrame(frame);
      },
      onState: (state: OmpProcessState) => {
        this.deps.logger.debug('omp process state', { state });
        if (state === 'exited' || state === 'exit-unconfirmed') {
          clearTimeout(timer);
          failReady?.(new Error('OMP process exited before the RPC handshake'));
          onExit(state);
        }
      },
    });

    try {
      await ready;
    } catch (error) {
      clearTimeout(timer);
      await host.stopAndWait().catch(() => false);
      throw error;
    }
    clearTimeout(timer);
    return host;
  }

  /**
   * 新建 / 续接会话，返回会话文件绝对路径（= Lex `sdkSessionId`）。
   *
   * 续接失败**绝不**静默 fresh fallback（架构 §5）：先过 host 的 CAS 回调，
   * 回调说持久化值已被并发更新就直接失败。
   */
  private async establishSession(
    host: OmpProcessHost,
    opts: StartSessionOptions,
    translator: OmpTranslator,
  ): Promise<string> {
    const resume = opts.resumeSessionId;
    let sessionFile: string | undefined;
    if (resume !== undefined && resume.length > 0) {
      try {
        const { response } = host.client.request(
          { type: 'switch_session', sessionPath: resume },
          RPC_TIMEOUT_MS,
        );
        await response;
        sessionFile = await this.readSessionFile(host, translator);
      } catch (error) {
        this.deps.logger.warn('omp resume failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        sessionFile = undefined;
      }
      if (sessionFile === undefined) {
        const mayStartFresh = opts.onInvalidResumeSession
          ? await opts.onInvalidResumeSession(resume)
          : false;
        if (!mayStartFresh) throw new Error('OMP session could not be resumed');
      }
    }
    if (sessionFile === undefined) {
      const { response } = host.client.request({ type: 'new_session' }, RPC_TIMEOUT_MS);
      await response;
      sessionFile = await this.readSessionFile(host, translator);
    }
    if (sessionFile === undefined) throw new Error('OMP did not report a session file');
    return sessionFile;
  }

  private async readSessionFile(
    host: OmpProcessHost,
    translator: OmpTranslator,
  ): Promise<string | undefined> {
    const { response } = host.client.request({ type: 'get_state' }, RPC_TIMEOUT_MS);
    const state = await response;
    const data = state.data;
    if (isOmpRecord(data)) {
      // 上下文窗口只有 get_state 能给；拿不到就维持 0（renderer 有兜底）。
      const window = readContextWindow(data);
      if (window !== undefined) translator.setContextWindow(window);
    }
    return readSessionPath(data);
  }

  private resolveAgentHome(): string {
    const injected = this.deps.resolveOmpAgentHome?.();
    if (injected && injected.trim().length > 0) return injected;
    // 受管根没注入时退到临时目录并告警：会话历史不持久，但不会误读 ~/.omp 或 ~/.pi。
    this.deps.logger.warn('omp agent home was not injected; falling back to a temporary root');
    return path.join(os.tmpdir(), 'cindy-omp-agent-home');
  }

  private resolveCredentials(
    sessionId: string | undefined,
    providerId: string,
  ): { credentials: OmpSessionCredentials } | undefined {
    const credentials = this.deps.resolveOmpCredentials?.({ sessionId, providerId });
    return credentials === undefined ? undefined : { credentials };
  }

  /**
   * 物化受管根内的 settings YAML（本包所有）+ models.yml（内容归 host，
   * 因为 provider/catalog 在 host 侧）。纯文本写入，不含任何密钥 ——
   * 密钥只经子进程 env（spike §10.4）。
   */
  private async materializeRuntimeFiles(
    plan: OmpSessionLaunchPlan,
    sessionId: string | undefined,
    providerId: string,
    model: string,
  ): Promise<void> {
    await fs.mkdir(plan.roots.agent, { recursive: true });
    await fs.mkdir(plan.roots.sessions, { recursive: true });
    await fs.writeFile(plan.roots.settingsFile, plan.settingsYaml, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const modelsYaml = this.deps.resolveOmpModelsYaml?.({ sessionId, providerId, model });
    if (modelsYaml === undefined) {
      this.deps.logger.warn('omp models.yml was not provided; only built-in providers are usable');
      return;
    }
    await fs.writeFile(plan.roots.modelsFile, modelsYaml, { encoding: 'utf8', mode: 0o600 });
  }

  private static baseCapabilities(): Capabilities {
    return {
      switchModel: { supported: true },
      // 模型清单由 host 的 catalog 注入（capabilityAdditions）。
      availableModels: [],
      // OMP 没有 Fast / service tier 概念。
      hasFastMode: false,
      effort: { supported: true },
      // spike §6a：OMP 的 thinking.efforts 是 low/medium/high/xhigh。
      effortLevels: [
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
        { id: 'xhigh', displayName: 'Extra High' },
      ],
      reasoningDisplay: ['off', 'full'],
      // 三档由 permission-map 表驱动；`acceptEdits` / `default` / `plan` 无对应
      // 上游语义，故意不暴露（架构 §4.1）。
      permissionModes: [...OMP_PERMISSION_MODES],
      // OMP 的 approvalMode 是启动期加载的，热切档需要重启续接（架构 §4.5）。
      // P0 声明不支持 —— 宁可让 UI 隐藏入口，也不假装已即时生效。
      setPermissionModeMidSession: {
        supported: false,
        reason: 'not-implemented',
        message:
          'OMP applies a permission-mode change when the session restarts; choose it before the session starts.',
      },
      // 每轮 host 策略在工具审批边界上先于自动放行执行；bypassPermissions 下
      // OMP 直接放行、审批帧不冒泡 → 无法兑现，故列为不支持（与 Pi 同口径）。
      turnPermissionPolicy: {
        supported: { supported: true },
        unsupportedPermissionModes: ['bypassPermissions'],
      },
      planMode: { supported: false, reason: 'not-implemented' },
      multimodal: {
        text: { supported: true },
        // 图片/附件输入需要 OMP 侧的 input 能力证明，spike 未覆盖 → fail closed。
        image: { supported: false, reason: 'not-implemented' },
        file: { supported: false, reason: 'not-implemented' },
      },
      fork: { supported: false, reason: 'not-implemented' },
      rewind: { supported: false, reason: 'not-implemented' },
      sessionTree: { supported: false, reason: 'not-implemented' },
      abort: { supported: true },
      // OMP RPC 有独立的 steer 通道（同 turn 插话）。
      sameTurnSteer: { supported: true },
      memory: { supported: { supported: false, reason: 'not-implemented' } },
      extraDirs: { supported: false, reason: 'not-implemented' },
      writableDirs: { supported: false, reason: 'not-implemented' },
      // OMP 原生 export_html / compact RPC。
      sessionHtmlExport: { supported: true },
      manualCompact: { supported: true },
    };
  }
}

/**
 * 会话文件绝对路径。`switch_session` 只接受 `sessionPath`，因此必须拿到它，
 * 而不是上游的 `sessionId`（架构 §5）。
 */
function readSessionPath(data: unknown): string | undefined {
  if (!isOmpRecord(data)) return undefined;
  for (const key of ['sessionFile', 'sessionPath', 'session_file']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096) return value;
  }
  return undefined;
}

function readContextWindow(data: Record<string, unknown>): number | undefined {
  const model = data.model;
  if (isOmpRecord(model)) {
    const nested = model.contextWindow;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0) return nested;
  }
  const direct = data.contextWindow;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  return undefined;
}

/**
 * 终止 OMP 进程树。
 *
 * Windows 没有进程组信号，用 `taskkill /T` 走整棵树（与 pi-subagent-runs 同思路）；
 * 失败时退化为直接 kill 直接子进程，绝不静默放过。
 */
function terminateOmpProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          return;
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        return;
      }
    }
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    return;
  }
}
