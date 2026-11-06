import { afterEach, describe, expect, it } from 'vitest';

import type {
  CustomProviderConfig,
  Provider,
  ProviderRuntimeModelConfig,
  RoutingDescriptor,
} from '@cindy/model-providers';

import {
  getActiveCatalog,
  setCustomProviderConfigs,
  setCustomProviders,
  setManagedProviders,
} from '../active-catalog.js';
import {
  __testingRouteApiKey,
  setCustomProviderKeyReader,
} from '../provider-route.js';
import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../../shared/lexServerManagedModels.js';

function route(channelId: string): RoutingDescriptor {
  return {
    upstream: 'https://custom.example/v1',
    authStrategy: 'api-key-header',
    wireProtocol: 'openai-chat',
    channelCredential: { channelId, protocol: 'openai-chat' },
  };
}

function managedProvider(): Provider {
  return {
    id: LEX_SERVER_MANAGED_PROVIDER_ID,
    name: 'Lex Server',
    source: 'user',
    agents: ['codex'],
    auth: { method: 'managed' },
    routing: {
      codex: {
        upstream: 'http://127.0.0.1:3101/v1',
        authStrategy: 'api-key-header',
      },
    },
    models: {},
    managed: {
      provider: 'lex-server',
      host: '127.0.0.1:3101',
      state: 'ready',
    },
  };
}

afterEach(() => {
  setManagedProviders([]);
  setCustomProviders([]);
  setCustomProviderConfigs([]);
  setCustomProviderKeyReader(() => null);
});

describe('reserved managed identity in provider routing', () => {
  it('never returns the managed credential for another provider\'s channel id', () => {
    setManagedProviders([managedProvider()]);
    setCustomProviderKeyReader((id) => (id === LEX_SERVER_MANAGED_PROVIDER_ID ? 'managed-secret' : null));
    // Legacy supplier `custom-alias` whose channel id aliases the managed id.
    expect(
      __testingRouteApiKey('custom-alias', 'codex', route(LEX_SERVER_MANAGED_PROVIDER_ID)),
    ).toBeNull();
  });

  it('still resolves the actual managed provider and ordinary custom channels', () => {
    setManagedProviders([managedProvider()]);
    setCustomProviderKeyReader((id) => {
      if (id === LEX_SERVER_MANAGED_PROVIDER_ID) return 'managed-secret';
      if (id === 'normal-channel') return 'normal-secret';
      return null;
    });
    expect(
      __testingRouteApiKey(LEX_SERVER_MANAGED_PROVIDER_ID, 'codex', {
        upstream: 'http://127.0.0.1:3101/v1',
        authStrategy: 'api-key-header',
      }),
    ).toBe('managed-secret');
    expect(__testingRouteApiKey('custom-alias', 'codex', route('normal-channel')))
      .toBe('normal-secret');
  });

  it('returns null when a reserved id has no managed catalog entry', () => {
    setManagedProviders([]);
    setCustomProviderKeyReader((id) => (id === LEX_SERVER_MANAGED_PROVIDER_ID ? 'managed-secret' : null));
    expect(
      __testingRouteApiKey(LEX_SERVER_MANAGED_PROVIDER_ID, 'codex', {
        upstream: 'http://127.0.0.1:3101/v1',
        authStrategy: 'api-key-header',
      }),
    ).toBeNull();
  });
});

describe('reserved managed identity in catalog projection', () => {
  function config(
    id: string,
    channelId: string,
    models: ProviderRuntimeModelConfig[] = [],
  ): CustomProviderConfig {
    return {
      id,
      name: id,
      runtimes: {},
      channels: {
        version: 1,
        channels: [{
          id: channelId,
          name: channelId,
          protocols: {
            'openai-chat': {
              baseUrl: 'https://custom.example/v1',
              models: models.length > 0 ? models : [{ id: 'm', name: 'M' }],
            },
          },
        }],
      },
    };
  }

  it('drops a legacy config whose channel id aliases the managed provider', () => {
    setCustomProviderConfigs([
      config('custom-alias', LEX_SERVER_MANAGED_PROVIDER_ID),
      config('normal-provider', 'normal-channel'),
    ]);
    const providers = getActiveCatalog().providers;
    expect(providers.some((provider) => provider.id === 'custom-alias')).toBe(false);
    expect(
      providers.some((provider) => provider.channel?.id === LEX_SERVER_MANAGED_PROVIDER_ID),
    ).toBe(false);
    expect(
      providers.some((provider) => provider.channel?.supplierId === 'normal-provider'),
    ).toBe(true);
  });

  it('drops a direct provider projection with a reserved channel id', () => {
    setCustomProviders([{
      id: 'direct-alias',
      name: 'Direct',
      source: 'user',
      agents: [],
      auth: { method: 'apiKey' },
      routing: {},
      models: {},
      channel: {
        supplierId: 'direct-alias',
        id: LEX_SERVER_MANAGED_PROVIDER_ID,
        name: 'Alias',
        protocols: ['openai-chat'],
      },
    }]);
    expect(
      getActiveCatalog().providers.some((provider) => provider.id === 'direct-alias'),
    ).toBe(false);
  });
});
