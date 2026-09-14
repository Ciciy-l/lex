import { describe, expect, it } from 'vitest';
import {
  buildOmpCindyModelsYaml,
  buildOmpCindyProvider,
  buildOmpModelsConfigYaml,
  OMP_CINDY_API_KEY_ENV,
  OMP_CINDY_PROVIDER_ID,
  OMP_CINDY_PROVIDER_ID_HEADER,
  OMP_CINDY_SESSION_ID_HEADER,
  OMP_CINDY_SESSION_TOKEN_HEADER,
} from './models-config.js';

const BASE_PROVIDER = {
  id: 'cindy',
  baseUrl: 'http://127.0.0.1:1117/v1',
  api: 'anthropic-messages',
  apiKeyEnv: OMP_CINDY_API_KEY_ENV,
  models: [{ id: 'MiniMax-M2', name: 'MiniMax M2' }],
} as const;

// JSON 往返模拟宿主侧未校验的输入：让 hostile 值以"线上真实形态"进入生成器。
function buildUnknown(input: unknown): string {
  return buildOmpModelsConfigYaml(JSON.parse(JSON.stringify(input ?? null)));
}

describe('buildOmpModelsConfigYaml', () => {
  it('emits a provider block whose apiKey is an env name, never a secret', () => {
    const yaml = buildOmpModelsConfigYaml({ providers: [BASE_PROVIDER] });
    expect(yaml).toContain('providers:');
    expect(yaml).toContain('  cindy:');
    expect(yaml).toContain(`    baseUrl: 'http://127.0.0.1:1117/v1'`);
    expect(yaml).toContain('    api: anthropic-messages');
    expect(yaml).toContain(`    apiKey: ${OMP_CINDY_API_KEY_ENV}`);
    expect(yaml).toContain('    models:');
    expect(yaml).toContain('      - id: MiniMax-M2');
    expect(yaml).toContain(`        name: 'MiniMax M2'`);
  });

  it('is deterministic so the host can skip redundant writes', () => {
    expect(buildOmpModelsConfigYaml({ providers: [BASE_PROVIDER] })).toBe(
      buildOmpModelsConfigYaml({ providers: [BASE_PROVIDER] }),
    );
  });

  it('renders optional model metadata only when present', () => {
    const yaml = buildOmpModelsConfigYaml({
      providers: [
        {
          ...BASE_PROVIDER,
          models: [
            {
              id: 'claude-sonnet-4-6',
              contextWindow: 1_000_000,
              maxTokens: 128_000,
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 5, output: 30 },
              thinking: { mode: 'effort', efforts: ['low', 'high'] },
            },
          ],
        },
      ],
    });
    expect(yaml).toContain('        contextWindow: 1000000');
    expect(yaml).toContain('        maxTokens: 128000');
    expect(yaml).toContain('        reasoning: true');
    expect(yaml).toContain('          - text');
    expect(yaml).toContain('        cost:');
    expect(yaml).toContain('          output: 30');
    expect(yaml).toContain('          efforts:');
    expect(yaml).toContain('            - high');
  });

  it('quotes values so hostile strings cannot break out of the YAML scalar', () => {
    const yaml = buildOmpModelsConfigYaml({
      providers: [{ ...BASE_PROVIDER, models: [{ id: 'm', name: 'a: \'b\' - evil' }] }],
    });
    // 单引号加倍,换行等控制字符在入口就被拒(见 requireText),因此单行恒单行。
    expect(yaml).toContain(`        name: 'a: ''b'' - evil'`);
    expect(yaml.split('\n').filter((line) => line.includes('evil')).length).toBe(1);
  });

  it('rejects a literal api key and other invalid provider fields', () => {
    const withSecret = { providers: [{ ...BASE_PROVIDER, apiKeyEnv: 'sk-ant-oat-01' }] };
    expect(() => buildOmpModelsConfigYaml(withSecret)).toThrow(/apiKeyEnv/);
    expect(() =>
      buildUnknown({ providers: [{ ...BASE_PROVIDER, id: 'bad id' }] }),
    ).toThrow(/provider id/);
    expect(() =>
      buildUnknown({ providers: [{ ...BASE_PROVIDER, baseUrl: 'ftp://x' }] }),
    ).toThrow(/baseUrl/);
    expect(() => buildUnknown({ providers: [{ ...BASE_PROVIDER, api: 'nope' }] })).toThrow(
      /api/,
    );
    expect(() =>
      buildUnknown({ providers: [{ ...BASE_PROVIDER, headers: { 'x evil': 'v' } }] }),
    ).toThrow(/header name/);
  });

  it('rejects duplicate providers, empty models and non-object input', () => {
    expect(() =>
      buildOmpModelsConfigYaml({ providers: [BASE_PROVIDER, BASE_PROVIDER] }),
    ).toThrow(/Duplicate/);
    expect(() =>
      buildUnknown({ providers: [{ ...BASE_PROVIDER, models: [] }] }),
    ).toThrow(/at least one model/);
    for (const value of [null, undefined, {}, { providers: [] }, { providers: 'x' }]) {
      expect(() => buildUnknown(value)).toThrow(/models config/);
    }
  });
});

describe('buildOmpCindyProvider', () => {
  it('pins the Cindy routing headers used by the compat proxy', () => {
    const provider = buildOmpCindyProvider({
      baseUrl: 'http://127.0.0.1:1117/v1',
      sessionId: 'session-1',
      sessionToken: 'token-1',
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(provider.id).toBe(OMP_CINDY_PROVIDER_ID);
    expect(provider.api).toBe('anthropic-messages');
    expect(provider.apiKeyEnv).toBe(OMP_CINDY_API_KEY_ENV);
    expect(provider.headers?.[OMP_CINDY_PROVIDER_ID_HEADER]).toBe('cindy');
    expect(provider.headers?.[OMP_CINDY_SESSION_ID_HEADER]).toBe('session-1');
    expect(provider.headers?.[OMP_CINDY_SESSION_TOKEN_HEADER]).toBe('token-1');
  });

  it('omits session headers when the host does not supply them', () => {
    const provider = buildOmpCindyProvider({
      baseUrl: 'http://127.0.0.1:1117/v1',
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(provider.headers?.[OMP_CINDY_SESSION_ID_HEADER]).toBeUndefined();
    expect(provider.headers?.[OMP_CINDY_SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  it('writes headers into the YAML without any secret handling shortcuts', () => {
    const yaml = buildOmpCindyModelsYaml({
      baseUrl: 'http://127.0.0.1:1117/v1',
      sessionId: 'session-1',
      sessionToken: 'token-1',
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(yaml).toContain('    headers:');
    expect(yaml).toContain(`      ${OMP_CINDY_SESSION_ID_HEADER}: 'session-1'`);
    expect(yaml).toContain(`      ${OMP_CINDY_SESSION_TOKEN_HEADER}: 'token-1'`);
    // apiKey 仍是 env 名,不因 headers 里出现字面量而退化。
    expect(yaml).toContain(`    apiKey: ${OMP_CINDY_API_KEY_ENV}`);
  });
});
