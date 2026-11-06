import { describe, expect, it } from 'vitest';

import type { Provider } from '@cindy/model-providers';

import {
  buildManagedPiProjection,
  MANAGED_PI_API_KEY_ENV,
  managedProtocolToPiApi,
} from '../piProjection.js';
import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../../shared/lexServerManagedModels.js';

function provider(
  overrides: Partial<Provider> = {},
  models: Provider['models'] = {
    pi: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Managed Chat',
        contextWindow: 128_000,
        maxOutput: 8_192,
        efforts: [],
        defaultEffort: null,
        route: {
          baseUrl: 'http://127.0.0.1:3101/v1',
          wireProtocol: 'openai-chat',
        },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Managed Messages',
        contextWindow: 64_000,
        efforts: [],
        defaultEffort: null,
        route: {
          baseUrl: 'http://127.0.0.1:3101/v1',
          wireProtocol: 'anthropic-messages',
        },
      },
    ],
  },
): Provider {
  return {
    id: LEX_SERVER_MANAGED_PROVIDER_ID,
    name: 'Lex Server',
    source: 'user',
    agents: ['pi'],
    auth: { method: 'managed' },
    routing: {},
    models,
    managed: {
      provider: 'lex-server',
      host: '127.0.0.1:3101',
      state: 'ready',
    },
    ...overrides,
  };
}

describe('buildManagedPiProjection', () => {
  it('maps protocols and uses only a placeholder key, never a credential', () => {
    const projection = buildManagedPiProjection({
      provider: provider(),
      isRemote: false,
      localEndpoint: 'http://127.0.0.1:4567',
      placeholderKey: 'placeholder-key',
      headers: { 'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID' },
    });
    expect(projection).not.toBeNull();
    expect(projection!.env).toEqual({ [MANAGED_PI_API_KEY_ENV]: 'placeholder-key' });
    expect(projection!.spec.models.map((model) => model.api)).toEqual([
      'openai-completions',
      'anthropic-messages',
    ]);
    expect(projection!.spec.api).toBe('openai-completions');
    expect(projection!.spec.baseUrl).toBe('http://127.0.0.1:4567');
    expect(projection!.spec.apiKeyEnvVar).toBe(MANAGED_PI_API_KEY_ENV);
    expect(JSON.stringify(projection)).not.toContain('cred-');
  });

  it('excludes remote Pi and non-ready providers', () => {
    for (const projection of [
      buildManagedPiProjection({
        provider: provider(),
        isRemote: true,
        localEndpoint: 'http://127.0.0.1:4567',
        placeholderKey: 'placeholder-key',
        headers: {},
      }),
      buildManagedPiProjection({
        provider: provider({ managed: { provider: 'lex-server', host: 'h', state: 'unavailable' } }),
        isRemote: false,
        localEndpoint: 'http://127.0.0.1:4567',
        placeholderKey: 'placeholder-key',
        headers: {},
      }),
      buildManagedPiProjection({
        provider: provider({ id: 'other' }),
        isRemote: false,
        localEndpoint: 'http://127.0.0.1:4567',
        placeholderKey: 'placeholder-key',
        headers: {},
      }),
    ]) {
      expect(projection).toBeNull();
    }
  });

  it('maps only supported protocols and drops the rest', () => {
    expect(managedProtocolToPiApi('openai-chat')).toBe('openai-completions');
    expect(managedProtocolToPiApi('openai-responses')).toBe('openai-responses');
    expect(managedProtocolToPiApi('anthropic-messages')).toBe('anthropic-messages');
    expect(managedProtocolToPiApi('google-generative-ai')).toBeNull();

    const projection = buildManagedPiProjection({
      provider: provider({}, {
        pi: [{
          id: 'unsupported',
          name: 'Unsupported',
          contextWindow: 1,
          efforts: [],
          defaultEffort: null,
          route: {
            baseUrl: 'http://127.0.0.1:3101/v1',
            wireProtocol: 'google-generative-ai',
          },
        }],
      }),
      isRemote: false,
      localEndpoint: 'http://127.0.0.1:4567',
      placeholderKey: 'placeholder-key',
      headers: {},
    });
    expect(projection).toBeNull();
  });
});
