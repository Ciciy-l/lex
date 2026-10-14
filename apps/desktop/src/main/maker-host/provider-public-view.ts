import type { ProviderView } from '@cindy/model-providers';

/** Local settings may edit redacted metadata. Remote catalogs never carry
 * credential headers, canonical connection records or alias bindings. */
export function publicProviderView(provider: ProviderView, trusted = false): ProviderView {
  const {
    channelConfig: _channel,
    channelAliases: _aliases,
    customConfig: config,
    ...safe
  } = provider;
  const routing = Object.fromEntries(
    Object.entries(provider.routing ?? {}).map(([agent, route]) => {
      if (!route) return [agent, route];
      const { headerOverride: _headers, channelCredential: _credential, ...metadata } = route;
      return [agent, metadata];
    }),
  );
  return { ...safe, routing, ...(trusted && config ? { customConfig: config } : {}) };
}
