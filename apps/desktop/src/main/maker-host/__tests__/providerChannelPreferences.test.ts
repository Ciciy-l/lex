import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUserProviderChannels,
  planLegacyProviderChannels,
  type CustomProviderConfig,
} from '@cindy/model-providers';

vi.mock('../override-settings-file.js', () => ({
  createOverrideSettingsFile: <T extends object>(options: { defaults: T }) => {
    let value = structuredClone(options.defaults);
    return {
      read: () => value,
      invalidateIfChanged: () => undefined,
      writePatch: (patch: Partial<T>) => {
        value = { ...value, ...patch };
      },
      reset: () => {
        value = structuredClone(options.defaults);
      },
    };
  },
}));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ warn: vi.fn() }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => parts.join('/'),
}));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
import {
  getActiveCatalog,
  setCustomProviders,
  setLocalCatalogOverrides,
} from '../active-catalog.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES } from '../model-plane/localCatalogOverrides.js';
import {
  readModelContextLimit,
  writeModelContextLimit,
  resetModelContextLimits,
} from '../model-context-limit-store.js';
import {
  readModelPriceOverrideView,
  setModelPriceOverride,
  clearModelPriceOverride,
  applyModelPriceOverrides,
} from '../../usage/modelPriceOverrideStore.js';

const target = { providerId: 'supplier', agent: 'codex' as const, modelId: 'gpt-private' };
afterEach(() => {
  clearModelPriceOverride(target);
  resetModelContextLimits();
  setCustomProviders([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
});
describe('migrated channel model preferences', () => {
  it('preserves and resets the original preferences without applying them to another connection', () => {
    const old: CustomProviderConfig = {
      id: 'supplier',
      name: 'Supplier',
      runtimes: {
        codex: {
          baseUrl: 'https://a.example',
          wireProtocol: 'openai-chat',
          models: [{ id: target.modelId, name: 'Same' }],
        },
        pi: {
          baseUrl: 'https://b.example',
          wireProtocol: 'openai-chat',
          models: [{ id: target.modelId, name: 'Same' }],
        },
      },
    };
    writeModelContextLimit('codex', 'supplier', target.modelId, 320_000);
    setModelPriceOverride(
      target,
      { currency: 'USD', inputPerMtok: 5, outputPerMtok: 10 },
      undefined,
    );
    setLocalCatalogOverrides({
      ...EMPTY_MODEL_CATALOG_OVERRIDES,
      patches: {
        ['supplier:' + target.modelId]: { perAgent: { codex: { contextWindow: 800_000 } } },
      },
    });
    const config = { ...old, channels: planLegacyProviderChannels(old, {})!.configuration };
    setCustomProviders(buildUserProviderChannels(config));
    const id = config.channels.legacyBindings!.codex!;
    const other = config.channels.legacyBindings!.pi!;
    const selected = { ...target, providerId: id };
    expect(readModelContextLimit('codex', id, target.modelId)).toBe(320_000);
    expect(readModelContextLimit('codex', other, target.modelId)).toBeNull();
    expect(
      getActiveCatalog().providers.find((p) => p.id === id)?.models.codex?.[0].contextWindow,
    ).toBe(800_000);
    expect(
      getActiveCatalog().providers.find((p) => p.id === other)?.models.codex?.[0].contextWindow,
    ).not.toBe(800_000);
    const price = readModelPriceOverrideView(selected, undefined, 'USD');
    expect(price.effective).toMatchObject({ providerId: id, inputPerMtok: 5, outputPerMtok: 10 });
    expect(
      readModelPriceOverrideView({ ...target, providerId: other }, undefined, 'USD').override,
    ).toBeNull();
    expect(Object.values(applyModelPriceOverrides({}, undefined, 'USD')[id])).toEqual([
      expect.objectContaining({ providerId: id, inputPerMtok: 5 }),
    ]);
    writeModelContextLimit('codex', id, target.modelId, null);
    clearModelPriceOverride(selected);
    expect(readModelContextLimit('codex', 'supplier', target.modelId)).toBeNull();
    expect(readModelPriceOverrideView(target, undefined, 'USD').override).toBeNull();
  });
});
