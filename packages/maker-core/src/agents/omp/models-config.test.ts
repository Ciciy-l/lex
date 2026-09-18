import { describe, expect, it } from 'vitest';
import {
  buildOmpCindyModelsYaml,
  buildOmpCindyProvider,
  buildOmpModelsConfigYaml,
  OMP_CINDY_API_KEY_ENV,
  OMP_CINDY_PROVIDER_ID,
  OMP_CINDY_PROVIDER_ID_HEADER,
  OMP_CINDY_SESSION_ID_HEADER,
  OMP_CINDY_SESSION_TOKEN_ENV,
  ompApiForWireProtocol,
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
  it('pins the non-sensitive routing headers used by the compat proxy', () => {
    const provider = buildOmpCindyProvider({
      baseUrl: 'http://127.0.0.1:1117/v1',
      sessionId: 'session-1',
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(provider.id).toBe(OMP_CINDY_PROVIDER_ID);
    expect(provider.api).toBe('anthropic-messages');
    expect(provider.apiKeyEnv).toBe(OMP_CINDY_API_KEY_ENV);
    expect(provider.headers?.[OMP_CINDY_PROVIDER_ID_HEADER]).toBe('cindy');
    expect(provider.headers?.[OMP_CINDY_SESSION_ID_HEADER]).toBe('session-1');
    // 会话 token 只能走 apiKeyEnv 通道,headers 里绝不能出现任何 token 头。
    expect(Object.keys(provider.headers ?? {})).not.toContain(
      'x-cindy-omp-session-token',
    );
  });

  it('routes the session token through apiKeyEnv instead of a header', () => {
    const provider = buildOmpCindyProvider({
      baseUrl: 'http://127.0.0.1:1117/v1',
      sessionId: 'session-1',
      // T04 约定:token 由 host 注入该 env,OMP 以 Authorization: Bearer <token> 发出。
      apiKeyEnv: OMP_CINDY_SESSION_TOKEN_ENV,
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(provider.apiKeyEnv).toBe('CINDY_OMP_SESSION_TOKEN');
    const yaml = buildOmpModelsConfigYaml({ providers: [provider] });
    expect(yaml).toContain('    apiKey: CINDY_OMP_SESSION_TOKEN');
    expect(yaml).not.toContain('x-cindy-omp-session-token');
  });

  it('omits session headers when the host does not supply them', () => {
    const provider = buildOmpCindyProvider({
      baseUrl: 'http://127.0.0.1:1117/v1',
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(provider.headers?.[OMP_CINDY_SESSION_ID_HEADER]).toBeUndefined();
  });

  it('refuses env-var syntax in header values because OMP never interpolates them', () => {
    // v18.1.18 实测:header 值原样发出,$VAR / ${VAR} 都不会被替换 —— 会骗人,直接拒。
    for (const value of ['$SPIKE_TOKEN', '${SPIKE_TOKEN}', 'prefix ${SPIKE_TOKEN}']) {
      expect(() =>
        buildOmpCindyProvider({
          baseUrl: 'http://127.0.0.1:1117/v1',
          headers: { 'x-cindy-omp-note': value },
          models: [{ id: 'MiniMax-M2' }],
        }),
      ).toThrow(/does not interpolate/);
      expect(() =>
        buildOmpModelsConfigYaml({
          providers: [BASE_PROVIDER, { ...BASE_PROVIDER, id: 'other', headers: { h: value } }],
        }),
      ).toThrow(/does not interpolate/);
    }
  });

  it('still allows ordinary non-secret header values', () => {
    const yaml = buildOmpCindyModelsYaml({
      baseUrl: 'http://127.0.0.1:1117/v1',
      sessionId: 'session-1',
      headers: { 'x-cindy-omp-channel': 'desktop' },
      models: [{ id: 'MiniMax-M2' }],
    });
    expect(yaml).toContain('    headers:');
    expect(yaml).toContain(`      ${OMP_CINDY_SESSION_ID_HEADER}: 'session-1'`);
    expect(yaml).toContain(`      x-cindy-omp-channel: 'desktop'`);
    // apiKey 仍是 env 名,不因 headers 里出现字面量而退化。
    expect(yaml).toContain(`    apiKey: ${OMP_CINDY_API_KEY_ENV}`);
  });
});

describe('ompApiForWireProtocol', () => {
  it('maps Cindy wire protocols onto the api values OMP actually accepts', () => {
    expect(ompApiForWireProtocol('anthropic-messages')).toBe('anthropic-messages');
    expect(ompApiForWireProtocol('openai-responses')).toBe('openai-responses');
  });

  it('translates openai-chat instead of passing it through', () => {
    // Cindy 叫 openai-chat,OMP 认 openai-completions。透传会让整份 models.yml 被拒
    // (OMP 报 Unknown provider),所以这条断言守的是「必须翻译」而不是「值长什么样」。
    expect(ompApiForWireProtocol('openai-chat')).toBe('openai-completions');
    expect(ompApiForWireProtocol('openai-chat')).not.toBe('openai-chat');
  });
});
