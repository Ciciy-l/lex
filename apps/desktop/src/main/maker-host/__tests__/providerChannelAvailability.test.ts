import { describe, expect, it } from 'vitest';
import { buildUserProviderChannels, type CustomProviderConfig } from '@cindy/model-providers';
import {
  hasCustomProviderCredential,
  projectChannelConnectionAvailability,
} from '../provider-connection-state.js';
import { publicProviderView } from '../provider-public-view.js';

const config: CustomProviderConfig = {
  id: 'supplier',
  name: 'Supplier',
  runtimes: {},
  channels: {
    version: 1,
    channels: [
      {
        id: 'channel',
        name: 'Primary',
        protocols: {
          'openai-responses': { baseUrl: 'https://a.example', models: [{ id: 'a', name: 'A' }] },
          'google-generative-ai': {
            baseUrl: 'https://b.example',
            headers: { 'x-goog-api-key': 'secret' },
            models: [{ id: 'b', name: 'B' }],
          },
        },
      },
    ],
  },
};
describe('channel readiness and public projection', () => {
  it('keeps missing protocol credentials out of new selections without disabling the whole channel', () => {
    const provider = { ...buildUserProviderChannels(config)[0], connected: true };
    const readRoute = (_provider: typeof provider, _agent: unknown, model: string | undefined) => ({
      upstream: 'https://a.example',
      authStrategy: 'api-key-header' as const,
      channelCredential: {
        channelId: 'channel',
        protocol: model === 'b' ? ('google-generative-ai' as const) : ('openai-responses' as const),
      },
    });
    const key = (_id: string, _agent: unknown, protocol: string | undefined) =>
      protocol === 'google-generative-ai' ? 'key-b' : null;
    const route = (
      p: Parameters<typeof hasCustomProviderCredential>[0],
      a: Parameters<typeof readRoute>[1],
      m: string | undefined,
    ) => readRoute({ ...p, connected: true }, a, m);
    expect(hasCustomProviderCredential(provider, key, route)).toBe(true);
    const view = projectChannelConnectionAvailability(provider, key, route);
    expect(view.models.codex?.find((model) => model.id === 'a')).toMatchObject({
      credentialUnavailable: true,
    });
    expect(view.models.codex?.find((model) => model.id === 'b')).toMatchObject({
      credentialUnavailable: false,
    });
    expect(view.suspended).toBeUndefined();
  });
  it('never sends secrets or private channel records to a paired device', () => {
    const provider = { ...buildUserProviderChannels(config)[0], connected: true };
    const publicView = publicProviderView(provider);
    expect(publicView.channel).toMatchObject({ id: 'channel', supplierId: 'supplier' });
    expect(publicView.channelConfig).toBeUndefined();
    expect(publicView.customConfig).toBeUndefined();
    expect(JSON.stringify(publicView)).not.toContain('secret');
    const local = publicProviderView(provider, true);
    expect(local.customConfig?.channels).toBeDefined();
    expect(JSON.stringify(local)).not.toContain('secret');
  });
});
