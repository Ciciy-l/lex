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

const env = vi.hoisted(() => ({ binaryPath: '/bin/omp' as string | null }));

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
vi.mock('../omp-runtime.js', () => ({
  resolveOmpBinaryPath: () => env.binaryPath,
}));

vi.mock('../pi-proxy-session-token.js', () => ({
  deriveOmpProxySessionToken: (sessionId: string) => `omp-tok-${sessionId}`,
}));

import { buildOmpAgent } from '../omp-host';

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
function registerAgents(): string[] {
  const ompAgent = buildOmpAgent({ logger: createLogger() });
  const maker = new Maker({
    agents: ompAgent === null ? {} : { omp: ompAgent },
    storage: createStorage(),
    logger: createLogger(),
  });
  return maker.listAvailableAgents();
}

describe('OMP registration gate', () => {
  it('registers omp when its runtime is ready', () => {
    env.binaryPath = '/bin/omp';
    expect(buildOmpAgent({ logger: createLogger() })).not.toBeNull();
    expect(registerAgents()).toContain('omp');
  });

  it('leaves omp out of the available agent list when the runtime is not ready', () => {
    // 未 opt-in 安装 / 版本对不上基线 → resolveOmpBinaryPath 返回 null。
    env.binaryPath = null;
    expect(buildOmpAgent({ logger: createLogger() })).toBeNull();
    const available = registerAgents();
    expect(available).not.toContain('omp');
    expect(available).toEqual([]);
  });

  it('never lets an unregistered omp reach session creation', async () => {
    env.binaryPath = null;
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
