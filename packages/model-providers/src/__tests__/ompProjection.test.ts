import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../builtin.js';
import { projectBuiltinOmpProvider, withOmpPresetRuntime } from '../ompProjection.js';
import { unifiedModelEntries } from '../unifiedSelection.js';
import { buildUserProvider } from '../user-provider.js';
import type { Provider, ProviderPreset } from '../types.js';

const model = {
  id: 'claude-test',
  name: 'Claude test',
  contextWindow: 200_000,
  efforts: [],
  defaultEffort: null,
  defaultEnabled: true,
  group: 'anthropic' as const,
};
const provider = (): Provider => ({
  ...BUNDLED_CATALOG.providers.find((p) => p.id === 'anthropic')!,
  models: { 'claude-code': [model], codex: [model] },
});

describe('OMP managed provider projection', () => {
  it('enumerates an authenticated preset model in an OMP-only selector with the same source', () => {
    const source = provider();
    const projected = projectBuiltinOmpProvider(source);
    const rows = unifiedModelEntries({
      providers: [{ ...projected, connected: true }],
      agents: ['omp'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: source.id,
      modelId: model.id,
      candidates: ['omp'],
    });
    expect(projected.routing.omp).toEqual({
      ...source.routing.codex,
      wireProtocol: 'anthropic-messages',
    });
    expect(source.models.omp).toBeUndefined();
    expect(
      unifiedModelEntries({
        providers: [{ ...projected, connected: false }],
        agents: ['omp'],
      }),
    ).toEqual([]);
    expect(
      unifiedModelEntries({
        providers: [{ ...projected, connected: true, suspended: true }],
        agents: ['omp'],
      }),
    ).toEqual([]);
  });

  it('keeps account identities, per-model paths, metadata and default visibility', () => {
    const source = provider();
    source.id = 'my-anthropic-account';
    source.source = 'user';
    source.auth = { method: 'oauth', native: 'claude' };
    source.models['claude-code'] = [
      {
        ...model,
        defaultEnabled: false,
        route: {
          baseUrl: 'https://api.anthropic.com',
          wireProtocol: 'anthropic-messages',
          requestPath: '/v1/messages',
        },
      },
    ];
    source.models.codex = source.models['claude-code'];
    const projected = projectBuiltinOmpProvider(source);
    expect(projected.id).toBe(source.id);
    expect(projected.auth).toBe(source.auth);
    expect(projected.models.omp).toEqual(source.models['claude-code']);
  });

  it('does not opt user credentials into OMP or replace explicit empty/disabled OMP configuration', () => {
    const source = provider();
    const custom = {
      ...source,
      source: 'user' as const,
      auth: { method: 'apiKey' as const },
    };
    expect(projectBuiltinOmpProvider(custom)).toBe(custom);
    const empty = { ...source, models: { ...source.models, omp: [] } };
    expect(projectBuiltinOmpProvider(empty)).toBe(empty);
    const disabled = {
      ...source,
      routing: {
        ...source.routing,
        omp: { ...source.routing['claude-code']!, disabled: true },
      },
    };
    expect(projectBuiltinOmpProvider(disabled)).toBe(disabled);
    const stopped = {
      ...source,
      agents: ['claude-code' as const],
      routing: {
        'claude-code': { ...source.routing['claude-code']!, disabled: true },
      },
    };
    expect(projectBuiltinOmpProvider(stopped)).toBe(stopped);
  });

  it('offers portable preset templates without making unsupported cloud APIs selectable', () => {
    const preset: ProviderPreset = {
      id: 'example',
      name: 'Example',
      runtimes: {
        pi: {
          baseUrl: 'https://example.test/v1',
          wireProtocol: 'openai-chat',
          models: [
            { id: 'portable', name: 'Portable', api: 'openai-completions' },
            { id: 'cloud', name: 'Cloud', api: 'bedrock-converse-stream' },
          ],
        },
      },
    };
    expect(withOmpPresetRuntime(preset).runtimes.omp?.models.map((m) => m.id)).toEqual([
      'portable',
    ]);
    expect(preset.runtimes.omp).toBeUndefined();
    const explicit = {
      ...preset,
      runtimes: {
        ...preset.runtimes,
        omp: { ...preset.runtimes.pi!, models: [] },
      },
    };
    expect(withOmpPresetRuntime(explicit)).toBe(explicit);
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      for (const entry of withOmpPresetRuntime(preset).runtimes.omp?.models ?? []) {
        expect([
          undefined,
          'anthropic-messages',
          'openai-responses',
          'openai-completions',
          'google-generative-ai',
        ]).toContain(entry.api ?? entry.piApi);
      }
    }
  });

  it('resolves a saved OMP template without adding engines or stale model copies to the public preset', () => {
    const preset: ProviderPreset = {
      id: 'scoped',
      name: 'Scoped',
      runtimes: {
        codex: {
          baseUrl: 'https://example.test/v1',
          wireProtocol: 'openai-responses',
          models: [{ id: 'scoped-model', name: 'Scoped model', contextWindow: 123456 }],
        },
      },
    };
    const runtime = {
      catalogPresetId: preset.id,
      baseUrl: 'https://example.test/v1',
      wireProtocol: 'openai-responses' as const,
      models: [{ id: 'scoped-model', name: 'Scoped model' }],
    };
    expect(
      buildUserProvider(
        { id: 'explicit', name: 'Explicit', runtimes: { omp: runtime } },
        { presets: [preset] },
      ).models.omp?.[0].contextWindow,
    ).toBe(123456);
    expect(
      buildUserProvider(
        { id: 'existing', name: 'Existing', runtimes: { codex: runtime } },
        { presets: [preset] },
      ).agents,
    ).toEqual(['codex']);
    expect(preset.runtimes.omp).toBeUndefined();
    expect(
      BUNDLED_CATALOG.presets?.find((entry) => entry.id === 'vllm')?.runtimes.omp,
    ).toBeUndefined();
  });
});
