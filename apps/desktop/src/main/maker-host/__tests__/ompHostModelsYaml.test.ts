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
  buildDesktopOmpExecutableEnvironment,
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

describe('buildDesktopOmpExecutableEnvironment', () => {
  it('passes only the POSIX command, terminal, and locale whitelist', () => {
    const result = buildDesktopOmpExecutableEnvironment({
      PATH: '/usr/local/bin:/usr/bin',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      HOME: '/user/home',
      API_KEY: 'must-not-cross',
      NODE_OPTIONS: '--inspect',
      PI_CONFIG_DIR: '.pi',
    }, 'linux');

    expect(result).toEqual({
      path: '/usr/local/bin:/usr/bin',
      shell: '/bin/zsh',
      term: 'xterm-256color',
      colorTerm: 'truecolor',
      lang: 'en_US.UTF-8',
      lcCtype: 'en_US.UTF-8',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('uses only Windows command-discovery values and accepts common casing', () => {
    const result = buildDesktopOmpExecutableEnvironment({
      Path: 'C:\\Tools;C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      PathExt: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\someone',
      API_KEY: 'must-not-cross',
      LANG: 'en_US.UTF-8',
    }, 'win32');

    expect(result).toEqual({
      path: 'C:\\Tools;C:\\Windows\\System32',
      systemRoot: 'C:\\Windows',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      pathext: '.COM;.EXE;.BAT;.CMD',
    });
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

  it('keeps the managed OMP provider separate from the selected Lex source', () => {
    const yaml = buildOmpManagedModelsYaml({
      sessionId: 'sess-1',
      model: 'MiniMax-M3',
      providerId: 'minimax',
      token: SECRET,
    });
    expect(yaml).toContain('  cindy:');
    expect(yaml).not.toContain('  minimax:');
    expect(yaml).toContain("x-cindy-omp-provider-id: 'minimax'");
  });

  it('points the provider at the local loopback proxy', () => {
    const yaml = buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: 'm1', token: SECRET });
    expect(yaml).toContain(env.endpoint);
  });

  it('translates the session wire protocol into the api value OMP accepts', () => {
    // Cindy 的 openai-chat 在 OMP 里叫 openai-completions;写成 openai-chat 会让 OMP
    // 整份 models.yml 被拒(实测),所以这条断言守的是**翻译**而不是字符串本身。
    expect(
      buildOmpManagedModelsYaml({
        sessionId: 'sess-1',
        model: 'm1',
        token: SECRET,
        wireProtocol: 'openai-chat',
      }),
    ).toContain('api: openai-completions');
    expect(
      buildOmpManagedModelsYaml({
        sessionId: 'sess-1',
        model: 'm1',
        token: SECRET,
        wireProtocol: 'openai-responses',
      }),
    ).toContain('api: openai-responses');
  });

  it('falls back to the Anthropic front door when nothing declares a protocol', () => {
    const yaml = buildOmpManagedModelsYaml({ sessionId: 'sess-1', model: 'm1', token: SECRET });
    expect(yaml).toContain('api: anthropic-messages');
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
