import { createHash, randomUUID } from 'node:crypto';
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
import type {
  McpProviderContext,
  OmpHostToolDefinition,
} from '../../interfaces/mcp-provider.js';
import type { AgentKind, PermissionMode } from '../../types/common.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import type {
  AgentBuiltinCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../../types/palette.js';
import {
  isOmpRecord,
  OmpCommandCatalog,
  readOmpCommandCatalogPayload,
} from './commands.js';
import {
  createOmpSessionLaunchPlan,
  type OmpSessionCredentials,
  type OmpSessionLaunchPlan,
} from './launch-plan.js';
import { OMP_CINDY_PROVIDER_ID } from './models-config.js';
import {
  OMP_PERMISSION_MODES,
  resolveOmpApprovalMode,
} from './permission-map.js';
import { OmpPermissionBridge } from './permission-bridge.js';
import { OmpHostToolBridge } from './host-tools.js';
import { startOmpProcess, type OmpProcessHost } from './process-host.js';
import type { OmpProcessState } from './process-lifecycle.js';
import { terminateOmpProcessTree } from './process-tree.js';
import {
  OmpSessionHandle,
  type OmpPermissionRuntimeFactory,
  type OmpSessionRuntime,
  type OmpSessionRuntimeCallbacks,
} from './session-handle.js';
import { OmpTranslator } from './translator.js';
import {
  ompDisabledSkillNames,
  ompRuntimeSkillName,
  scanOmpCustomizations,
} from './customization-scanner.js';
import { projectOmpGlobalSkills } from './global-skills.js';
import {
  currentDisabledSkillLaunchPaths,
  snapshotDisabledSkillLaunch,
} from '../shared/skill-activation.js';

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
/** Give the first `/` palette a chance to include native OMP commands without making discovery a startup dependency. */
const INITIAL_COMMAND_CATALOG_WAIT_MS = 1_000;
const STARTUP_FRAME_BUFFER = 256;
const MAX_APPEND_SYSTEM_PROMPT_BYTES = 256 * 1024;

const REMOTE_UNSUPPORTED = {
  supported: false,
  reason: 'not-implemented',
  message: 'OMP cannot run on a remote host in this version.',
} as const;

/**
 * Derive an opaque, deterministic child root for one live Maker session
 * instance. The identifier never becomes a path component, so even direct
 * harness callers cannot escape the host-owned OMP runtime root.
 */
export function createOmpSessionRuntimeHome(baseHome: string, instanceId: string): string {
  return path.join(baseHome, 'runtimes', opaquePathKey(instanceId));
}

export class OmpAgent extends BaseAgent {
  readonly kind: AgentKind = 'omp';
  readonly capabilities: Capabilities;
  /**
   * OMP publishes commands per live process. Keep the catalog keyed by the
   * business session and fenced by Maker's instance id so a rebuilt session or
   * a Worker cannot leak its native commands into a sibling palette.
   */
  private readonly commandCatalogs = new Map<string, {
    readonly instanceId: string;
    readonly catalog: OmpCommandCatalog;
  }>();

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(OmpAgent.baseCapabilities());
  }

  override listAgentCommands(opts?: { sessionId?: string }): AgentBuiltinCommand[] {
    const sessionId = opts?.sessionId;
    if (!sessionId) return [];
    const snapshot = this.commandCatalogs.get(sessionId)?.catalog.getSnapshot();
    if (!snapshot || snapshot.status !== 'loaded') return [];
    return snapshot.commands.map((command) => ({
      kind: 'agent-builtin' as const,
      name: command.name,
      description: command.description ?? `OMP ${command.source} command`,
    }));
  }

  /** SkillHub's raw filesystem view; native runtime state remains in the live catalog. */
  override async listCustomizations(
    opts: ListCustomizationsOptions,
  ): Promise<ListCustomizationsResult> {
    return scanOmpCustomizations(opts);
  }

  /**
   * Filesystem Skill discovery for the palette. OMP's native catalog has no
   * source-path or snapshot provenance, so it must not upgrade a scanned file
   * to `loaded` merely because a same-name `skill:*` command exists. The live
   * catalog is exposed independently as native commands.
   */
  override async listAgentSkills(
    opts: ListAgentSkillsOptions,
  ): Promise<ListAgentSkillsResult> {
    if (opts.remoteHostId) return { skills: [] };
    const { items, errors } = await scanOmpCustomizations({
      workingDirs: opts.workingDir ? [opts.workingDir] : [],
      forceReload: opts.forceReload,
    });
    const result: ListAgentSkillsResult = {
      skills: items.flatMap((item) => {
        if (item.kind !== 'skill' || !ompRuntimeSkillName(item)) return [];
        return [{
          kind: 'agent-skill' as const,
          name: item.name,
          description: item.description,
          source: 'skill' as const,
          path: item.mdPath ?? path.join(item.absolutePath, 'SKILL.md'),
          scope: (item.scope === 'repo' ? 'repo' : 'user') as 'user' | 'repo',
          enabled: true,
          // Scanner output is advisory only. The upstream catalog does not
          // identify the physical Skill it loaded, so neither user nor repo
          // entries are executable until the live catalog publishes its own
          // native command.
          runtimeStatus: 'unknown' as const,
        }];
      }).sort((left, right) => left.name.localeCompare(right.name)),
      ...(errors.length > 0 ? { errors } : {}),
    };
    return this.filterActiveSkillCommands(result, opts.remoteHostId);
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (opts.remoteHostId) {
      throw new NotSupportedError('omp:remote-session', { ...REMOTE_UNSUPPORTED });
    }
    // OMP host-tool handlers are registered once for this process and capture
    // their MCP context. Keep an always-present, session-owned object so a
    // live Orca promotion can update that context by reference, matching the
    // Claude Code, Codex, and Pi session contracts. Do not retain the caller's
    // object: start options are only an initial snapshot.
    const mutableVendorOptions: Record<string, unknown> = {
      ...(opts.vendorOptions ?? {}),
    };
    // `providerId` is Lex's selected upstream source (for example `minimax`).
    // OMP itself must never receive that id: the managed models.yml exposes just
    // one provider, `cindy`, which points at Lex's loopback router.  Conflating
    // the two made OMP select an unconfigured/builtin provider and reject the
    // first prompt after an otherwise successful RPC handshake.
    const sourceProviderId = opts.providerId ?? OMP_CINDY_PROVIDER_ID;
    // Host-owned hard read-only sessions stay at the strict tier.
    const requestedMode: unknown = opts.reviewMode === true ? 'ask' : opts.permissionMode;
    const approvalResolution = resolveOmpApprovalMode(requestedMode);
    if (!approvalResolution.matched) {
      this.deps.logger.warn('omp permission mode was not recognized, fell back to always-ask', {
        requested: approvalResolution.requested ?? null,
      });
    }
    const initialPermissionMode: PermissionMode =
      requestedMode === 'ask' ||
      requestedMode === 'auto' ||
      requestedMode === 'bypassPermissions'
        ? requestedMode
        : 'ask';
    // Keep the same local-only Skill preference contract as the other native
    // engines. OMP names a disabled Skill in settings, so resolve the current
    // native discovery view before the process starts rather than treating a
    // disabled path as an arbitrary command name.
    const disabledSkillPaths = opts.botRuntimeProfile || opts.reviewMode === true
      ? []
      : [...(this.deps.getDisabledSkillPaths?.() ?? [])];
    const disabledSkillLaunch = snapshotDisabledSkillLaunch(disabledSkillPaths);
    let disabledSkillNames: string[] = [];
    if (disabledSkillPaths.length > 0) {
      try {
        const customizations = await scanOmpCustomizations({
          workingDirs: [opts.workingDir],
          kinds: ['skill'],
        });
        disabledSkillNames = ompDisabledSkillNames(
          customizations.items,
          currentDisabledSkillLaunchPaths(disabledSkillLaunch),
        );
      } catch (error) {
        this.deps.logger.warn('omp disabled Skill preferences could not be resolved', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const executableEnvironment = this.deps.resolveOmpExecutableEnvironment?.();
    const globalSkillsRoot = this.resolveGlobalSkillsRoot();
    // The first runtime keeps Maker's instance identity. A restart gets a new
    // opaque root so one process cannot inherit another's startup files.
    const firstRuntimeInstanceId = opts.sessionInstanceId?.trim() || randomUUID();
    let runtimeNumber = 0;
    const appendSystemPrompt = normalizeAppendSystemPrompt(opts.userPrompt);
    const mcpContext: McpProviderContext = {
      agentKind: 'omp',
      workingDir: opts.workingDir,
      ...(opts.makerMemoryScopeKey ? { memoryScopeKey: opts.makerMemoryScopeKey } : {}),
      vendorOptions: mutableVendorOptions,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
      // OMP host-tool calls are delivered only through this per-session bridge.
      // The model never supplies or controls this provenance.
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
    };
    const hostToolDefinitions = this.resolveHostTools(mcpContext);

    const createRuntime = async (input: {
      readonly permissionMode: PermissionMode;
      readonly resumeSessionFile?: string;
      readonly permitInitialRecovery: boolean;
    }): Promise<OmpSessionRuntime> => {
      const runtimeInstanceId = runtimeNumber === 0 ? firstRuntimeInstanceId : randomUUID();
      runtimeNumber += 1;
      const runtimeHome = this.resolveSessionAgentHome(runtimeInstanceId);
      const appendSystemPromptKey = appendSystemPrompt === undefined
        ? undefined
        : opaquePathKey(runtimeInstanceId);
      const commandCatalog = new OmpCommandCatalog();
      const plan = createOmpSessionLaunchPlan({
        roots: {
          home: runtimeHome,
          workingDir: opts.workingDir,
          platform: process.platform,
          ...(executableEnvironment?.systemRoot === undefined
            ? {}
            : { windowsSystemRoot: executableEnvironment.systemRoot }),
        },
        permissionMode: input.permissionMode,
        model: { provider: OMP_CINDY_PROVIDER_ID, model: opts.model },
        ...(executableEnvironment === undefined ? {} : { executableEnvironment }),
        ...(disabledSkillNames.length === 0 ? {} : { disabledSkillNames }),
        ...(appendSystemPromptKey === undefined
          ? {}
          : { appendSystemPromptKey }),
        ...(this.resolveCredentials(opts.sessionId, sourceProviderId) ?? {}),
      });

      let cleanupRuntimeFiles: (() => Promise<void>) | undefined;
      let host: OmpProcessHost | undefined;
      let hostTools: OmpHostToolBridge | undefined;
      let unregisterCommandCatalog: () => void = () => undefined;
      let callbacks: OmpSessionRuntimeCallbacks | undefined;
      let activated = false;
      let disposed = false;
      let stopAndDisposePromise: Promise<boolean> | undefined;
      const buffered: Readonly<Record<string, unknown>>[] = [];
      let pendingExit: OmpProcessState | undefined;
      const forwardFrame = (frame: Readonly<Record<string, unknown>>) => {
        if (!activated) {
          if (buffered.length < STARTUP_FRAME_BUFFER) buffered.push(frame);
          return;
        }
        callbacks?.onFrame(frame);
      };
      const forwardExit = (state: OmpProcessState) => {
        if (!activated) {
          pendingExit = state;
          return;
        }
        callbacks?.onProcessExit(state);
      };

      try {
        cleanupRuntimeFiles = await this.materializeRuntimeFiles(
          plan,
          opts.sessionId,
          sourceProviderId,
          opts.model,
          appendSystemPrompt,
          globalSkillsRoot,
        );
        host = await this.spawnHost(plan, forwardFrame, forwardExit);
        const activeHost = host;
        const translator = new OmpTranslator({ logger: this.deps.logger });
        const bridge = new OmpPermissionBridge({
          logger: this.deps.logger,
          respond: (id, response, correlation) =>
            activeHost.client.respondToUi(id, response, correlation),
          emit: (event) => callbacks?.emit(event),
        });
        hostTools = new OmpHostToolBridge(hostToolDefinitions, {
          logger: this.deps.logger,
          respond: (id, result) =>
            activeHost.client.respondToHostTool(id, result, result.isError === true),
        });
        const sessionFile = input.resumeSessionFile === undefined || input.permitInitialRecovery
          ? await this.establishSession(activeHost, opts, translator)
          : await this.resumeExistingSession(activeHost, input.resumeSessionFile, translator);
        // A fresh process has no retained bridge surface. Register even an empty
        // set after new/switch_session and before a prompt can be sent.
        const { response: hostToolsResponse } = activeHost.client.request(
          { type: 'set_host_tools', tools: hostTools.definitions() },
          RPC_TIMEOUT_MS,
        );
        await hostToolsResponse;
        const initialCommandCatalogRefresh = this.refreshCommandCatalog(activeHost, commandCatalog);
        await waitForInitialOmpCommandCatalog(initialCommandCatalogRefresh);

        const runtime: OmpSessionRuntime = {
          sessionFile,
          permissionMode: input.permissionMode,
          approvalMode: plan.approvalMode,
          host: activeHost,
          translator,
          bridge,
          hostTools,
          commandCatalog,
          activate: (nextCallbacks) => {
            if (activated || disposed) return;
            activated = true;
            callbacks = nextCallbacks;
            unregisterCommandCatalog = this.registerCommandCatalog(
              opts.sessionId,
              runtimeInstanceId,
              commandCatalog,
            );
            for (const frame of buffered.splice(0)) callbacks.onFrame(frame);
            if (pendingExit !== undefined) callbacks.onProcessExit(pendingExit);
          },
          stopAndDispose: () => {
            if (stopAndDisposePromise) return stopAndDisposePromise;
            disposed = true;
            hostTools?.close();
            unregisterCommandCatalog();
            stopAndDisposePromise = (async () => {
              try {
                return await activeHost.stopAndWait();
              } finally {
                await cleanupRuntimeFiles?.();
              }
            })();
            return stopAndDisposePromise;
          },
        };
        return Object.freeze(runtime);
      } catch (error) {
        hostTools?.close();
        unregisterCommandCatalog();
        await host?.stopAndWait().catch(() => false);
        await cleanupRuntimeFiles?.().catch(() => undefined);
        throw error;
      }
    };

    const initialRuntime = await createRuntime({
      permissionMode: initialPermissionMode,
      ...(opts.resumeSessionId === undefined ? {} : { resumeSessionFile: opts.resumeSessionId }),
      permitInitialRecovery: true,
    });
    const restartRuntime: OmpPermissionRuntimeFactory = ({ permissionMode, sessionFile }) =>
      createRuntime({
        permissionMode,
        resumeSessionFile: sessionFile,
        permitInitialRecovery: false,
      });
    return new OmpSessionHandle({
      sessionId: initialRuntime.sessionFile,
      model: opts.model,
      // Keep the Lex source for subsequent model-selection bookkeeping, while
      // native set_model calls continue to target the managed `cindy` provider.
      providerId: sourceProviderId,
      ompProviderId: OMP_CINDY_PROVIDER_ID,
      workingDir: opts.workingDir,
      ...(opts.reviewMode === true ? { reviewMode: true } : {}),
      disabledSkillPaths: disabledSkillLaunch.identities,
      vendorOptions: mutableVendorOptions,
      runtime: initialRuntime,
      restartRuntime,
      logger: this.deps.logger,
    });
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
      // POSIX must give the managed session its own process group so an OMP
      // extension, MCP, LSP, or PTY descendant cannot survive the root.
      detached: process.platform !== 'win32',
      ownsProcessTree: true,
      spawnProcess: this.deps.spawnOmpProcess,
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
    if (typeof resume === 'string' && resume.length > 0) {
      if (!isOmpSessionFilePath(resume)) {
        // A persisted SDK id is untrusted input on the way back into OMP.
        // Never allow a legacy/corrupt relative path to resolve against the
        // native process cwd and attach an unrelated project history.
        this.deps.logger.warn('omp resume session identity is invalid');
      } else {
        try {
          const { response } = host.client.request(
            { type: 'switch_session', sessionPath: resume },
            RPC_TIMEOUT_MS,
          );
          await response;
          const resumed = await this.readSessionFile(host, translator);
          if (resumed !== undefined && !sameOmpSessionFile(resumed, resume)) {
            // A successful RPC response that points at another history is not an
            // invalid/missing resume.  Never clear the stored id or silently
            // attach this Lex task to a different upstream session.
            throw new OmpResumeIdentityMismatchError();
          }
          sessionFile = resumed;
        } catch (error) {
          if (error instanceof OmpResumeIdentityMismatchError) throw error;
          this.deps.logger.warn('omp resume failed', {
            message: error instanceof Error ? error.message : String(error),
          });
          sessionFile = undefined;
        }
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

  /**
   * Permission-mode restart is stricter than initial startup: it must resume
   * the already-live upstream history and never run the invalid-resume fresh
   * fallback.  A replacement that cannot prove that identity is discarded.
   */
  private async resumeExistingSession(
    host: OmpProcessHost,
    expectedSessionFile: string,
    translator: OmpTranslator,
  ): Promise<string> {
    if (!isOmpSessionFilePath(expectedSessionFile))
      throw new OmpResumeIdentityMismatchError();
    const { response } = host.client.request(
      { type: 'switch_session', sessionPath: expectedSessionFile },
      RPC_TIMEOUT_MS,
    );
    await response;
    const resumed = await this.readSessionFile(host, translator);
    if (resumed === undefined || !sameOmpSessionFile(resumed, expectedSessionFile)) {
      throw new OmpResumeIdentityMismatchError();
    }
    return resumed;
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

  /** Resolve the optional shared user Skill source without adopting ~/.omp. */
  private resolveGlobalSkillsRoot(): string | undefined {
    try {
      return this.deps.resolveOmpGlobalSkillsRoot?.();
    } catch {
      this.deps.logger.warn('omp shared global Skills root is unavailable');
      return undefined;
    }
  }

  /** Each live process gets a private HOME/config/agent/session directory. */
  private resolveSessionAgentHome(instanceId: string): string {
    return createOmpSessionRuntimeHome(this.resolveAgentHome(), instanceId);
  }

  private registerCommandCatalog(
    sessionId: string | undefined,
    instanceId: string,
    catalog: OmpCommandCatalog,
  ): () => void {
    if (!sessionId) return () => undefined;
    this.commandCatalogs.set(sessionId, { instanceId, catalog });
    return () => {
      const current = this.commandCatalogs.get(sessionId);
      if (current?.instanceId === instanceId) this.commandCatalogs.delete(sessionId);
    };
  }

  private async refreshCommandCatalog(
    host: OmpProcessHost,
    catalog: OmpCommandCatalog,
  ): Promise<void> {
    const ticket = catalog.beginRead();
    try {
      const { response } = host.client.request(
        { type: 'get_available_commands' },
        RPC_TIMEOUT_MS,
      );
      const result = await response;
      catalog.completeRead(ticket, readOmpCommandCatalogPayload(result.data));
    } catch (error) {
      catalog.failRead(ticket);
      this.deps.logger.debug('omp native command catalog is unavailable', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private resolveCredentials(
    sessionId: string | undefined,
    providerId: string,
  ): { credentials: OmpSessionCredentials } | undefined {
    const credentials = this.deps.resolveOmpCredentials?.({ sessionId, providerId });
    return credentials === undefined ? undefined : { credentials };
  }

  /**
   * Build one immutable, session-scoped host-tool surface.  A provider must opt
   * into OMP explicitly; ordinary MCP providers are not reinterpreted as OMP
   * extensions or discovered from the project.
   */
  private resolveHostTools(context: McpProviderContext): readonly OmpHostToolDefinition[] {
    const tools: OmpHostToolDefinition[] = [];
    const names = new Set<string>();
    for (const provider of this.deps.mcpProviders ?? []) {
      // Non-adapted providers have no OMP surface.  Skip them before their
      // enablement gate so a generic MCP provider cannot affect this bounded
      // host-tool startup path merely by being present in the shared list.
      if (!provider.toOmpRpcHostTools) continue;
      let enabled = true;
      try {
        enabled = provider.isEnabled?.(context) !== false;
      } catch {
        throw new Error(`OMP host tool provider "${provider.name}" could not be evaluated`);
      }
      if (!enabled) continue;
      let provided: readonly OmpHostToolDefinition[] | null;
      try {
        provided = provider.toOmpRpcHostTools(context);
      } catch {
        throw new Error(`OMP host tool provider "${provider.name}" could not be configured`);
      }
      if (provided === null) continue;
      for (const tool of provided) {
        if (names.has(tool.name))
          throw new Error(`Duplicate OMP host tool "${tool.name}"`);
        names.add(tool.name);
        tools.push(tool);
      }
    }
    return Object.freeze(tools);
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
    appendSystemPrompt: string | undefined,
    globalSkillsRoot: string | undefined,
  ): Promise<() => Promise<void>> {
    let cleaned = false;
    const cleanupSystemPrompt = async () => {
      if (cleaned || plan.roots.systemPromptFile === undefined) return;
      cleaned = true;
      try {
        await fs.unlink(plan.roots.systemPromptFile);
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        if (code !== 'ENOENT') {
          this.deps.logger.warn('omp system prompt cleanup failed', {
            code: typeof code === 'string' ? code : 'unknown',
          });
        }
      }
    };
    try {
      await fs.mkdir(plan.roots.agent, { recursive: true });
      await fs.mkdir(plan.roots.sessions, { recursive: true });
      const projectedSkills = await projectOmpGlobalSkills({
        sourceRoot: globalSkillsRoot,
        targetRoot: plan.roots.globalSkillsDirectory,
      });
      if (projectedSkills.status === 'conflict' || projectedSkills.status === 'error') {
        // Skills are a native optional resource: a local projection conflict
        // must not make an otherwise usable project session fail to start.
        this.deps.logger.warn('omp shared global Skills projection unavailable', {
          status: projectedSkills.status,
        });
      }
      await fs.writeFile(plan.roots.settingsFile, plan.settingsYaml, {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (plan.roots.systemPromptFile !== undefined) {
        if (appendSystemPrompt === undefined)
          throw new Error('OMP system prompt plan and content are inconsistent');
        await fs.mkdir(plan.roots.systemPromptDirectory, { recursive: true });
        await fs.writeFile(plan.roots.systemPromptFile, appendSystemPrompt, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      const modelsYaml = this.deps.resolveOmpModelsYaml?.({ sessionId, providerId, model });
      if (modelsYaml === undefined) {
        this.deps.logger.warn('omp models.yml was not provided; only built-in providers are usable');
      } else {
        await fs.writeFile(plan.roots.modelsFile, modelsYaml, { encoding: 'utf8', mode: 0o600 });
      }
      return cleanupSystemPrompt;
    } catch (error) {
      // The append prompt is per-session and can carry Orca role instructions.
      // Do not leave it behind if later models.yml materialization fails.
      await cleanupSystemPrompt();
      throw error;
    }
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
      // OMP reads approval mode at startup. The handle safely rebuilds and
      // resumes the same native JSONL session when the user changes it.
      setPermissionModeMidSession: { supported: true },
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
    if (isOmpSessionFilePath(value)) return value;
  }
  return undefined;
}

/**
 * Session files are persisted as Lex's sdkSessionId then sent back through
 * OMP's `switch_session`. Treat them as a path capability, never an opaque
 * arbitrary string: a relative path would otherwise be interpreted beneath
 * the next process cwd.
 */
function isOmpSessionFilePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return false;
  }
  const implementation = process.platform === 'win32' ? path.win32 : path.posix;
  if (!implementation.isAbsolute(value)) return false;
  // `\\history.jsonl` is only rooted at whichever drive happens to be
  // current for a Windows process. Unlike a drive-qualified or UNC path it is
  // not a stable identity that can safely survive a later restart.
  if (process.platform === 'win32') {
    const root = implementation.parse(implementation.normalize(value)).root;
    if (root === '\\' || root === '/') return false;
  }
  return true;
}

class OmpResumeIdentityMismatchError extends Error {
  constructor() {
    super('OMP resume session identity mismatch');
  }
}

/**
 * Compare the logical path OMP reports, not filesystem identity: a resumed
 * JSONL may be unavailable to `realpath` until its first write. Windows path
 * spelling is case-insensitive; POSIX remains exact after normalization.
 */
function sameOmpSessionFile(left: string, right: string): boolean {
  if (!isOmpSessionFilePath(left) || !isOmpSessionFilePath(right)) return false;
  const implementation = process.platform === 'win32' ? path.win32 : path.posix;
  const normalizedLeft = implementation.normalize(left);
  const normalizedRight = implementation.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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

/** Keep per-session prompt bytes bounded and out of argv / environment. */
function normalizeAppendSystemPrompt(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.includes('\0'))
    throw new Error('Invalid OMP system prompt');
  if (value.trim().length === 0) return undefined;
  if (Buffer.byteLength(value, 'utf8') > MAX_APPEND_SYSTEM_PROMPT_BYTES)
    throw new Error('OMP system prompt exceeds the supported size');
  return value;
}

/**
 * A slow or malformed native command directory must never make the task fail
 * to start. Keep the read alive after the short first-palette window so its
 * catalog subscription can refresh the UI when it eventually settles.
 */
async function waitForInitialOmpCommandCatalog(refresh: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      refresh.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, INITIAL_COMMAND_CATALOG_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** An opaque filename key; neither session identity nor prompt text appears in a path. */
function opaquePathKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
