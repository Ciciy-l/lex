import { describe, expect, it } from 'vitest';

import {
  buildManagedProvider,
  displayHostForOrigin,
  isManagedInferenceUrl,
  normalizeInferenceBaseUrl,
  type ManagedCatalogModelInput,
} from '../provider.js';
import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../../shared/lexServerManagedModels.js';

const loopbackBase = 'http://127.0.0.1:3101/v1';
const httpsBase = 'https://lex.example.com/v1';

function model(
  overrides: Partial<ManagedCatalogModelInput> = {},
): ManagedCatalogModelInput {
  return {
    modelKey: 'm1',
    channelId: '11111111-1111-4111-8111-111111111111',
    name: 'Managed One',
    protocol: 'openai-chat',
    contextTokens: 128_000,
    outputTokens: 8_192,
    baseUrl: httpsBase,
    ...overrides,
  };
}

describe('normalizeInferenceBaseUrl', () => {
  it('accepts https /v1 and strips the trailing slash', () => {
    expect(normalizeInferenceBaseUrl('https://lex.example.com/v1/')).toEqual({
      baseUrl: 'https://lex.example.com/v1',
      origin: 'https://lex.example.com',
    });
  });

  it('allows loopback HTTP only when explicitly enabled', () => {
    expect(normalizeInferenceBaseUrl(loopbackBase, { allowLoopbackHttp: true })).toEqual({
      baseUrl: loopbackBase,
      origin: 'http://127.0.0.1:3101',
    });
    expect(normalizeInferenceBaseUrl('http://localhost:3101/v1', { allowLoopbackHttp: true })).not.toBeNull();
    expect(normalizeInferenceBaseUrl('http://[::1]:3101/v1', { allowLoopbackHttp: true })).not.toBeNull();
    // Packaged / default policy stays HTTPS-only even for loopback.
    expect(normalizeInferenceBaseUrl(loopbackBase)).toBeNull();
    expect(normalizeInferenceBaseUrl(loopbackBase, { allowLoopbackHttp: false })).toBeNull();
  });

  it('rejects non-loopback HTTP even in dev', () => {
    expect(normalizeInferenceBaseUrl('http://lex.example.com/v1', { allowLoopbackHttp: true })).toBeNull();
  });

  it('rejects userinfo, query, fragment and non-/v1 paths', () => {
    for (const value of [
      'https://user:pass@lex.example.com/v1',
      'https://lex.example.com/v1?x=1',
      'https://lex.example.com/v1#frag',
      'https://lex.example.com/api',
      'https://lex.example.com/v1/models',
      'not-a-url',
    ]) {
      expect(normalizeInferenceBaseUrl(value)).toBeNull();
    }
  });
});

describe('isManagedInferenceUrl', () => {
  it('accepts the base URL and the three exact inference endpoints', () => {
    for (const url of [
      httpsBase,
      `${httpsBase}/chat/completions`,
      `${httpsBase}/responses`,
      `${httpsBase}/messages`,
    ]) {
      expect(isManagedInferenceUrl(url, httpsBase)).toBe(true);
    }
    expect(isManagedInferenceUrl(`${loopbackBase}/chat/completions`, loopbackBase, {
      allowLoopbackHttp: true,
    })).toBe(true);
  });

  it('rejects other paths, cross-origin, userinfo, query and fragment', () => {
    for (const url of [
      `${httpsBase}/models`,
      `${httpsBase}/chat/completions/extra`,
      'https://attacker.example/v1/chat/completions',
      'https://user:pass@lex.example.com/v1/messages',
      `${httpsBase}/messages?x=1`,
      `${httpsBase}/messages#frag`,
      'http://lex.example.com/v1/messages',
    ]) {
      expect(isManagedInferenceUrl(url, httpsBase)).toBe(false);
    }
  });
});

describe('buildManagedProvider', () => {
  it('builds channel-id models with server metadata and Bearer-only auth', () => {
    const provider = buildManagedProvider({
      state: 'ready',
      origin: 'https://lex.example.com',
      baseUrl: httpsBase,
      models: [
        model(),
        model({
          modelKey: 'm2',
          channelId: '22222222-2222-4222-8222-222222222222',
          name: 'Claude Wire',
          protocol: 'anthropic-messages',
        }),
      ],
    });
    expect(provider.id).toBe(LEX_SERVER_MANAGED_PROVIDER_ID);
    expect(provider.source).toBe('user');
    expect(provider.auth.method).toBe('managed');
    expect(provider.managed).toMatchObject({
      provider: 'lex-server',
      host: 'lex.example.com',
      state: 'ready',
    });
    expect(provider.agents).toEqual(['claude-code', 'codex', 'pi']);
    expect(provider.channel).toMatchObject({
      supplierId: LEX_SERVER_MANAGED_PROVIDER_ID,
      protocols: ['openai-chat', 'anthropic-messages'],
    });
    const chat = provider.models.codex?.[0];
    expect(chat).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Managed One',
      contextWindow: 128_000,
      maxOutput: 8_192,
      route: { baseUrl: httpsBase, wireProtocol: 'openai-chat' },
    });
    const messages = provider.models['claude-code']?.find(
      (entry) => entry.id === '22222222-2222-4222-8222-222222222222',
    );
    expect(messages?.route).toMatchObject({
      baseUrl: httpsBase,
      wireProtocol: 'anthropic-messages',
      // `/v1` base + `/messages`, never `/v1/v1/messages`.
      requestPath: '/messages',
    });
    // `/messages` forbids dual auth headers; x-api-key is removed and Bearer remains.
    expect(provider.routing['claude-code']?.headerDelete).toEqual(['x-api-key']);
    expect(provider.routing.codex?.headerDelete).toEqual(['x-api-key']);
    expect(provider.routing.pi?.headerDelete).toEqual(['x-api-key']);
  });

  it('accepts loopback HTTP only with the dev flag, for both credential and model base URLs', () => {
    const allowed = buildManagedProvider({
      state: 'ready',
      origin: 'http://127.0.0.1:3101',
      baseUrl: loopbackBase,
      models: [model({ baseUrl: loopbackBase })],
      allowLoopbackHttp: true,
    });
    expect(allowed.agents).toEqual(['claude-code', 'codex', 'pi']);
    expect(allowed.models.codex?.[0]?.route?.baseUrl).toBe(loopbackBase);

    const denied = buildManagedProvider({
      state: 'ready',
      origin: 'http://127.0.0.1:3101',
      baseUrl: loopbackBase,
      models: [model({ baseUrl: loopbackBase })],
    });
    expect(denied.agents).toEqual([]);
    expect(denied.models).toEqual({});
  });

  it('drops models on a different origin instead of re-targeting the credential', () => {
    const provider = buildManagedProvider({
      state: 'ready',
      origin: 'https://lex.example.com',
      baseUrl: httpsBase,
      models: [
        model(),
        model({
          modelKey: 'evil',
          channelId: '33333333-3333-4333-8333-333333333333',
          baseUrl: 'https://attacker.example/v1',
        }),
      ],
    });
    expect(provider.models.codex?.map((entry) => entry.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('keeps the display row non-routable when the catalog is empty or not ready', () => {
    const display = buildManagedProvider({
      state: 'not-entitled',
      origin: 'https://lex.example.com',
      baseUrl: httpsBase,
      models: [],
    });
    expect(display.agents).toEqual([]);
    expect(display.routing).toEqual({});
    expect(display.managed).toMatchObject({ state: 'not-entitled' });
    expect(display.models).toEqual({});
    // Fail closed: an explicit managed-session route sees a channel with no
    // routing and gets the disabled/503 decision instead of a default upstream.
    expect(display.channel).toMatchObject({
      supplierId: LEX_SERVER_MANAGED_PROVIDER_ID,
      id: `${LEX_SERVER_MANAGED_PROVIDER_ID}-channel`,
    });
  });

  it('dedupes duplicate channel ids and ignores unsupported protocols', () => {
    const provider = buildManagedProvider({
      state: 'ready',
      origin: 'https://lex.example.com',
      baseUrl: httpsBase,
      models: [
        model(),
        model(),
        model({
          modelKey: 'google',
          channelId: '44444444-4444-4444-8444-444444444444',
          // Runtime defense: a catalog entry outside the supported wire set is
          // dropped even if a future server sends it.
          protocol: 'google-generative-ai' as unknown as ManagedCatalogModelInput['protocol'],
        }),
      ],
    });
    expect(provider.models.codex).toHaveLength(1);
  });
});

describe('displayHostForOrigin', () => {
  it('keeps host and port but never path or userinfo', () => {
    expect(displayHostForOrigin('https://lex.example.com:8443')).toBe('lex.example.com:8443');
    expect(displayHostForOrigin('http://127.0.0.1:3101')).toBe('127.0.0.1:3101');
  });
});
