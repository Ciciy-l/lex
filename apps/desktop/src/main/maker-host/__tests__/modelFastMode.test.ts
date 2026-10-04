import { afterEach, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type AgentKind, type CatalogModel, type Provider } from '@cindy/model-providers';
import {
  getActiveCatalog,
  setActiveCatalog,
  setCustomProviders,
  setXaiDiscoveredModels,
} from '../active-catalog.js';
import { fastModelId, rewriteFastModel } from '../model-fast-mode.js';

type Harness = 'claude-code' | 'codex' | 'pi';
const ids: Record<Harness, { model: string; target: string }> = {
  'claude-code': { model: 'xai/fixture-grok', target: 'xai/fixture-grok-fast' },
  codex: { model: 'xai/fixture-grok', target: 'xai/fixture-grok-fast' },
  pi: { model: 'fixture-grok', target: 'fixture-grok-fast' },
};

function row(id: string, fastModelId?: string | null): CatalogModel {
  return {
    id, name: id, contextWindow: 128000, efforts: [], defaultEffort: null, status: 'active',
    ...(fastModelId !== undefined ? { supportsFastMode: true, fastModelId } : {}),
  };
}

function provider(id: string, auth: Provider['auth'], source: Provider['source'], disableMapping = false): Provider {
  const existing = BUNDLED_CATALOG.providers.find((item) => item.id === 'xai')!;
  return {
    ...structuredClone(existing), id, source, auth,
    models: Object.fromEntries((Object.keys(ids) as Harness[]).map((agent) => [
      agent, [row(ids[agent].model, disableMapping ? null : ids[agent].target), row(ids[agent].target)],
    ])),
  };
}

function installFixture(secondMembers: string[], disableMapping = false) {
  const builtIn = provider('xai', { method: 'oauth' }, 'builtin', disableMapping);
  const second = provider('xai-second', { method: 'oauth', native: 'xai' }, 'user', disableMapping);
  const publicApiKey = provider('xai-public-api', { method: 'apiKey' }, 'user', disableMapping);
  const catalog = structuredClone(BUNDLED_CATALOG);
  catalog.providers = catalog.providers.map((item) => item.id === 'xai' ? builtIn : item);
  setActiveCatalog(catalog);
  setCustomProviders([second, publicApiKey]);
  const member = (id: string) => ({ id: 'xai/' + id });
  setXaiDiscoveredModels([member('fixture-grok'), member('fixture-grok-fast')]);
  setXaiDiscoveredModels(secondMembers.map(member), second.id);
}

afterEach(() => {
  setXaiDiscoveredModels(null);
  setXaiDiscoveredModels(null, 'xai-second');
  setCustomProviders([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

it('maps Fast only to a declared same-harness target available in the same subscription account', () => {
  installFixture(['fixture-grok']);

  for (const agent of Object.keys(ids) as Harness[]) {
    const { model, target } = ids[agent];
    expect(fastModelId('xai', agent, model)).toBe(target);
    const rewritten = rewriteFastModel('xai', agent, { model, service_tier: 'priority' }, true);
    expect(rewritten).toMatchObject({ model: target });
    expect(rewritten).not.toHaveProperty('service_tier');

    expect(fastModelId('xai-second', agent, model)).toBeUndefined();
    expect(fastModelId('xai-public-api', agent, model)).toBeUndefined();
    const publicApiModel = getActiveCatalog().providers.find((provider) => provider.id === 'xai-public-api')
      ?.models[agent]?.find((entry) => entry.id === model);
    expect(publicApiModel).toMatchObject({ supportsFastMode: false, fastModelId: null });
    const fallback = rewriteFastModel('xai-second', agent, { model, service_tier: 'priority' }, true);
    expect(fallback).toMatchObject({ model });
    expect(fallback).not.toHaveProperty('service_tier');
    const publicApiFallback = rewriteFastModel('xai-public-api', agent,
      { model, service_tier: 'priority' }, true);
    expect(publicApiFallback).toMatchObject({ model });
    expect(publicApiFallback).not.toHaveProperty('service_tier');
  }
});

it('clears Fast when discovery removes its target, while another account retains its own mapping', () => {
  installFixture(['fixture-grok', 'fixture-grok-fast']);
  const target = ids.codex.target;
  expect(fastModelId('xai-second', 'codex', ids.codex.model)).toBe(target);

  setXaiDiscoveredModels([{ id: 'xai/fixture-grok' }], 'xai-second');
  const account = getActiveCatalog().providers.find((item) => item.id === 'xai-second')!;
  expect(account.models.codex?.find((model) => model.id === ids.codex.model)?.supportsFastMode).toBe(false);
  expect(fastModelId('xai-second', 'codex', ids.codex.model)).toBeUndefined();
  expect(fastModelId('xai', 'codex', ids.codex.model)).toBe(target);
});

it('treats an explicit null mapping as revoked even when the account still lists the sibling model', () => {
  installFixture(['fixture-grok', 'fixture-grok-fast'], true);
  expect(fastModelId('xai', 'codex', ids.codex.model)).toBeUndefined();
  expect(rewriteFastModel('xai', 'codex', {
    model: ids.codex.model, service_tier: 'priority',
  }, true)).toMatchObject({ model: ids.codex.model });
  expect(rewriteFastModel('xai', 'codex', {
    model: ids.codex.model, service_tier: 'priority',
  }, true)).not.toHaveProperty('service_tier');
});

it('does not execute a retired Fast target even if a stale account snapshot still lists it', () => {
  installFixture(['fixture-grok', 'fixture-grok-fast']);
  const catalog = structuredClone(getActiveCatalog());
  const xai = catalog.providers.find((item) => item.id === 'xai')!;
  xai.models.codex!.find((model) => model.id === ids.codex.target)!.status = 'retired';
  setActiveCatalog(catalog);
  setXaiDiscoveredModels([
    { id: 'xai/fixture-grok' },
    { id: 'xai/fixture-grok-fast' },
  ]);
  expect(fastModelId('xai', 'codex', ids.codex.model)).toBeUndefined();
});
