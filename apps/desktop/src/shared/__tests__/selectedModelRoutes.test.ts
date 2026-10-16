import { describe, expect, it } from 'vitest';
import { effectiveSourceIdForModel, type ProviderView } from '@cindy/model-providers';
import { resolveSelectedModelRoutes } from '../selectedModelRoutes';

const selected = { harness: 'codex' as const, providerId: 'my-connection', model: 'user-chosen-model', effort: 'high', fastMode: false };
const providers = [{ id: 'my-connection', source: 'user', connected: true, agents: ['codex'], routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
  models: { codex: ['gpt-5.6-sol', selected.model].map(id => ({ id, mode: 'chat', status: 'active' })) },
}] as unknown as ProviderView[];
const args = { providers, providersLoading: false, availableAgents: new Set(['codex'] as const), availableAgentsLoaded: true };

describe('ordinary tasks preserve the available selected model route', () => {
  it('uses the exact selected route and tuning without adding catalog recommendations', () => {
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: selected })).toEqual([selected]);
  });
  it('resolves a legacy implicit source exactly like ordinary new tasks, without changing the model', () => {
    const preferredRoute = { ...selected, providerId: null };
    const providerId = effectiveSourceIdForModel(providers, null, selected.model, 'codex');
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute })).toEqual([{ ...selected, providerId }]);
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute, isModelEnabled: () => false })).toEqual([]);
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: { ...preferredRoute, model: 'removed' } })).toEqual([]);
  });
  it('resolves implicit sources only among enabled connections offering the selected model', () => {
    const sameModel = [
      { ...providers[0], id: 'openai' },
      { ...providers[0], id: 'other-connection' },
    ] as ProviderView[];
    expect(resolveSelectedModelRoutes({ ...args, providers: sameModel, preferredRoute: { ...selected, providerId: null },
      isModelEnabled: (_agent, providerId) => providerId !== 'openai' }))
      .toEqual([{ ...selected, providerId: 'other-connection' }]);
    expect(resolveSelectedModelRoutes({ ...args, providers: sameModel, preferredRoute: { ...selected, providerId: 'openai' },
      isModelEnabled: (_agent, providerId) => providerId !== 'openai' })).toEqual([]);
  });
  it('returns empty before preferences or catalog/runtime readiness arrive', () => {
    expect(resolveSelectedModelRoutes(args)).toEqual([]);
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: selected, providersLoading: true })).toEqual([]);
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: selected, availableAgentsLoaded: false })).toEqual([]);
  });
  it('never substitutes another enabled model when the selected model is disabled or removed', () => {
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: selected, isModelEnabled: (_a, _p, m) => m.id !== selected.model })).toEqual([]);
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: { ...selected, model: 'removed-model' } })).toEqual([]);
  });
  it('requires the selected connection and engine to remain available', () => {
    for (const patch of [{ connected: false }, { suspended: true }, { modelDiscoveryFailure: 'offline' }]) {
      expect(resolveSelectedModelRoutes({ ...args, preferredRoute: selected, providers: [{ ...providers[0]!, ...patch } as ProviderView] })).toEqual([]);
    }
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: selected, availableAgents: new Set() })).toEqual([]);
    expect(resolveSelectedModelRoutes({ ...args, preferredRoute: { ...selected, providerId: 'other-account' } })).toEqual([]);
  });
  it('passes legacy visibility aliases through without replacing a hidden explicit selection', () => {
    const migrated = providers.map(provider => ({ ...provider, models: { ...provider.models,
      codex: provider.models.codex?.map(model => ({ ...model, defaultEnabled: true,
        visibilityAliases: model.id === selected.model ? ['legacy-source'] : [] })),
    } }));
    expect(resolveSelectedModelRoutes({ ...args, providers: migrated, preferredRoute: selected,
      isModelEnabled: (_agent, _providerId, model) =>
        !model.visibilityAliases?.includes('legacy-source') && model.defaultEnabled !== false,
    })).toEqual([]);
    expect(resolveSelectedModelRoutes({ ...args, providers: migrated, preferredRoute: selected })).toEqual([selected]);
  });
});
