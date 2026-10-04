import { describe, expect, it } from 'vitest';
import { expandPresetModels } from '../presetModels.js';
import { BUNDLED_CATALOG, parseCatalog, sanitizePresets } from '../catalog.js';

describe('shared preset model declarations', () => {
  it('expands one ordered list to declared runtimes, applying engine overrides and preserving legacy documents', () => {
    const preset = { id: 'demo', name: 'Demo', models: [
      { id: 'a', name: 'A', contextWindow: 1000 },
      { id: 'b', name: 'B', engines: ['claude-code'] },
      { id: 'c', name: 'C', engineOverrides: { pi: { reasoning: true, reasoningEfforts: ['high'] } } },
    ], runtimes: {
      'claude-code': { baseUrl: 'https://example.test/anthropic', models: [] },
      codex: { baseUrl: 'https://example.test/v1', models: [] },
      pi: { baseUrl: 'https://example.test/v1', models: [] },
    } };
    const expanded = expandPresetModels(preset);
    expect(expanded).not.toHaveProperty('models');
    expect((expanded.runtimes['claude-code'] as { models: { id: string }[] }).models.map((model) => model.id)).toEqual(['a', 'b', 'c']);
    expect((expanded.runtimes.codex as { models: { id: string }[] }).models.map((model) => model.id)).toEqual(['a', 'c']);
    expect(expanded.runtimes.pi.models[1]).toMatchObject({ reasoning: true, reasoningEfforts: ['high'] });

    const sanitized = sanitizePresets([preset]);
    expect(sanitized[0]).not.toHaveProperty('models');
    expect(sanitized[0]?.runtimes.codex?.models?.map((model) => model.id)).toEqual(['a', 'c']);

    const legacy = { id: 'legacy', name: 'Legacy', runtimes: { codex: { baseUrl: 'https://example.test/v1', models: [{ id: 'old', name: 'Old' }] } } };
    expect(expandPresetModels(legacy)).toBe(legacy);
    expect(sanitizePresets([legacy])).toMatchObject([{
      id: 'legacy', runtimes: { codex: { models: [{ id: 'old', name: 'Old' }] } },
    }]);
  });

  it('materializes shared models when a new-format runtime omits its legacy models array, including parseCatalog output', () => {
    const preset = {
      id: 'no-runtime-models', name: 'No runtime models',
      models: [{ id: 'shared', name: 'Shared', engines: ['codex'] }],
      runtimes: { codex: { baseUrl: 'https://example.test/v1' } },
    };
    const sanitized = sanitizePresets([preset]);
    expect(sanitized).toEqual([{
      id: 'no-runtime-models', name: 'No runtime models',
      runtimes: { codex: { baseUrl: 'https://example.test/v1', models: [{ id: 'shared', name: 'Shared' }] } },
    }]);

    const catalog = parseCatalog({ ...structuredClone(BUNDLED_CATALOG), presets: [preset] });
    expect(catalog.presets?.[0]?.runtimes.codex?.models).toEqual([{ id: 'shared', name: 'Shared' }]);
    expect(catalog.presets?.[0]).not.toHaveProperty('models');
  });

  it('does not partially expand malformed runtimes or mutate a legacy models array', () => {
    const malformed = {
      id: 'bad-runtime', name: 'Bad runtime',
      models: [{ id: 'shared', name: 'Shared' }],
      runtimes: { codex: null },
    };
    expect(expandPresetModels(malformed)).toBe(malformed);
    expect(sanitizePresets([malformed])).toEqual([]);

    const legacy = {
      id: 'stale-runtime-models', name: 'Stale runtime models',
      models: [{ id: 'shared', name: 'Shared' }],
      runtimes: {
        codex: {
          baseUrl: 'https://example.test/v1',
          wireProtocol: 'openai-responses' as const,
          models: [{ id: 'legacy', name: 'Legacy' }],
          modelsUrl: 'https://example.test/v1/models',
        },
      },
    };
    const expanded = expandPresetModels(legacy);
    expect(expanded.runtimes.codex.models).toEqual([{ id: 'shared', name: 'Shared' }]);
    expect(legacy.models).toEqual([{ id: 'shared', name: 'Shared' }]);
    expect(legacy.runtimes.codex.models).toEqual([{ id: 'legacy', name: 'Legacy' }]);
    expect(sanitizePresets([legacy])).toMatchObject([{
      runtimes: {
        codex: {
          baseUrl: 'https://example.test/v1',
          wireProtocol: 'openai-responses',
          modelsUrl: 'https://example.test/v1/models',
          models: [{ id: 'shared', name: 'Shared' }],
        },
      },
    }]);
  });

  it('rejects malformed engine scoping and overrides as a whole preset', () => {
    const runtimeSet = { 'claude-code': { baseUrl: 'https://example.test/anthropic', models: [] }, codex: { baseUrl: 'https://example.test/v1', models: [] } };
    for (const restriction of [
      { engines: [] },
      { engines: ['pi'] },
      { engines: ['codex', 'omp'] },
      { engines: 'codex' },
      { engineOverrides: { pi: { supportsImageInput: false } } },
      { engineOverrides: { codex: 'bad' } },
      { engineOverrides: [] },
    ]) {
      const preset = { id: 'bad', name: 'Bad', runtimes: runtimeSet, models: [{ id: 'm', name: 'M', ...restriction }] };
      expect(expandPresetModels(preset)).toBe(preset);
      expect(sanitizePresets([preset])).toEqual([]);
    }

    const primitiveModel = {
      id: 'bad-model', name: 'Bad model', runtimes: runtimeSet, models: [null],
    };
    expect(expandPresetModels(primitiveModel)).toBe(primitiveModel);
    expect(sanitizePresets([primitiveModel])).toEqual([]);
  });

  it('allows only OMP models when OMP is declared by that preset', () => {
    const preset = { id: 'omp-only', name: 'OMP only', models: [{ id: 'm', name: 'M', engines: ['omp'] }],
      runtimes: { omp: { baseUrl: 'https://example.test/v1', models: [] }, pi: { baseUrl: 'https://example.test/v1', models: [] } } };
    const expanded = expandPresetModels(preset);
    expect((expanded.runtimes.omp as { models: unknown[] }).models).toEqual([{ id: 'm', name: 'M' }]);
    expect((expanded.runtimes.pi as { models: unknown[] }).models).toEqual([]);
    expect(sanitizePresets([preset])).toHaveLength(1);
  });

  it('keeps aad281ca runtime members while scoping newly verified routes', () => {
    const preset = (id: string) => {
      const value = BUNDLED_CATALOG.presets?.find((candidate) => candidate.id === id);
      if (!value) throw new Error('missing preset ' + id);
      return value;
    };
    const ids = (id: string, agent: 'claude-code' | 'codex' | 'pi') =>
      preset(id).runtimes[agent]?.models?.map((model) => model.id) ?? [];

    expect(ids('moonshot-kimi-cn', 'pi')).toEqual(expect.arrayContaining([
      'kimi-k2-0711-preview',
      'kimi-k2-0905-preview',
      'kimi-k2-thinking',
      'kimi-k2-thinking-turbo',
      'kimi-k2-turbo-preview',
      'kimi-k2.5',
    ]));
    expect(ids('aliyun-bailian-token-plan-cn', 'pi')).toEqual(expect.arrayContaining([
      'MiniMax-M2.5',
      'deepseek-v3.2',
      'deepseek-v4-flash-0731',
      'deepseek-v4-pro-0813',
      'qwen3.6-plus',
    ]));
    expect(ids('zhipu-coding-plan-cn', 'pi')).toEqual(expect.arrayContaining([
      'glm-4.6v',
      'glm-5.2-highspeed',
      'glm-5.3-highspeed',
    ]));
    expect(ids('zai-coding-plan-global', 'pi')).not.toContain('glm-4.6v');

    expect(ids('xiaomi-mimo-api-cn', 'pi')).toContain('mimo-v2.6-pro-ultraspeed');
    expect(ids('xiaomi-mimo-api-cn', 'claude-code')).not.toContain('mimo-v2.6-pro-ultraspeed');
    expect(ids('opencode-go', 'codex')).toEqual(expect.arrayContaining([
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'mimo-v2.6-pro',
      'mimo-v2.6-flash',
    ]));
    expect(ids('minimax-cn', 'claude-code')).not.toContain('MiniMax-M2.1');
  });
});
