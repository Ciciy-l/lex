/**
 * ompHostModelsYaml.test.ts —— 受管 models.yml 的物化。
 *
 * 这个文件守的是一条**实测出来的**硬约束(v18.1.18,docs/omp-rpc-spike.md §10):
 * OMP 不对 models.yml 的 header 值做环境变量插值(`$VAR` 原样发出),所以会话
 * token 只能走 `apiKey` 的 env **变量名**通道。后果是 models.yml 一旦被写进
 * 任何秘密,它就是一个**明文落盘的秘密** —— 这里把「设计上不可能」钉成
 * 「运行时会炸 + 单测会红」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  endpoint: 'http://127.0.0.1:41041',
  catalogModels: ['claude-sonnet-4-6', 'gpt-5.4'] as string[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/ud', getAppPath: () => '/ap', isPackaged: false },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../anthropic-compat-proxy-host.js', () => ({
  getClaudeEndpoint: () => env.endpoint,
}));

vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: [
      {
        id: 'xd',
        routing: {},
        models: { omp: env.catalogModels.map((id) => ({ id })) },
      },
    ],
  }),
}));

vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => 'gw-key',
}));

vi.mock('../omp-runtime.js', () => ({
  resolveOmpBinaryPath: () => '/bin/omp',
}));

vi.mock('../pi-proxy-session-token.js', () => ({
  deriveOmpProxySessionToken: (sessionId: string) => `omp-tok-${sessionId}`,
}));

import {
  assertOmpModelsYamlHasNoSecrets,
  buildOmpManagedModelsYaml,
  collectOmpCatalogModels,
} from '../omp-host';

const SECRET = 'omp-tok-sess-1';

describe('collectOmpCatalogModels', () => {
  beforeEach(() => {
    env.catalogModels = ['claude-sonnet-4-6', 'gpt-5.4'];
  });

  it('puts the requested model first so a cold catalog cannot block startup', () => {
    expect(collectOmpCatalogModels('my-model')[0]).toEqual({
      id: 'my-model',
      name: 'my-model',
      input: ['text'],
    });
  });

  it('merges catalog models without duplicates', () => {
    const ids = collectOmpCatalogModels('claude-sonnet-4-6').map((model) => model.id);
    expect(ids).toEqual(['claude-sonnet-4-6', 'gpt-5.4']);
  });

  it('caps the list so a runaway catalog cannot blow up the YAML', () => {
    env.catalogModels = Array.from({ length: 500 }, (_unused, index) => `m-${index}`);
    expect(collectOmpCatalogModels('x').length).toBeLessThanOrEqual(64);
  });
});

describe('buildOmpManagedModelsYaml', () => {
  beforeEach(() => {
    env.catalogModels = ['claude-sonnet-4-6'];
  });

  afterEach(() => {
    env.catalogModels = ['claude-sonnet-4-6', 'gpt-5.4'];
  });

  it('never writes the session secret into the materialized file', () => {
    const yaml = buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: 'm1', token: SECRET });
    expect(yaml).toBeDefined();
    expect(yaml).not.toContain(SECRET);
  });

  it('carries only the env NAME of the api key, never its value', () => {
    const yaml = buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: 'm1', token: SECRET });
    expect(yaml).toContain('apiKey: CINDY_OMP_PROXY_KEY');
    // 任何插值形态都不许出现:OMP 不会替换它们(实测),写出来只会骗人。
    expect(yaml).not.toContain('${');
    expect(yaml).not.toContain('$CINDY');
  });

  it('keeps only non-sensitive identifiers in headers', () => {
    const yaml = buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: 'm1', token: SECRET });
    expect(yaml).toContain('x-cindy-omp-session-id');
    expect(yaml).toContain('sess-1');
    expect(yaml).not.toContain('omp-tok');
  });

  it('points the provider at the local loopback proxy', () => {
    const yaml = buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: 'm1', token: SECRET });
    expect(yaml).toContain(env.endpoint);
  });

  it('skips materialization when no model can be served', () => {
    env.catalogModels = [];
    expect(buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: '', token: SECRET })).toBeUndefined();
  });
});

describe('assertOmpModelsYamlHasNoSecrets', () => {
  it('throws when a secret leaks into the YAML', () => {
    expect(() => assertOmpModelsYamlHasNoSecrets(`apiKey: ${SECRET}`, [SECRET])).toThrow(
      /carries a session secret/u,
    );
  });

  it('passes clean content', () => {
    expect(() => assertOmpModelsYamlHasNoSecrets('apiKey: CINDY_OMP_PROXY_KEY', [SECRET])).not.toThrow();
  });

  it('ignores empty secrets instead of matching everything', () => {
    expect(() => assertOmpModelsYamlHasNoSecrets('anything', [''])).not.toThrow();
  });
});
