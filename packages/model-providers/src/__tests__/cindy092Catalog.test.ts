import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { PROVIDER_MODEL_CATALOG, providerCatalogForPi } from '../providerModelCatalog.js';
import { expandedRegistryEntries } from '../modelMetadataLayers.js';
import { toCindyProviderModel } from '../../../../tools/pi/catalog-format.mjs';

const piCatalog = providerCatalogForPi();

describe('Cindy v0.1.92 model catalog selection', () => {
  it('ships a complete monotonic Registry revision with Grok 4.7 and all MiMo V2.6 variants', () => {
    const registry = BUNDLED_CATALOG.modelRegistry!;
    expect(Date.parse(registry.updatedAt)).toBeGreaterThan(Date.parse('2026-09-11T06:45:19.551Z'));
    const ids = ['xai/grok-4.7', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro-ultraspeed'];
    for (const id of ids) {
      expect(registry.baseModels?.some(model => model.id === id), `base ${id}`).toBe(true);
      expect(expandedRegistryEntries(registry).some(entry => entry.id === id), `entry ${id}`).toBe(true);
    }
    for (const id of ids.slice(1)) {
      const base = registry.baseModels!.find(model => model.id === id)!;
      expect(base.defaults.efforts).toEqual([]);
      expect(base.defaults.defaultEffort).toBeNull();
    }
  });

  it('keeps Grok 4.7 Pi mapping and the MiMo V2.6 preset routes aligned', () => {
    const grok = BUNDLED_CATALOG.providers.find(provider => provider.id === 'xai')!.models.pi!.find(model => model.id === 'grok-4.7');
    expect(grok).toMatchObject({ piApi: 'openai-responses', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' });
    expect(piCatalog.providers.xai.find(model => model.id === 'grok-4.7')?.api).toBe('openai-responses');
    const preset = BUNDLED_CATALOG.presets!.find(model => model.id === 'xiaomi-mimo-api-cn')!;
    expect(preset.runtimes.pi?.models?.map(model => model.id)).toEqual(expect.arrayContaining([
      'mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed',
    ]));
    expect(preset.runtimes.pi?.models?.find(model => model.id === 'mimo-v2.6-pro')).toMatchObject({ supportsImageInput: true });
    expect(preset.runtimes.pi?.models?.find(model => model.id === 'mimo-v2.6-flash')).toMatchObject({ supportsImageInput: true });
    expect(preset.runtimes.pi?.models?.find(model => model.id === 'mimo-v2.6-pro-ultraspeed')?.supportsImageInput).toBeUndefined();
  });

  it.each(['github-copilot', 'google', 'google-vertex', 'opencode', 'vercel-ai-gateway'])(
    'corrects Gemini 3.8 Flash import for %s without changing unrelated routes', provider => {
      const rowId = provider === 'vercel-ai-gateway' ? 'google/gemini-3.8-flash' : 'gemini-3.8-flash';
      const source = PROVIDER_MODEL_CATALOG.providers[provider].find(model => model.id === rowId)!;
      expect(source.efforts).not.toContain('minimal');
      expect(source.execution.pi.thinkingLevelMap).toMatchObject({ minimal: null });
      const row = piCatalog.providers[provider].find(model => model.id === rowId)!;
      const converted = toCindyProviderModel({
        ...row, cost: undefined, reasoning: true,
        thinkingLevelMap: { ...row.thinkingLevelMap, minimal: 'minimal' },
      });
      expect(converted.efforts).toEqual(['low', 'medium', 'high']);
      expect(converted.defaultEffort).toBe('medium');
      expect(converted.execution.pi.thinkingLevelMap?.minimal).toBeNull();
      const unrelated = toCindyProviderModel({ ...row, cost: undefined, id: 'gemini-3-flash-preview', reasoning: true, thinkingLevelMap: undefined });
      expect(unrelated.efforts).toContain('minimal');
    },
  );
});
