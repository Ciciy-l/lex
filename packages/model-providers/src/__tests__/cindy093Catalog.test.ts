import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { expandedRegistryEntries } from '../modelMetadataLayers.js';
import { findModelRegistryRoute, resolveModelReferencePrice } from '../modelRegistry.js';

const registry = BUNDLED_CATALOG.modelRegistry!;

describe('Cindy v0.1.93 model catalog selection', () => {
  it('advances the bundled registry revision past the previous snapshot', () => {
    expect(Date.parse(registry.updatedAt)).toBeGreaterThan(Date.parse('2026-09-24T00:00:00.001Z'));
  });

  it.each([
    ['openai', 'gpt-6-sol', 'gpt-5.6-sol'],
    ['openai', 'gpt-6-luna', 'gpt-5.6-luna'],
    ['anthropic', 'claude-opus-5-5', 'claude-opus-5'],
  ])('ships %s/%s ahead of its previous generation', (provider, model, previous) => {
    const entry = expandedRegistryEntries(registry).find((item) => item.id === provider + '/' + model);
    expect(entry, 'registry entry ' + model).toBeDefined();
    expect(registry.baseModels?.some((base) => base.id === provider + '/' + model), 'base ' + model).toBe(true);
    const current = findModelRegistryRoute(registry, provider, model)?.entry.sortOrder;
    const prior = findModelRegistryRoute(registry, provider, previous)?.entry.sortOrder;
    expect(Number.isFinite(current)).toBe(true);
    expect(current).toBeLessThan(prior!);
  });

  it.each([
    { model: 'gpt-6-sol', input: 2, output: 10 },
    { model: 'gpt-6-luna', input: 0.1, output: 0.5 },
  ])(
    'prices $model against the verified OpenAI long-context boundary',
    ({ model, input, output }) => {
      for (const variant of ['standard', 'fast'] as const) {
        const multiplier = variant === 'fast' ? 2 : 1;
        const options = { at: new Date('2026-09-22T12:00:00Z'), variant, inputTokens: 272_000 };
        expect(
          resolveModelReferencePrice(registry, 'openai', model, {
            ...options,
            at: new Date('2026-09-21T23:59:59Z'),
          }),
        ).toBeUndefined();
        expect(
          resolveModelReferencePrice(registry, 'openai', model, options)?.price,
        ).toMatchObject({
          inputPerMtok: input * multiplier,
          outputPerMtok: output * multiplier,
        });
        expect(
          resolveModelReferencePrice(registry, 'openai', model, {
            ...options,
            inputTokens: 272_001,
          })?.price,
        ).toMatchObject({
          inputPerMtok: input * multiplier * 2,
          outputPerMtok: output * multiplier * 1.5,
        });
        expect(
          resolveModelReferencePrice(registry, 'xd', model, options),
        ).toBeUndefined();
      }
      expect(
        findModelRegistryRoute(registry, 'openai', model, 'codex')?.entry,
      ).toMatchObject({
        contextWindow: 1_050_000,
        supportsImageInput: true,
        perAgent: {
          codex: { contextWindow: 272_000 },
          'claude-code': { contextWindow: 272_000 },
        },
      });
    },
  );

  it('keeps Opus 5.5 cache prices valid across its full window', () => {
    for (const inputTokens of [1, 200_001, 900_000]) {
      for (const variant of ['standard', 'fast'] as const) {
        const multiplier = variant === 'fast' ? 2 : 1;
        expect(
          resolveModelReferencePrice(registry, 'anthropic', 'claude-opus-5-5', {
            at: new Date('2026-09-22T12:00:00Z'),
            variant,
            inputTokens,
          })?.price,
        ).toMatchObject({
          inputPerMtok: 4 * multiplier,
          outputPerMtok: 20 * multiplier,
        });
      }
    }
    const standard = resolveModelReferencePrice(registry, 'anthropic', 'claude-opus-5-5', {
      at: new Date('2026-09-22T12:00:00Z'),
      variant: 'standard',
      inputTokens: 1,
    })?.price;
    expect(standard).toMatchObject({
      cacheReadPerMtok: 0.2,
      cacheWritePerMtok: 5,
      cacheWrite1hPerMtok: 8,
    });
  });

  it('does not grant the new entries to Pi or OMP routes', () => {
    for (const model of ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'anthropic/claude-opus-5-5']) {
      const entry = expandedRegistryEntries(registry).find((item) => item.id === model)!;
      expect(entry.routes.flatMap((route) => route.agents)).toEqual(['claude-code', 'codex']);
      for (const provider of Object.values(BUNDLED_CATALOG.providers)) {
        expect((provider.models?.pi ?? []).map((item) => item.id)).not.toContain(model);
      }
    }
  });
});
