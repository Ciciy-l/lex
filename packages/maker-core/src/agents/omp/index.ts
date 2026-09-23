import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type OmpRemoteFileOps,
  type StartSessionOptions,
} from '../base-agent.js';
import type { Capabilities } from '../../types/capabilities.js';
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
import {
  startOmpProcess,
  startOmpRemoteProcess,
  type OmpProcessHost,
} from './process-host.js';
import type { OmpProcessState } from './process-lifecycle.js';
import {
  getOmpProcessIsolationOptions,
  terminateOmpProcessTree,
} from './process-tree.js';
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
import { scanRemoteOmpSkills } from '../shared/remote-skill-scanner.js';

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

interface ResolvedRemoteOmpRuntime {
  readonly remoteHostId: string;
  readonly binaryPath: string;
  readonly agentHome: string;
  readonly userHome: string;
  readonly fileOps: OmpRemoteFileOps;
}

interface RemoteOmpProviderForward {
  readonly baseUrl: string;
  release(): Promise<void>;
}

/**
 * Derive an opaque, deterministic child root for one live Maker session
 * instance. The identifier never becomes a path component, so even direct
 * harness callers cannot escape the host-owned OMP runtime root.
 */
export function createOmpSessionRuntimeHome(
  baseHome: string,
  instanceId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const implementation = platform === 'win32' ? path.win32 : path.posix;
  return implementation.join(baseHome, 'runtimes', opaquePathKey(instanceId));
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
    if (opts.remoteHostId) {
      const fileOps = this.deps.getRemoteAgentFileOps?.(opts.remoteHostId);
      if (!fileOps) throw new Error('OMP remote Skill discovery requires remote file operations');
      return this.filterActiveSkillCommands(
        await scanRemoteOmpSkills({ fileOps, workingDir: opts.workingDir }),
        opts.remoteHostId,
      );
    }
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
    const remoteHostId = normalizeRemoteHostId(opts.remoteHostId);
    const isolatedProbe = opts.isolatedProbe === true;
    if (isolatedProbe && opts.disableHostTools !== true) {
      throw new Error('OMP isolated probes require an empty host-tool surface');
    }
    if (remoteHostId && !this.deps.resolveRemoteOmpRuntime) {
      throw new Error('OMP remote sessions require a host-provided remote runtime resolver');
    }
    if (remoteHostId && !this.deps.getRemoteOmpTransport) {
      throw new Error('OMP remote sessions require a host-provided SSH transport');
    }
    if (remoteHostId && !this.deps.getRemoteOmpFileOps) {
      throw new Error('OMP remote sessions require remote file operations');
    }
    if (remoteHostId && !this.deps.openRemoteOmpProviderForward) {
      throw new Error('OMP remote sessions require a managed provider forward');
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
    const disabledSkillPaths = remoteHostId || opts.botRuntimeProfile || opts.reviewMode === true
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
    // A remote process inherits only its remote shell's ordinary baseline, plus
    // the explicit plan env below. Never send Desktop PATH/locale values over
    // SSH: they are local-machine facts and can carry incompatible paths.
    const executableEnvironment = remoteHostId
      ? undefined
      : this.deps.resolveOmpExecutableEnvironment?.();
    const globalSkillsRoot = remoteHostId ? undefined : this.resolveGlobalSkillsRoot();
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
    // A host-owned ephemeral connectivity probe deliberately validates only the
    // managed runtime/provider path. It must not expose normal MCP-backed host
    // tools merely because the model happens to choose a tool-shaped response.
    // Ordinary OMP sessions retain the full explicitly adapted tool roster.
    const hostToolDefinitions = opts.disableHostTools === true
      ? Object.freeze([] as OmpHostToolDefinition[])
      : this.resolveHostTools(mcpContext);

    const createRuntime = async (input: {
      readonly permissionMode: PermissionMode;
      readonly resumeSessionFile?: string;
      readonly permitInitialRecovery: boolean;
    }): Promise<OmpSessionRuntime> => {
      const runtimeInstanceId = runtimeNumber === 0 ? firstRuntimeInstanceId : randomUUID();
      runtimeNumber += 1;
      const appendSystemPromptKey = appendSystemPrompt === undefined
        ? undefined
        : opaquePathKey(runtimeInstanceId);
      const commandCatalog = new OmpCommandCatalog();
      let remoteRuntime: ResolvedRemoteOmpRuntime | undefined;
      let remoteProviderForward: RemoteOmpProviderForward | undefined;
      let cleanupRuntimeFiles: (() => Promise<void>) | undefined;
      let cleanupIsolatedRuntimeHome: () => Promise<void> = async () => undefined;
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
        if (remoteHostId) {
          remoteRuntime = await this.resolveRemoteRuntime(remoteHostId);
          const providerForward = await this.deps.openRemoteOmpProviderForward!(remoteHostId);
          try {
            remoteProviderForward = validateRemoteOmpProviderForward(providerForward);
          } catch (error) {
            await providerForward?.release?.().catch(() => undefined);
            throw error;
          }
        }
        const remoteProxyEnvironment = remoteHostId
          ? await this.deps.getRemoteOmpAgentProxyEnv?.(remoteHostId)
          : null;
        const runtimeHome = remoteRuntime
          ? createOmpSessionRuntimeHome(remoteRuntime.agentHome, runtimeInstanceId, 'linux')
          : this.resolveSessionAgentHome(runtimeInstanceId);
        // A connectivity probe must never start beneath a real remote project
        // or user HOME. OMP's native customization walker stops at its process
        // HOME, so a freshly-created child cwd gives it a hard discovery
        // boundary without changing normal project-session semantics.
        const runtimeWorkingDir = isolatedProbe
          ? (remoteRuntime
              ? path.posix.join(runtimeHome, 'workdir')
              : path.join(runtimeHome, 'workdir'))
          : opts.workingDir;
        cleanupIsolatedRuntimeHome = async (): Promise<void> => {
          if (!isolatedProbe) return;
          if (remoteRuntime) {
            await remoteRuntime.fileOps.rm(runtimeHome, { recursive: true });
            return;
          }
          await fs.rm(runtimeHome, { recursive: true, force: true });
        };
        const plan = createOmpSessionLaunchPlan({
          roots: {
            home: runtimeHome,
            workingDir: runtimeWorkingDir,
            // Remote SSH hosts follow the existing POSIX remote contract. Both
            // supported remote OS families use POSIX paths and env layout.
            platform: remoteRuntime ? 'linux' : process.platform,
            ...(executableEnvironment?.systemRoot === undefined
              ? {}
              : { windowsSystemRoot: executableEnvironment.systemRoot }),
          },
          permissionMode: input.permissionMode,
          model: { provider: OMP_CINDY_PROVIDER_ID, model: opts.model },
          ...(executableEnvironment === undefined ? {} : { executableEnvironment }),
          ...(remoteProxyEnvironment === null || remoteProxyEnvironment === undefined
            ? {}
            : { remoteProxyEnvironment }),
          ...(disabledSkillNames.length === 0 ? {} : { disabledSkillNames }),
          ...(appendSystemPromptKey === undefined
            ? {}
            : { appendSystemPromptKey }),
          ...(this.resolveCredentials(opts.sessionId, sourceProviderId) ?? {}),
        });
        cleanupRuntimeFiles = await this.materializeRuntimeFiles(
          plan,
          opts.sessionId,
          sourceProviderId,
          opts.model,
          appendSystemPrompt,
          globalSkillsRoot,
          remoteRuntime,
          remoteProviderForward?.baseUrl,
          isolatedProbe,
        );
        host = await this.spawnHost(plan, forwardFrame, forwardExit, remoteRuntime);
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
        const sessionPathPlatform: NodeJS.Platform = remoteRuntime ? 'linux' : process.platform;
        const sessionFile = input.resumeSessionFile === undefined || input.permitInitialRecovery
          ? await this.establishSession(activeHost, opts, translator, sessionPathPlatform)
          : await this.resumeExistingSession(
              activeHost,
              input.resumeSessionFile,
              translator,
              sessionPathPlatform,
            );
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
                try {
                  await cleanupRuntimeFiles?.();
                } finally {
                  try {
                    await cleanupIsolatedRuntimeHome();
                  } finally {
                    await remoteProviderForward?.release();
                  }
                }
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
        await cleanupIsolatedRuntimeHome().catch(() => undefined);
        await remoteProviderForward?.release().catch(() => undefined);
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
    remoteRuntime?: ResolvedRemoteOmpRuntime,
  ): Promise<OmpProcessHost> {
    let settleReady: (() => void) | undefined;
    let failReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      failReady = reject;
    });
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const onEvent = (frame: Readonly<Record<string, unknown>>) => {
      if (frame.type === 'ready') {
        if (timer) clearTimeout(timer);
        settleReady?.();
      }
      onFrame(frame);
    };
    const onState = (state: OmpProcessState) => {
      this.deps.logger.debug('omp process state', {
        state,
        ...(remoteRuntime ? { remoteHostId: remoteRuntime.remoteHostId } : {}),
      });
      if (state === 'exited' || state === 'exit-unconfirmed') {
        if (timer) clearTimeout(timer);
        failReady?.(new Error('OMP process exited before the RPC handshake'));
        onExit(state);
      }
    };
    const host = remoteRuntime
      ? startOmpRemoteProcess({
          transport: await this.deps.getRemoteOmpTransport!(remoteRuntime.remoteHostId, {
            remoteBinaryPath: remoteRuntime.binaryPath,
            args: [...plan.arguments],
            cwd: plan.roots.workingDir,
            env: { ...plan.environment },
            logger: this.deps.logger,
          }),
          onEvent,
          onState,
        })
      : startOmpProcess({
          executablePath: this.resolveLocalBinaryPath(),
          workingDirectory: plan.roots.workingDir,
          arguments: plan.arguments,
          environment: plan.environment,
          ...getOmpProcessIsolationOptions(),
          terminateProcessTree: terminateOmpProcessTree,
          onEvent,
          onState,
        });
    timer = setTimeout(() => {
      failReady?.(new Error('OMP did not complete its RPC handshake in time'));
    }, READY_TIMEOUT_MS);

    try {
      await ready;
    } catch (error) {
      if (timer) clearTimeout(timer);
      await host.stopAndWait().catch(() => false);
      throw error;
    }
    if (timer) clearTimeout(timer);
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
    sessionPathPlatform: NodeJS.Platform = process.platform,
  ): Promise<string> {
    const resume = opts.resumeSessionId;
    let sessionFile: string | undefined;
    if (typeof resume === 'string' && resume.length > 0) {
      if (!isOmpSessionFilePath(resume, sessionPathPlatform)) {
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
          const resumed = await this.readSessionFile(host, translator, sessionPathPlatform);
          if (resumed !== undefined && !sameOmpSessionFile(resumed, resume, sessionPathPlatform)) {
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
      sessionFile = await this.readSessionFile(host, translator, sessionPathPlatform);
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
    sessionPathPlatform: NodeJS.Platform = process.platform,
  ): Promise<string> {
    if (!isOmpSessionFilePath(expectedSessionFile, sessionPathPlatform))
      throw new OmpResumeIdentityMismatchError();
    const { response } = host.client.request(
      { type: 'switch_session', sessionPath: expectedSessionFile },
      RPC_TIMEOUT_MS,
    );
    await response;
    const resumed = await this.readSessionFile(host, translator, sessionPathPlatform);
    if (resumed === undefined || !sameOmpSessionFile(resumed, expectedSessionFile, sessionPathPlatform)) {
      throw new OmpResumeIdentityMismatchError();
    }
    return resumed;
  }

  private async readSessionFile(
    host: OmpProcessHost,
    translator: OmpTranslator,
    sessionPathPlatform: NodeJS.Platform = process.platform,
  ): Promise<string | undefined> {
    const { response } = host.client.request({ type: 'get_state' }, RPC_TIMEOUT_MS);
    const state = await response;
    const data = state.data;
    if (isOmpRecord(data)) {
      // 上下文窗口只有 get_state 能给；拿不到就维持 0（renderer 有兜底）。
      const window = readContextWindow(data);
      if (window !== undefined) translator.setContextWindow(window);
    }
    return readSessionPath(data, sessionPathPlatform);
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

  /** Resolve the local audited binary at the last possible moment before spawn. */
  private resolveLocalBinaryPath(): string {
    const resolved = this.deps.resolveOmpLocalBinaryPath?.() ?? this.requireLocalBinaryPath();
    if (
      typeof resolved !== 'string' ||
      !resolved ||
      resolved.includes('\0') ||
      !path.isAbsolute(resolved)
    ) {
      throw new Error('OMP local runtime is unavailable or failed verification');
    }
    return resolved;
  }

  private async resolveRemoteRuntime(remoteHostId: string): Promise<ResolvedRemoteOmpRuntime> {
    const runtime = await this.deps.resolveRemoteOmpRuntime!(remoteHostId);
    const fileOps = this.deps.getRemoteOmpFileOps!(remoteHostId);
    if (!runtime || typeof runtime !== 'object' || !fileOps) {
      throw new Error('OMP remote runtime is unavailable');
    }
    const requireRemotePath = (value: unknown, name: string): string => {
      if (
        typeof value !== 'string' ||
        !value ||
        value.includes('\0') ||
        !path.posix.isAbsolute(value) ||
        path.posix.normalize(value) === '/'
      ) {
        throw new Error('OMP remote ' + name + ' must be an absolute non-root POSIX path');
      }
      return path.posix.normalize(value);
    };
    return Object.freeze({
      remoteHostId,
      binaryPath: requireRemotePath(runtime.binaryPath, 'binary'),
      agentHome: requireRemotePath(runtime.agentHome, 'agent home'),
      userHome: requireRemotePath(runtime.userHome, 'user home'),
      fileOps,
    });
  }

  private async projectRemoteGlobalSkills(
    remoteRuntime: ResolvedRemoteOmpRuntime,
    targetRoot: string,
  ): Promise<void> {
    try {
      const sourceRoot = path.posix.join(remoteRuntime.userHome, '.agents', 'skills');
      const source = await remoteRuntime.fileOps.stat(sourceRoot);
      if (!source || source.isFile) return;
      await remoteRuntime.fileOps.linkDirectory(sourceRoot, targetRoot);
    } catch (error) {
      // Skills are optional native discovery input. A remote filesystem
      // conflict must not stop an otherwise valid coding session.
      this.deps.logger.warn('omp remote shared global Skills projection unavailable', {
        remoteHostId: remoteRuntime.remoteHostId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
    remoteRuntime?: ResolvedRemoteOmpRuntime,
    remoteBaseUrl?: string,
    isolatedProbe = false,
  ): Promise<() => Promise<void>> {
    let cleaned = false;
    const cleanupSystemPrompt = async () => {
      if (cleaned || plan.roots.systemPromptFile === undefined) return;
      cleaned = true;
      try {
        if (remoteRuntime) {
          await remoteRuntime.fileOps.rm(plan.roots.systemPromptFile);
        } else {
          await fs.unlink(plan.roots.systemPromptFile);
        }
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        if (code !== 'ENOENT') {
          this.deps.logger.warn('omp system prompt cleanup failed', {
            ...(remoteRuntime ? { remoteHostId: remoteRuntime.remoteHostId } : {}),
            code: typeof code === 'string' ? code : 'unknown',
          });
        }
      }
    };
    try {
      if (remoteRuntime) {
        await remoteRuntime.fileOps.mkdirp(plan.roots.agent);
        await remoteRuntime.fileOps.mkdirp(plan.roots.sessions);
        if (isolatedProbe) {
          await remoteRuntime.fileOps.mkdirp(plan.roots.workingDir);
        } else {
          await this.projectRemoteGlobalSkills(remoteRuntime, plan.roots.globalSkillsDirectory);
        }
        await remoteRuntime.fileOps.writeFile(plan.roots.settingsFile, plan.settingsYaml, 0o600);
      } else {
        await fs.mkdir(plan.roots.agent, { recursive: true });
        await fs.mkdir(plan.roots.sessions, { recursive: true });
        if (isolatedProbe) {
          await fs.mkdir(plan.roots.workingDir, { recursive: true });
        } else {
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
        }
        await fs.writeFile(plan.roots.settingsFile, plan.settingsYaml, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      if (plan.roots.systemPromptFile !== undefined) {
        if (appendSystemPrompt === undefined)
          throw new Error('OMP system prompt plan and content are inconsistent');
        if (remoteRuntime) {
          await remoteRuntime.fileOps.mkdirp(plan.roots.systemPromptDirectory);
          await remoteRuntime.fileOps.writeFile(
            plan.roots.systemPromptFile,
            appendSystemPrompt,
            0o600,
          );
        } else {
          await fs.mkdir(plan.roots.systemPromptDirectory, { recursive: true });
          await fs.writeFile(plan.roots.systemPromptFile, appendSystemPrompt, {
            encoding: 'utf8',
            mode: 0o600,
          });
        }
      }
      const modelsYaml = this.deps.resolveOmpModelsYaml?.({
        sessionId,
        providerId,
        model,
        ...(remoteRuntime ? { remoteHostId: remoteRuntime.remoteHostId } : {}),
        ...(remoteBaseUrl ? { remoteBaseUrl } : {}),
      });
      if (modelsYaml === undefined) {
        this.deps.logger.warn('omp models.yml was not provided; only built-in providers are usable');
      } else if (remoteRuntime) {
        await remoteRuntime.fileOps.writeFile(plan.roots.modelsFile, modelsYaml, 0o600);
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
function readSessionPath(
  data: unknown,
  sessionPathPlatform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isOmpRecord(data)) return undefined;
  for (const key of ['sessionFile', 'sessionPath', 'session_file']) {
    const value = data[key];
    if (isOmpSessionFilePath(value, sessionPathPlatform)) return value;
  }
  return undefined;
}

/**
 * Session files are persisted as Lex's sdkSessionId then sent back through
 * OMP's `switch_session`. Treat them as a path capability, never an opaque
 * arbitrary string: a relative path would otherwise be interpreted beneath
 * the next process cwd.
 */
function isOmpSessionFilePath(
  value: unknown,
  sessionPathPlatform: NodeJS.Platform = process.platform,
): value is string {
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
  const implementation = sessionPathPlatform === 'win32' ? path.win32 : path.posix;
  if (!implementation.isAbsolute(value)) return false;
  // `\\history.jsonl` is only rooted at whichever drive happens to be
  // current for a Windows process. Unlike a drive-qualified or UNC path it is
  // not a stable identity that can safely survive a later restart.
  if (sessionPathPlatform === 'win32') {
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
function sameOmpSessionFile(
  left: string,
  right: string,
  sessionPathPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (
    !isOmpSessionFilePath(left, sessionPathPlatform) ||
    !isOmpSessionFilePath(right, sessionPathPlatform)
  ) return false;
  const implementation = sessionPathPlatform === 'win32' ? path.win32 : path.posix;
  const normalizedLeft = implementation.normalize(left);
  const normalizedRight = implementation.normalize(right);
  return sessionPathPlatform === 'win32'
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

function normalizeRemoteHostId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    value.includes('\0') ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Invalid OMP remote host identity');
  }
  return value.trim();
}

function validateRemoteOmpProviderForward(value: unknown): RemoteOmpProviderForward {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OMP remote provider forward is unavailable');
  const candidate = value as Partial<RemoteOmpProviderForward>;
  if (typeof candidate.baseUrl !== 'string' || typeof candidate.release !== 'function')
    throw new Error('OMP remote provider forward is unavailable');
  let parsed: URL;
  try {
    parsed = new URL(candidate.baseUrl);
  } catch {
    throw new Error('OMP remote provider forward must provide a loopback URL');
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const port = Number(parsed.port);
  if (
    !['127.0.0.1', '::1', 'localhost'].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    parsed.username ||
    parsed.password ||
    candidate.baseUrl.length > 2048
  ) {
    throw new Error('OMP remote provider forward must provide a loopback URL');
  }
  return Object.freeze({ baseUrl: candidate.baseUrl, release: candidate.release });
}

/** An opaque filename key; neither session identity nor prompt text appears in a path. */
function opaquePathKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
