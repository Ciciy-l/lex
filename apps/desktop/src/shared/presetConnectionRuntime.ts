import type {
  AgentKind,
  CustomProviderRuntimeConfig,
  ProviderPreset,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';
import { presetRuntimeForAgent } from './piRuntimeInitialization.js';

/** Shared by the add wizard and import: keep defaults linked to the live preset. */
export function presetConnectionRuntime(
  preset: ProviderPreset,
  agent: AgentKind,
  models: ProviderRuntimeModelConfig[],
  baseUrl = presetRuntimeForAgent(preset, agent)?.baseUrl ?? '',
): CustomProviderRuntimeConfig {
  const rt = presetRuntimeForAgent(preset, agent);
  if (!rt) throw new Error(`Preset ${preset.id} has no ${agent} runtime`);
  return {
    catalogPresetId: preset.id,
    baseUrl,
    models: models.map(model => {
      // Import-time interface defaults remain references, not manual overrides.
      if (!rt.models.some(candidate => candidate.id === model.id)) return model;
      const { api: _api, piApi: _piApi, route: _route, ...stored } = model;
      return stored;
    }),
    ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
    ...(rt.requestPath ? { requestPath: rt.requestPath } : {}),
    ...(agent === 'codex' && rt.supportsImageGeneration === true
      ? { supportsImageGeneration: true }
      : {}),
    ...(rt.headers ? { headers: rt.headers } : {}),
    ...(rt.modelsUrl ? { modelsUrl: rt.modelsUrl } : {}),
    ...(rt.piCatalogProviderId ? { piCatalogProviderId: rt.piCatalogProviderId } : {}),
  };
}
