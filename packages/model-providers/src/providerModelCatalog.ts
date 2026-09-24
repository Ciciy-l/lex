import { previousModelGenerations } from './modelGeneration.js';
import { sourceProviderForPreset } from './providerPresetIdentity.js';
import { providerEndpointBindings } from './providerEndpointTemplate.js';
import { declaredModelInterface } from './providerInterfaceRoutes.js';
import interfaceModels from "../catalog/provider-interface-models.json" with { type: "json" };
import generated from "../catalog/provider-models.json" with { type: "json" };
import type { ModelMetadata } from "./modelMetadataLayers.js";
import type { ModelCost, PiModelApi, ProviderWireProtocol } from "./types.js";

export interface ProviderModelRecord {
  /** Internal fallback provenance, not an upstream capability declaration. */
  inheritedFrom?: string;
  id: string;
  name: string;
  upstream: string;
  contextWindow: number;
  maxOutput?: number;
  modalities?: { input: string[]; output: string[] };
  supportsImageInput?: boolean;
  /** Connection-scoped declaration; absent does not authorize a Fast request. */
  supportsFastMode?: boolean;
  reasoning: boolean;
  efforts: NonNullable<ModelMetadata["efforts"]>;
  defaultEffort: ModelMetadata["defaultEffort"];
  cost?: ModelCost;
  execution: {
    pi: {
      api: string;
      headers?: Record<string, string>;
      thinkingLevelMap?: Record<string, string | null>;
      compat?: Record<string, unknown>;
      samplingParams?: Record<string, unknown>;
    };
  };
}

const sourceCatalog = generated as unknown as {
  schemaVersion: number;
  generatedAt: string;
  providers: Record<string, ProviderModelRecord[]>;
};

export const PROVIDER_MODEL_CATALOG = { ...sourceCatalog, providers: { ...sourceCatalog.providers } };

// Official per-model contracts override the pinned Pi serializer choice, without
// borrowing another supplier's metadata or adding unlisted models to an account.
for (const [provider, declaration] of Object.entries(interfaceModels)) {
  const interfaces = declaration.models as Record<string, { api: string; endpoint: string }>;
  const rows = PROVIDER_MODEL_CATALOG.providers[provider];
  if (!rows) continue;
  PROVIDER_MODEL_CATALOG.providers[provider] = rows.map(row => {
    const declared = interfaces[row.id];
    if (!declared || new URL(declared.endpoint).origin !== new URL(row.upstream).origin) return row;
    return { ...row, upstream: declaredModelInterface(provider, row.id)!.baseUrl, execution: { ...row.execution, pi: { ...row.execution.pi, api: declared.api } } };
  });
}

const byEndpointAndId = new Map<string, ProviderModelRecord[]>();
const apisByEndpoint = new Map<string, Set<string>>();
const normalize = (url: string) => {
  const trimmed = url.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
  return trimmed.slice(0, end);
};
for (const rows of Object.values(PROVIDER_MODEL_CATALOG.providers)) {
  for (const row of rows) {
    const endpoint = normalize(row.upstream);
    const apis = apisByEndpoint.get(endpoint) ?? new Set<string>();
    apis.add(row.execution.pi.api);
    apisByEndpoint.set(endpoint, apis);
    const key = `${endpoint}\n${row.id}`;
    const existing = byEndpointAndId.get(key) ?? [];
    // Upstream may publish the exact same record in several subscription catalogs.
    // Duplicate evidence is not a conflict; differing records must stay ambiguous.
    if (!existing.some(candidate => JSON.stringify(candidate) === JSON.stringify(row))) {
      byEndpointAndId.set(key, [...existing, row]);
    }
  }
}

const generationRows = Object.values(PROVIDER_MODEL_CATALOG.providers).flat();
/** Exact route identity, shared by every harness. */
export function providerModelRecord(
  modelId: string,
  upstream: string,
  protocol?: ProviderWireProtocol | PiModelApi,
  allowMixedProtocol = false,
): ProviderModelRecord | undefined {
  const api = protocol === "openai-chat" ? "openai-completions" : protocol;
  // A mixed catalog declares per-model APIs. A single-protocol endpoint does not
  // override a caller's explicitly selected transport.
  const mixed = allowMixedProtocol && (apisByEndpoint.get(normalize(upstream))?.size ?? 0) > 1;
  const matches = byEndpointAndId
    .get(`${normalize(upstream)}\n${modelId}`)
    ?.filter((row) => mixed || api === undefined || row.execution.pi.api === api);
  return matches?.length === 1 ? matches[0] : undefined;
}

/** A new generation reuses parameters, but keeps its own connection and identity. */
export function providerModelGenerationRecord(modelId: string, upstream: string, protocol?: ProviderWireProtocol | PiModelApi, presetId?: string): ProviderModelRecord | undefined {
  const api = protocol === 'openai-chat' ? 'openai-completions' : protocol;
  // Transport must already be selected; inheritance never changes a connection's API.
  if (!api) return undefined;
  const endpointRows = generationRows
    .filter(row => normalize(row.upstream) === normalize(upstream) && row.execution.pi.api === api);
  const presetRows = presetId ? (PROVIDER_MODEL_CATALOG.providers[sourceProviderForPreset(presetId)] ?? [])
    .filter(row => normalize(row.upstream) === normalize(upstream) && row.execution.pi.api === api) : [];
  // Capabilities and adapters may only come from this exact upstream path and API.
  const candidates = [...endpointRows, ...presetRows];
  const uniqueById = new Map<string, ProviderModelRecord>();
  const ambiguous = new Set<string>();
  for (const candidate of candidates) {
    const existing = uniqueById.get(candidate.id);
    if (!existing) uniqueById.set(candidate.id, candidate);
    else if (JSON.stringify(existing) !== JSON.stringify(candidate)) ambiguous.add(candidate.id);
  }
  for (const id of ambiguous) uniqueById.delete(id);
  const uniqueCandidates = [...uniqueById.values()];
  const previous = uniqueById.get(modelId)
    ?? previousModelGenerations(modelId, uniqueCandidates, row => row.id).at(-1);
  if (!previous) return undefined;
  const { cost: _cost, execution, ...metadata } = previous;
  const { headers: _headers, ...parameters } = execution.pi;
  return { ...metadata, id: modelId, name: modelId, upstream,
    ...(previous.id !== modelId ? { inheritedFrom: previous.id } : {}),
    execution: { pi: structuredClone(parameters) } };
}

/** Account-specific endpoints may still explicitly reference a maintained connection template. */
export function providerPresetModelRecord(presetId: string | undefined, modelId: string, api?: PiModelApi): ProviderModelRecord | undefined {
  if (!presetId) return undefined;
  const provider = sourceProviderForPreset(presetId);
  const matches = PROVIDER_MODEL_CATALOG.providers[provider]?.filter(row => row.id === modelId && (!api || row.execution.pi.api === api));
  return matches?.length === 1 ? matches[0] : undefined;
}

/** Preserve the upstream adapter identity, independently of a user's connection UUID. */
export function providerModelAdapterId(row: ProviderModelRecord): string | undefined {
  const matches = Object.entries(PROVIDER_MODEL_CATALOG.providers).filter(([, rows]) =>
    rows.some(candidate => candidate.id === row.id && (normalize(candidate.upstream) === normalize(row.upstream) || (candidate.upstream.includes('{') && providerEndpointBindings(candidate.upstream, row.upstream) !== null))
      && candidate.execution.pi.api === row.execution.pi.api));
  // Duplicated subscription catalogs can share endpoints; never guess between distinct identities.
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function providerModelMetadata(row: ProviderModelRecord): ModelMetadata {
  return {
    name: row.name,
    contextWindow: row.contextWindow,
    ...(row.maxOutput ? { maxOutputTokens: row.maxOutput } : {}),
    ...(row.modalities ? { modalities: row.modalities } : {}),
    ...(row.supportsImageInput !== undefined ? { supportsImageInput: row.supportsImageInput } : {}),
    ...(row.supportsFastMode !== undefined ? { supportsFastMode: row.supportsFastMode } : {}),
    efforts: row.efforts,
    defaultEffort: row.defaultEffort,
    ...(row.execution.pi.thinkingLevelMap?.off === null
      ? { reasoningRequired: true }
      : {}),
  };
}

/** Adapter only: reconstruct Pi's wire names from the same standard catalog used by UI/Codex. */
export function providerCatalogForPi() {
  return {
    generatedAt: PROVIDER_MODEL_CATALOG.generatedAt,
    providers: Object.fromEntries(
      Object.entries(PROVIDER_MODEL_CATALOG.providers).map(
        ([provider, rows]) => [
          provider,
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            provider,
            baseUrl: row.upstream,
            contextWindow: row.contextWindow,
            maxTokens: row.maxOutput,
            ...(row.modalities ? { input: row.modalities.input } : {}),
            reasoning: row.reasoning,
            ...(row.cost ? { cost: row.cost } : {}),
            ...row.execution.pi,
          })),
        ],
      ),
    ),
  };
}

/** Offline membership for an exact, supported endpoint; never infer a proxy's inventory. */
export function providerModelsForRoute(
  upstream: string,
  protocol?: ProviderWireProtocol | PiModelApi,
): ProviderModelRecord[] {
  const api = protocol === "openai-chat" ? "openai-completions" : protocol;
  const models = Object.values(PROVIDER_MODEL_CATALOG.providers)
    .flat()
    .filter(
      (row) =>
        normalize(row.upstream) === normalize(upstream) &&
        (api === undefined || row.execution.pi.api === api),
    );
  return models.filter(
    (row) => providerModelRecord(row.id, upstream, protocol) === row,
  );
}
