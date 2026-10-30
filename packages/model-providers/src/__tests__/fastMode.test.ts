import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '../user-provider.js';
import { modelSupportsFastMode, sessionModelSupportsFastMode } from '../registry.js';
import { supportsFastServiceTier, isFastServiceTier } from '../fastMode.js';
import type { AgentKind, ProviderWireProtocol } from '../types.js';

describe('Fast request intent versus provider declarations', () => {
  it.each(['codex', 'claude-code', 'pi'] as const)('%s permits explicit service tiers on saved Responses and Chat routes', agent => {
    for (const wireProtocol of ['openai-responses', 'openai-chat'] as const) {
      for (const declared of [undefined, false, true]) {
        const saved = { id: 'existing-relay', name: 'Existing relay', runtimes: { [agent]: {
          baseUrl: 'https://relay.example/v1', wireProtocol, models: [{ id: 'private-alias', name: 'Alias',
            ...(declared === undefined ? {} : { discoveredMetadata: { supportsFastMode: declared } }),
          }],
        } } };
        const provider = buildUserProvider(JSON.parse(JSON.stringify(saved)));
        const before = JSON.stringify(provider);
        expect(modelSupportsFastMode(provider, 'private-alias', agent)).toBe(true);
        expect(sessionModelSupportsFastMode([{ ...provider, connected: true }], provider.id, 'private-alias', agent)).toBe(true);
        expect(JSON.stringify(provider)).toBe(before);
        expect(provider.models[agent]?.[0]?.supportsFastMode).toBe(declared);
        expect(modelSupportsFastMode(provider, 'missing', agent)).toBe(false);
      }
    }
  });

  it('keeps native Anthropic, non-tier APIs and OMP capability gates', () => {
    for (const agent of ['claude-code', 'codex', 'pi', 'omp'] as AgentKind[]) {
      for (const wireProtocol of ['anthropic-messages', 'google-generative-ai'] as ProviderWireProtocol[]) {
        const provider = buildUserProvider({ id: 'bridge', name: 'Bridge', runtimes: { [agent]: {
          baseUrl: 'https://relay.example/v1', wireProtocol, models: [{ id: 'private-model', name: 'Private' }],
        } } });
        expect(modelSupportsFastMode(provider, 'private-model', agent)).toBe(false);
      }
    }
    expect(modelSupportsFastMode(undefined, 'anything', 'codex')).toBe(false);
  });

  it('honors per-model transport overrides and native API precedence', () => {
    const provider = buildUserProvider({ id: 'mixed', name: 'Mixed', runtimes: { codex: {
      baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses',
      models: [{ id: 'private-model', name: 'Private' }],
    } } });
    const model = provider.models.codex![0]!;
    model.codexCompatibilityWireProtocol = 'anthropic-messages';
    expect(modelSupportsFastMode(provider, model.id, 'codex')).toBe(false);
    model.route = { baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-chat' };
    expect(modelSupportsFastMode(provider, model.id, 'codex')).toBe(true);
    model.api = 'google-generative-ai';
    expect(modelSupportsFastMode(provider, model.id, 'codex')).toBe(false);
  });

  it('does not turn xAI subscription model mapping into a public API tier', () => {
    const provider = buildUserProvider({ id: 'xai-public', name: 'Public', runtimes: { codex: {
      baseUrl: 'https://api.x.ai/v1', wireProtocol: 'openai-responses',
      models: [{ id: 'grok-fixture', name: 'Grok' }],
    } } });
    expect(modelSupportsFastMode(provider, 'grok-fixture', 'codex')).toBe(false);
    expect(supportsFastServiceTier('anthropic-messages')).toBe(false);
    expect(supportsFastServiceTier('azure-openai-responses')).toBe(true);
    expect(['priority', 'fast', 'default', undefined].map(isFastServiceTier)).toEqual([true, true, false, false]);
  });

  it('keeps official Codex subscription entitlements native-owned', () => {
    const provider = buildUserProvider({ id: 'subscription', name: 'Subscription',
      auth: { method: 'oauth', native: 'codex' }, runtimes: {} });
    provider.models.codex = [{ id: 'fixture', name: 'Fixture', contextWindow: 128000,
      efforts: [], defaultEffort: null, supportsFastMode: false }];
    expect(modelSupportsFastMode(provider, 'fixture', 'codex')).toBe(false);
    provider.models.codex[0]!.supportsFastMode = true;
    expect(modelSupportsFastMode(provider, 'fixture', 'codex')).toBe(true);
  });

  it('does not invent a Responses route for old sparse snapshots', () => {
    const provider = buildUserProvider({ id: 'legacy', name: 'Legacy', runtimes: { codex: {
      baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses',
      models: [{ id: 'private', name: 'Private', discoveredMetadata: { supportsFastMode: false } }],
    } } });
    const sparse = JSON.parse(JSON.stringify(provider));
    delete sparse.auth;
    delete sparse.routing;
    delete sparse.models.codex[0].codexCompatibilityWireProtocol;
    delete sparse.models.codex[0].route;
    expect(modelSupportsFastMode(sparse, 'private', 'codex')).toBe(false);
    sparse.models.codex[0].supportsFastMode = true;
    expect(modelSupportsFastMode(sparse, 'private', 'codex')).toBe(true);
    expect(modelSupportsFastMode(provider, 'private', 'codex')).toBe(true);
  });
});
