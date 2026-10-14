import type {
  AgentKind,
  CustomProviderConfig,
  CustomProviderRuntimeConfig,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
  Provider,
} from "./types.js";

/** A connection identity, independent of both its supplier and its engine. */
export interface ProviderChannel {
  id: string;
  name: string;
  protocols: Partial<Record<ProviderWireProtocol, CustomProviderRuntimeConfig>>;
}

export type ModelProtocolPreference =
  { mode: "auto" } | { mode: "fixed"; protocol: ProviderWireProtocol };

export interface ProviderChannelConfiguration {
  version: 1;
  channels: ProviderChannel[];
  /** Existing tasks retain the original provider ID through this explicit alias. */
  legacyBindings?: Partial<Record<AgentKind, string>>;
}

export interface LegacyChannelCredentialCopy {
  channelId: string;
  protocol: ProviderWireProtocol;
  agent: AgentKind;
}

/**
 * Pure migration plan. Host-provided credential identities are opaque equality
 * tokens, never stored or returned. Different authentication must not coalesce.
 */
export function planLegacyProviderChannels(
  config: CustomProviderConfig,
  credentialIdentities: Partial<Record<AgentKind, string>>,
): {
  configuration: ProviderChannelConfiguration;
  credentials: LegacyChannelCredentialCopy[];
} | null {
  if (config.channels || config.auth?.method === "oauth") return null;
  // Specialized cloud/subscription SDK transports retain their existing
  // configuration workflow; a generic URL/key channel cannot represent them.
  if (
    Object.values(config.runtimes).some((runtime) =>
      runtime?.models.some(
        (model) => (model.api || model.piApi) && !modelProtocol(model),
      ),
    )
  )
    return null;
  const channels: ProviderChannel[] = [];
  const signatures = new Map<string, string>();
  const legacyBindings: Partial<Record<AgentKind, string>> = {};
  const credentials: LegacyChannelCredentialCopy[] = [];
  for (const agent of PROVIDER_CHANNEL_AGENTS) {
    const runtime = config.runtimes[agent];
    if (!runtime) continue;
    const protocol = runtime.wireProtocol ?? legacyDefaultProtocol(agent);
    const { headers: _headers, headersState: _state, ...connection } = runtime;
    // Missing credential evidence is deliberately unique to the old slot.
    const signature = JSON.stringify([
      protocol,
      connection,
      credentialIdentities[agent] ?? agent,
    ]);
    const reused = signatures.get(signature);
    if (reused) {
      legacyBindings[agent] = reused;
      continue;
    }
    const channelId = `${config.id}-channel-${agent}`;
    const protocols: ProviderChannel["protocols"] = {};
    for (const model of runtime.models) {
      const wire =
        model.route?.wireProtocol ?? modelProtocol(model) ?? protocol;
      const slot = protocols[wire] ?? {
        ...connection,
        wireProtocol: wire,
        models: [],
      };
      slot.models.push(structuredClone(model));
      protocols[wire] = slot;
    }
    // Preserve the default endpoint even when every model has a route override.
    // It remains the compatibility connection for historical tasks.
    protocols[protocol] ??= {
      ...connection,
      wireProtocol: protocol,
      models: [],
    };
    channels.push({
      id: channelId,
      name:
        agent === "claude-code"
          ? "Claude Code"
          : agent === "codex"
            ? "Codex"
            : agent === "pi"
              ? "Pi"
              : "OMP",
      protocols,
    });
    for (const wire of Object.keys(protocols))
      credentials.push({
        channelId,
        protocol: wire as ProviderWireProtocol,
        agent,
      });
    legacyBindings[agent] = channelId;
    signatures.set(signature, channelId);
  }
  return channels.length
    ? { configuration: { version: 1, channels, legacyBindings }, credentials }
    : null;
}

/** Legacy tasks keep their engine-specific connection until an explicit change. */
export function projectLegacyChannelRuntimes(
  config: CustomProviderConfig,
): CustomProviderConfig["runtimes"] {
  if (!config.channels) return config.runtimes;
  const runtimes: CustomProviderConfig["runtimes"] = {};
  for (const agent of PROVIDER_CHANNEL_AGENTS) {
    const channel = config.channels.channels.find(
      (entry) => entry.id === config.channels?.legacyBindings?.[agent],
    );
    if (!channel) continue;
    const previous = config.runtimes[agent];
    const protocol = previous?.wireProtocol ?? legacyDefaultProtocol(agent);
    if (!previous) continue;
    const selected = previous.models.flatMap((model) => {
      const wire =
        model.route?.wireProtocol ?? modelProtocol(model) ?? protocol;
      const resolved = resolveChannelModel(channel, model.id, agent, {
        mode: "fixed",
        protocol: wire,
      });
      return resolved ? [resolved] : [];
    });
    const connection = channel.protocols[protocol] ?? selected[0]?.connection;
    // Deleting a protocol/model does not authorize a historical task to change
    // protocols or channels. Surviving connections do follow explicit edits.
    if (!connection) continue;
    runtimes[agent] = {
      ...connection,
      models: selected.map((route) => ({
        ...route.model,
        route: route.model.route ?? {
          baseUrl: route.connection.baseUrl,
          wireProtocol: route.protocol,
          ...(route.connection.requestPath
            ? { requestPath: route.connection.requestPath }
            : {}),
        },
      })),
    };
  }
  return runtimes;
}

export const PROVIDER_WIRE_PROTOCOLS: readonly ProviderWireProtocol[] = [
  "anthropic-messages",
  "openai-responses",
  "openai-chat",
  "google-generative-ai",
];

function legacyDefaultProtocol(agent: AgentKind): ProviderWireProtocol {
  return agent === "codex"
    ? "openai-responses"
    : agent === "pi"
      ? "openai-chat"
      : "anthropic-messages";
}
export const PROVIDER_CHANNEL_AGENTS: readonly AgentKind[] = [
  "claude-code",
  "codex",
  "pi",
  "omp",
];

/** Fixed selections use ordinary provider IDs throughout task/favorite/remote
 * state. No peer can accidentally discard the policy and reinterpret it as auto. */
export function channelProtocolProviderId(
  channelId: string,
  protocol: ProviderWireProtocol,
): string {
  return channelId + "--" + protocol;
}

export function isProviderWireProtocol(
  value: unknown,
): value is ProviderWireProtocol {
  return (
    typeof value === "string" &&
    PROVIDER_WIRE_PROTOCOLS.includes(value as ProviderWireProtocol)
  );
}

/** Unknown future policies must be rejected, not silently interpreted as auto. */
export function parseModelProtocolPreference(
  value: unknown,
): ModelProtocolPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (policy.mode === "auto") return { mode: "auto" };
  return policy.mode === "fixed" && isProviderWireProtocol(policy.protocol)
    ? { mode: "fixed", protocol: policy.protocol }
    : null;
}

export function sameModelProtocolPreference(
  a?: ModelProtocolPreference,
  b?: ModelProtocolPreference,
): boolean {
  return (
    (a?.mode ?? "auto") === (b?.mode ?? "auto") &&
    (a?.mode !== "fixed" || (b?.mode === "fixed" && a.protocol === b.protocol))
  );
}

export function nativeEngineProtocol(
  agent: AgentKind,
): ProviderWireProtocol | null {
  return agent === "claude-code"
    ? "anthropic-messages"
    : agent === "codex"
      ? "openai-responses"
      : null;
}

function modelProtocol(
  model: ProviderRuntimeModelConfig,
): ProviderWireProtocol | undefined {
  const api = model.api ?? model.piApi;
  return api === "openai-completions"
    ? "openai-chat"
    : isProviderWireProtocol(api)
      ? api
      : undefined;
}

/** A migrated connection may reuse its original preference key only while the
 * engine, model and selected protocol still identify the same route. Equal model
 * names on a different channel (or a newly preferred protocol) are insufficient. */
export function legacyChannelModelPreferenceId(
  provider: Provider,
  agent: AgentKind,
  modelId: string,
): string | undefined {
  const channel = provider.channel;
  const config = provider.customConfig;
  if (
    !channel ||
    channel.legacy ||
    !config?.channels ||
    config.channels.legacyBindings?.[agent] !== channel.id
  )
    return undefined;
  const original = config.runtimes[agent];
  const model = original?.models.find((entry) => entry.id === modelId);
  const current = provider.channelConfig;
  if (!original || !model || !current) return undefined;
  const protocol =
    model.route?.wireProtocol ??
    modelProtocol(model) ??
    original.wireProtocol ??
    legacyDefaultProtocol(agent);
  const selected = resolveChannelModel(
    current,
    modelId,
    agent,
    channel.protocol
      ? { mode: "fixed", protocol: channel.protocol }
      : { mode: "auto" },
  );
  return selected?.protocol === protocol ? channel.supplierId : undefined;
}

export interface ResolvedChannelModel {
  channelId: string;
  protocol: ProviderWireProtocol;
  connection: CustomProviderRuntimeConfig;
  model: ProviderRuntimeModelConfig;
  native: boolean;
}

/** No source fallback: callers must choose a channel before resolving a model. */
export function resolveChannelModel(
  channel: ProviderChannel,
  modelId: string,
  agent: AgentKind,
  preference: ModelProtocolPreference = { mode: "auto" },
  currentProtocol?: ProviderWireProtocol,
): ResolvedChannelModel | null {
  const candidates: ResolvedChannelModel[] = [];
  const native = nativeEngineProtocol(agent);
  for (const protocol of Object.keys(channel.protocols)) {
    if (!isProviderWireProtocol(protocol)) continue;
    const connection = channel.protocols[protocol];
    const model = connection?.models.find((entry) => entry.id === modelId);
    if (!connection || !model) continue;
    const api = model.api ?? model.piApi;
    // Vertex/Bedrock/Azure and other specialized SDK APIs are not generic
    // URL/key routes. They retain the legacy specialized workflow.
    if (api && !modelProtocol(model)) continue;
    candidates.push({
      channelId: channel.id,
      protocol,
      connection,
      model,
      native: native === null || native === protocol,
    });
  }
  if (preference.mode === "fixed")
    return (
      candidates.find((route) => route.protocol === preference.protocol) ?? null
    );
  const preferred = candidates.filter((route) => route.native);
  const pool = preferred.length ? preferred : candidates;
  if (native === null) {
    const declared = pool.find(
      (route) => modelProtocol(route.model) === route.protocol,
    );
    if (declared) return declared;
  }
  return (
    pool.find((route) => route.protocol === currentProtocol) ?? pool[0] ?? null
  );
}

/** Materialize old per-engine input only at the adapter boundary. */
export function projectChannelRuntimes(
  channel: ProviderChannel,
): Partial<Record<AgentKind, CustomProviderRuntimeConfig>> {
  const models = [
    ...new Set(
      Object.values(channel.protocols).flatMap(
        (connection) => connection?.models.map((model) => model.id) ?? [],
      ),
    ),
  ];
  const runtimes: Partial<Record<AgentKind, CustomProviderRuntimeConfig>> = {};
  for (const agent of PROVIDER_CHANNEL_AGENTS) {
    const selected = models
      .map((model) => resolveChannelModel(channel, model, agent))
      .filter((route): route is ResolvedChannelModel => route !== null);
    if (!selected.length) {
      const connection = Object.values(channel.protocols)[0];
      if (models.length === 0 && connection)
        runtimes[agent] = { ...connection, models: [] };
      continue;
    }
    const first = selected[0];
    runtimes[agent] = {
      ...first.connection,
      wireProtocol: first.protocol,
      models: selected.map((route) => ({
        ...route.model,
        defaultEnabled: route.model.defaultEnabled ?? true,
        api:
          route.protocol === "openai-chat"
            ? "openai-completions"
            : route.protocol,
        route: route.model.route ?? {
          baseUrl: route.connection.baseUrl,
          wireProtocol: route.protocol,
          ...(route.connection.requestPath
            ? { requestPath: route.connection.requestPath }
            : {}),
        },
      })),
    };
  }
  return runtimes;
}

/** Display grouping does not change a channel's route identity or capability data. */
export function providerChannelGroupKey(
  supplierId: string,
  modelId: string,
): string {
  return JSON.stringify([supplierId, modelId]);
}
