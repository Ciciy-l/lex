/**
 * ompHostRegistration.test.ts —— OMP 运行时未就绪时的**注册闸**。
 *
 * omp-runtime 的三态判定(14 个单测)只证明「二进制在不在位」;这一环补的是
 * 从判定到 UI 的那一步:`buildOmpAgent` 返回 null → agents map 里没有 omp →
 * `Maker.listAvailableAgents()` 不含 `'omp'` → renderer 的 `useAvailableAgents`
 * 据此把 OMP 从引擎下拉里隐掉(不会白屏,也不会建出 `Agent 'omp' is not
 * registered` 的会话)。
 *
 * 用真的 `Maker` 而不是替身:`listAvailableAgents()` 就是 renderer 读的那一
 * 个入口,只有走真实对象这条链才算被证明。
 */

import { describe, expect, it, vi } from 'vitest';

import { Maker, type AgentDeps } from '@cindy/maker-core';
import type { SessionMeta, SessionStorage } from '@cindy/maker-core';

const env = vi.hoisted(() => ({
  binaryPath: '/bin/omp' as string | null,
  /** omp-runtime 三态的 reason;null = ready。由各测试显式设定。 */
  runtimeReason: null as string | null,
  /** download-failed 时随 reason 一起上报的错误码。 */
  runtimeDetail: null as string | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/ud', getAppPath: () => '/ap', isPackaged: false },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../anthropic-compat-proxy-host.js', () => ({
  getClaudeEndpoint: () => 'http://127.0.0.1:41041',
}));

vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: [{ id: 'xd', routing: {}, models: { omp: [{ id: 'm1' }] } }],
  }),
}));

vi.mock('../auth-adapters.js', () => ({ readClaudeApiKey: () => 'gw-key' }));

// 被测的就是这个解析器的返回值:null = 运行时未就绪。
// peekOmpRuntimeSnapshot / isLocalOmpRuntimePending 是与 omp-runtime 同形的最小
// 替身 —— 真实三态推导由 ompRuntime.test.ts 覆盖,这里只关心 buildOmpAgent 如何消费它。
vi.mock('../omp-runtime.js', () => ({
  resolveOmpBinaryPath: () => env.binaryPath,
  peekOmpRuntimeSnapshot: () => ({
    state:
      env.runtimeReason === null
        ? 'ready'
        : env.runtimeReason === 'platform-unsupported' || env.runtimeReason === 'version-mismatch'
          ? 'failed'
          : 'not-ready',
    reason: env.runtimeReason,
    binaryPath: env.binaryPath,
    version: null,
    detail: env.runtimeDetail,
  }),
  isLocalOmpRuntimePending: (snapshot: { state: string; reason: string | null; detail?: string | null }) => {
    if (snapshot.state === 'ready') return false;
    if (snapshot.reason === 'platform-unsupported' || snapshot.reason === 'version-mismatch') {
      return false;
    }
    // 与 pi-runtime-recovery 的 isRetryableOptionalRuntimePrepareError 同形。
    if (snapshot.reason === 'download-failed') {
      return snapshot.detail === 'manifest_failed'
        || snapshot.detail === 'NETWORK'
        || snapshot.detail === 'HTTP_5XX'
        || snapshot.detail === 'ABORTED';
    }
    return true;
  },
}));

vi.mock('../omp-proxy-session-token.js', () => ({
  deriveOmpProxySessionToken: (sessionId: string) => `omp-tok-${sessionId}`,
}));

import { buildOmpAgent, type BuildOmpAgentOpts } from '../omp-host';

function createStorage(): SessionStorage {
  const rows = new Map<string, SessionMeta>();
  return {
    async create(meta) {
      const now = Date.now();
      return { ...meta, createdAt: now, updatedAt: now };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`missing ${id}`);
      return { ...row, ...patch, updatedAt: Date.now() };
    },
    async compareAndClearSdkSessionId() {
      return false;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

function createLogger(): AgentDeps['logger'] {
  const logger: AgentDeps['logger'] = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => logger,
  };
  return logger;
}

/** 与 maker-host/index.ts 完全同形的注册逻辑:非 null 才注册。 */
function remoteOnlyRuntimeHooks(): Pick<
  BuildOmpAgentOpts,
  | 'resolveRemoteOmpRuntime'
  | 'getRemoteOmpTransport'
  | 'getRemoteOmpFileOps'
  | 'getRemoteAgentFileOps'
  | 'openRemoteOmpProviderForward'
> {
  return {
    resolveRemoteOmpRuntime: async () => ({
      binaryPath: '/remote/.xdt-server/v1/omp/omp',
      agentHome: '/remote/.xdt-server/v1/omp-agent-home',
      userHome: '/remote',
    }),
    getRemoteOmpTransport: () => ({}) as never,
    getRemoteOmpFileOps: () => ({}) as never,
    getRemoteAgentFileOps: () => ({}) as never,
    openRemoteOmpProviderForward: async () => ({
      baseUrl: 'http://127.0.0.1:48001',
      release: async () => undefined,
    }),
  };
}

function registerAgents(opts: Omit<BuildOmpAgentOpts, 'logger'> = {}): string[] {
  const ompAgent = buildOmpAgent({ logger: createLogger(), ...opts });
  const maker = new Maker({
    agents: ompAgent === null ? {} : { omp: ompAgent },
    storage: createStorage(),
    logger: createLogger(),
  });
  return maker.listAvailableAgents();
}

describe('OMP registration gate', () => {
  it('registers local omp when its verified runtime is ready', () => {
    env.binaryPath = '/bin/omp';
    env.runtimeReason = null;
    expect(buildOmpAgent({ logger: createLogger() })).not.toBeNull();
    expect(registerAgents()).toContain('omp');
  });

  it('uses remote-only OMP when a retained local path fails runtime verification', () => {
    env.binaryPath = '/bin/omp';
    env.runtimeReason = 'version-mismatch';
    const agent = buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() });
    expect(agent).not.toBeNull();
    expect(agent?.getBinaryPath()).toBeNull();
    expect(registerAgents(remoteOnlyRuntimeHooks())).toContain('omp');
  });

  it('leaves omp out of the available agent list when the runtime is not ready', () => {
    // 未 opt-in 安装 / 版本对不上基线 → resolveOmpBinaryPath 返回 null。
    env.binaryPath = null;
    env.runtimeReason = 'not-installed';
    expect(buildOmpAgent({ logger: createLogger() })).toBeNull();
    const available = registerAgents();
    expect(available).not.toContain('omp');
    expect(available).toEqual([]);
  });

  it('registers remote-only OMP only when the platform has no OMP asset at all', () => {
    // platform-unsupported 是唯一终态:这台机器永远不可能有本地运行时,
    // SSH 是唯一通路。其余"本地还没到手"的情况都必须推迟注册。
    env.binaryPath = null;
    env.runtimeReason = 'platform-unsupported';
    const agent = buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() });
    expect(agent).not.toBeNull();
    expect(agent?.getBinaryPath()).toBeNull();
    expect(registerAgents(remoteOnlyRuntimeHooks())).toContain('omp');
  });

  it('keeps the slot free after a failed managed download so a later retry can register', () => {
    env.binaryPath = null;
    env.runtimeReason = 'download-failed';
    env.runtimeDetail = 'NETWORK';
    expect(buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() })).toBeNull();
    expect(registerAgents(remoteOnlyRuntimeHooks())).not.toContain('omp');
  });

  it('falls back to remote-only once the managed download failed for good', () => {
    // 不可重试的终态(HTTP_4XX / CHECKSUM / asset_*)→ recovery 已放弃,本地无希望,
    // 允许 remote-only 注册,SSH 仍然可用(否则引擎会直接从列表里消失)。
    env.binaryPath = null;
    env.runtimeReason = 'download-failed';
    env.runtimeDetail = 'CHECKSUM';
    expect(buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() })).not.toBeNull();
    expect(registerAgents(remoteOnlyRuntimeHooks())).toContain('omp');
  });

  it('defers registration while the local runtime is still downloading', () => {
    // rc.2 的实际故障:Maker 在受管下载完成前构造,buildOmpAgent 靠 SSH 契约
    // 仍然成功并注册一个 remote-only agent;而 Maker.registerAgent 是加法幂等的,
    // 之后二进制下好也换不掉它,本地 OMP 在整个进程内都是死的。所以「还在等下载」
    // 时必须什么都不注册,把位置留给下载完成后的本地版 agent。
    env.binaryPath = null;
    env.runtimeReason = 'downloading';
    expect(buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() })).toBeNull();
    expect(registerAgents(remoteOnlyRuntimeHooks())).not.toContain('omp');
  });

  it('hands the slot to the local-capable agent once the runtime becomes ready', () => {
    env.binaryPath = null;
    env.runtimeReason = 'downloading';
    expect(registerAgents(remoteOnlyRuntimeHooks())).not.toContain('omp');

    env.binaryPath = '/ud/omp/18.1.18/omp';
    env.runtimeReason = null;
    expect(buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() })).not.toBeNull();
    expect(registerAgents(remoteOnlyRuntimeHooks())).toContain('omp');
  });

  it('never lets a remote-only registration block the later local one', () => {
    // 直接钉住 Maker.registerAgent 的加法契约:一旦 remote-only agent 占了位,
    // 之后再注册本地版会返回 false 且原地不动 —— 这正是 rc.2 锁死本地 OMP 的机制。
    // 所以「本地还没到手」时 buildOmpAgent 必须返回 null,一个 agent 都不注册。
    const maker = new Maker({
      agents: {},
      storage: createStorage(),
      logger: createLogger(),
    });
    env.binaryPath = null;
    env.runtimeReason = 'downloading';
    expect(buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() })).toBeNull();
    expect(maker.listAvailableAgents()).not.toContain('omp');

    env.binaryPath = '/ud/omp/18.1.18/omp';
    env.runtimeReason = null;
    const local = buildOmpAgent({ logger: createLogger(), ...remoteOnlyRuntimeHooks() });
    expect(local).not.toBeNull();
    expect(maker.registerAgent('omp', local!)).toBe(true);
    // 第二次注册同类 agent 会被拒 —— 占位是不可逆的。
    expect(maker.registerAgent('omp', local!)).toBe(false);
  });

  it('does not register remote-only OMP when a required SSH hook is missing', () => {
    env.binaryPath = null;
    env.runtimeReason = 'platform-unsupported';
    const hooks = remoteOnlyRuntimeHooks();
    expect(
      buildOmpAgent({
        logger: createLogger(),
        ...hooks,
        getRemoteOmpFileOps: undefined,
      }),
    ).toBeNull();
  });

  it('does not retain a construction-time binary path after verification stops passing', () => {
    env.binaryPath = '/bin/omp';
    env.runtimeReason = null;
    const agent = buildOmpAgent({ logger: createLogger() });
    expect(agent).not.toBeNull();

    env.binaryPath = null;
    expect(() => agent?.getBinaryPath()).toThrow(
      'OMP runtime is no longer available or failed verification',
    );
  });

  it('never lets an unregistered omp reach session creation', async () => {
    env.binaryPath = null;
    env.runtimeReason = 'not-installed';
    const maker = new Maker({
      agents: {},
      storage: createStorage(),
      logger: createLogger(),
    });
    await expect(maker.getAgentStatus('omp')).resolves.toEqual({
      binaryReady: false,
      binaryPath: null,
      authReady: false,
    });
  });
});
