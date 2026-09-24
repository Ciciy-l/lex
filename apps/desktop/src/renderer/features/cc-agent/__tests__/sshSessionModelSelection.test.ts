import { describe, expect, it } from 'vitest';
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import {
  isSameSshSessionModelSelection,
  resolveSshSessionModelSelection,
} from '../sshSessionModelSelection';

function model(id: string, patch: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    ...patch,
  };
}

function provider(
  id: string,
  models: CatalogModel[],
  agent: AgentKind = 'codex',
  nativeCodex = false,
): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    connected: true,
    agents: [agent],
    auth: { method: nativeCodex ? 'oauth' : 'apiKey' },
    routing: {
      [agent]: {
        upstream: nativeCodex ? 'https://chatgpt.com/backend-api/codex' : 'https://example.test',
        authStrategy: nativeCodex ? 'oauth-passthrough' : 'api-key-header',
      },
    },
    models: { [agent]: models },
  };
}

function resolve(
  providers: ProviderView[],
  patch: Partial<Parameters<typeof resolveSshSessionModelSelection>[0]> = {},
) {
  return resolveSshSessionModelSelection({
    providers,
    loading: false,
    loadFailed: false,
    agentKind: 'codex',
    preferred: { model: 'selected-model', effort: 'medium', fastMode: false },
    ...patch,
  });
}

describe('SSH native session model selection', () => {
  it('pins the selected Codex model to the connected OpenAI subscription provider', () => {
    expect(resolve([provider('openai', [model('selected-model')], 'codex', true)])).toMatchObject({
      ok: true,
      model: 'selected-model',
      providerId: 'openai',
    });
  });

  it('does not replace a missing or SSH-unroutable explicit model', () => {
    expect(resolve([provider('openai', [model('another-model')], 'codex', true)])).toEqual({
      ok: false,
      reason: 'no-route',
    });
    expect(resolve([provider('openai', [model('chatgpt/local-only')], 'codex', true)])).toEqual({
      ok: false,
      reason: 'no-route',
    });
  });

  it('rejects an explicitly selected non-native Codex provider without switching accounts', () => {
    expect(
      resolve(
        [
          provider('openai', [model('selected-model')], 'codex', true),
          provider('custom', [model('selected-model')]),
        ],
        {
          preferred: {
            model: 'selected-model',
            providerId: 'custom',
            effort: 'medium',
            fastMode: false,
          },
        },
      ),
    ).toEqual({ ok: false, reason: 'unsupported-codex-source' });
  });

  it('blocks while the catalog is loading or failed', () => {
    const source = [provider('openai', [model('selected-model')], 'codex', true)];
    expect(resolve(source, { loading: true })).toEqual({ ok: false, reason: 'catalog-loading' });
    expect(resolve(source, { loadFailed: true })).toEqual({ ok: false, reason: 'catalog-error' });
  });

  it('keeps an explicitly selected model from a provider with stale discovery failure', () => {
    const source = provider('openai', [model('selected-model')], 'codex', true);
    source.modelDiscoveryFailure = { kind: 'upstream', at: '2026-09-23T00:00:00Z' };
    expect(resolve([source], {
      preferred: {
        model: 'selected-model',
        providerId: 'openai',
        effort: 'medium',
        fastMode: false,
      },
    })).toMatchObject({ ok: true, model: 'selected-model', providerId: 'openai' });
    expect(resolve([source])).toEqual({ ok: false, reason: 'no-route' });
  });

  it('detects an async change in the model route instead of accepting the new valid tuple', async () => {
    const selected = resolve([provider('openai', [model('selected-model')], 'codex', true)]);
    const changed = resolve([provider('openai', [model('another-model')], 'codex', true)], {
      preferred: { model: 'another-model', effort: 'medium', fastMode: false },
    });
    if (!selected.ok || !changed.ok) throw new Error('expected valid selections');

    let release!: () => void;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const afterRemoteWait = async () => {
      await pending;
      return isSameSshSessionModelSelection(selected, changed);
    };
    const result = afterRemoteWait();
    release();
    await expect(result).resolves.toBe(false);
  });

  it('preserves OMP controller-proxy models without Codex subscription filtering', () => {
    expect(
      resolve([provider('omp-source', [model('chatgpt/omp-route')], 'omp')], {
        agentKind: 'omp',
        preferred: { model: 'chatgpt/omp-route', effort: 'medium', fastMode: false },
      }),
    ).toMatchObject({ ok: true, model: 'chatgpt/omp-route', providerId: 'omp-source' });
  });
});
