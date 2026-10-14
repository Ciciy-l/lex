import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUserProviderChannels,
  channelProtocolProviderId,
  type CustomProviderConfig,
} from '@cindy/model-providers';
import { setCustomProviders } from '../active-catalog.js';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store.js';
import {
  beginProviderRouteMutation,
  providerRoutingForModel,
  resolveProviderRouteDecision,
  resolveSessionRouteDecision,
  setCustomProviderKeyReader,
  setCustomProviderHeaderReader,
  captureCodexLocalAuthPolicy,
  resolveSessionRoute,
} from '../provider-route.js';

afterEach(() => {
  setCustomProviders([]);
  clearSessionProvider('channel-task');
  setCustomProviderKeyReader(() => null);
  setCustomProviderHeaderReader(() => null);
});
const config: CustomProviderConfig = {
  id: 'supplier',
  name: 'Supplier',
  runtimes: {},
  channels: {
    version: 1,
    channels: [
      {
        id: 'channel-a',
        name: 'A',
        protocols: {
          'openai-responses': {
            baseUrl: 'https://responses.example',
            models: [{ id: 'same', name: 'Same' }],
          },
          'google-generative-ai': {
            baseUrl: 'https://google.example/v1beta',
            models: [{ id: 'same', name: 'Same', api: 'google-generative-ai' }],
          },
        },
      },
    ],
  },
};
describe('channel protocol dispatch', () => {
  it.each(['claude-code', 'codex', 'pi', 'omp'] as const)(
    'uses the Google credential for %s, including header-only channels',
    async (agent) => {
      setCustomProviders(buildUserProviderChannels(config));
      setCustomProviderKeyReader(() => null);
      setCustomProviderHeaderReader((_id, _agent, protocol) =>
        protocol === 'google-generative-ai' ? { 'X-Goog-Api-Key': 'header-google' } : null,
      );
      const result = await resolveProviderRouteDecision(
        channelProtocolProviderId('channel-a', 'google-generative-ai'),
        agent,
        null,
        'same',
      );
      expect(result?.decision?.headerOverride).toMatchObject({ 'x-goog-api-key': 'header-google' });
      expect(result?.decision?.headerOverride?.authorization).toBeUndefined();
      expect(result?.decision?.headerDelete).toEqual(
        expect.arrayContaining(['authorization', 'x-api-key']),
      );
    },
  );
  it('uses native protocol in auto mode and respects fixed protocol across engines', () => {
    const providers = buildUserProviderChannels(config);
    const auto = providers.find((provider) => provider.id === 'channel-a')!;
    const fixed = providers.find(
      (provider) => provider.id === channelProtocolProviderId('channel-a', 'google-generative-ai'),
    )!;
    expect(providerRoutingForModel(auto, 'codex', 'same')).toMatchObject({
      upstream: 'https://responses.example',
      channelCredential: { protocol: 'openai-responses' },
    });
    expect(providerRoutingForModel(fixed, 'codex', 'same')).toMatchObject({
      upstream: 'https://google.example/v1beta',
      channelCredential: { protocol: 'google-generative-ai' },
    });
    expect(providerRoutingForModel(auto, 'omp', 'same')).toMatchObject({
      wireProtocol: 'google-generative-ai',
    });
    expect(providerRoutingForModel(fixed, 'claude-code', 'missing')).toBeNull();
  });
  it('injects only the selected Google slot and invalidates a decision after editing', async () => {
    const id = channelProtocolProviderId('channel-a', 'google-generative-ai');
    setCustomProviders(buildUserProviderChannels(config));
    setCustomProviderKeyReader((channel, _agent, protocol) =>
      channel === 'channel-a' && protocol === 'google-generative-ai' ? 'google-only' : 'wrong',
    );
    const result = await resolveProviderRouteDecision(id, 'omp', null, 'same');
    expect(result?.decision?.headerOverride?.['x-goog-api-key']).toBe('google-only');
    expect(result?.decision?.dispatchGenerationValid?.()).toBe(true);
    const finish = beginProviderRouteMutation('supplier');
    expect(result?.decision?.dispatchGenerationValid?.()).toBe(false);
    finish.commit();
    finish();
    expect(result?.decision?.dispatchGenerationValid?.()).toBe(false);
  });
  it('refuses removed explicit channel routes instead of choosing another supplier', async () => {
    setSessionProvider('channel-task', 'removed-channel');
    const result = await resolveSessionRouteDecision(
      'channel-task',
      'codex',
      'gateway-key',
      'same',
    );
    expect(result?.localHandler).toBeTypeOf('function');
    expect(result?.upstreamOverride).toBeUndefined();
  });
  it('resumes a channel start when its supplier mutation finishes', async () => {
    setCustomProviders(buildUserProviderChannels(config));
    const finish = beginProviderRouteMutation('supplier');
    try {
      const policy = captureCodexLocalAuthPolicy('channel-a', 'same');
      finish.commit();
      finish();
      await expect(policy).resolves.toMatchObject({ policy: 'isolated' });
    } finally {
      finish();
    }
  });
  it('invalidates a local bridge after a channel switch or credential edit', async () => {
    setCustomProviders(buildUserProviderChannels(config));
    setSessionProvider('channel-task', 'channel-a');
    const route = await resolveSessionRoute('channel-task', 'codex', 'same');
    expect(route?.isCurrent?.()).toBe(true);
    setSessionProvider(
      'channel-task',
      channelProtocolProviderId('channel-a', 'google-generative-ai'),
    );
    expect(route?.isCurrent?.()).toBe(false);
    setSessionProvider('channel-task', 'channel-a');
    const finish = beginProviderRouteMutation('supplier');
    finish.commit();
    finish();
    expect(route?.isCurrent?.()).toBe(false);
  });
});
