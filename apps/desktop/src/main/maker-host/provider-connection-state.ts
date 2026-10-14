import type { AgentKind, Provider, ProviderView, ProviderWireProtocol, RoutingDescriptor } from '@cindy/model-providers';

type KeyReader = (providerId: string, agent: AgentKind, protocol?: ProviderWireProtocol) => string | null;
type RouteReader = (provider: Provider, agent: AgentKind, model: string | undefined) => RoutingDescriptor | null;

function routeConnected(provider: Provider, agent: AgentKind, route: RoutingDescriptor | null | undefined, readKey: KeyReader): boolean {
  if (!route || route.disabled || route.headerOverrideState === 'unknown') return false;
  if (route.authStrategy === 'none') return true;
  if (route.authStrategy !== 'api-key-header') return false;
  const credential = route.channelCredential;
  if (readKey(credential?.channelId ?? provider.id, agent, credential?.protocol)?.trim()) return true;
  return Object.entries(route.headerOverride ?? {}).some(([name, value]) =>
    ['authorization', 'x-api-key', 'x-goog-api-key'].includes(name.toLowerCase()) && value.trim().length > 0);
}

/** Same secure-key / legacy-header alternatives as provider-route. Never exports a credential. */
export function hasCustomProviderCredential(
  provider: Provider,
  readKey: KeyReader,
  readRoute: RouteReader = (provider, agent) => provider.routing[agent] ?? null,
): boolean {
  return provider.agents.some((agent) => {
    const models = provider.channel ? provider.models[agent] ?? [] : [];
    return (models.length ? models.map(model => model.id) : [undefined]).some(model =>
      routeConnected(provider, agent, readRoute(provider, agent, model), readKey));
  });
}

/** Readiness is per resolved model/protocol. It is not a persisted disable preference. */
export function projectChannelConnectionAvailability(provider: ProviderView, readKey: KeyReader, readRoute: RouteReader): ProviderView {
  if (!provider.channel) return provider;
  const models = Object.fromEntries(Object.entries(provider.models).map(([agent, models]) => [agent,
    models?.map(model => ({ ...model, credentialUnavailable: !routeConnected(provider, agent as AgentKind,
      readRoute(provider, agent as AgentKind, model.id), readKey) })),
  ]));
  return { ...provider, models };
}
