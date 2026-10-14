import {
  buildUserProvider,
  type BuildUserProviderOptions,
} from "./user-provider.js";
import {
  channelProtocolProviderId,
  projectChannelRuntimes,
  projectLegacyChannelRuntimes,
} from "./providerChannels.js";
import type { CustomProviderConfig, Provider } from "./types.js";

/** Expand supplier storage into independently selectable connection identities. */
export function buildUserProviderChannels(
  config: CustomProviderConfig,
  options: BuildUserProviderOptions = {},
): Provider[] {
  if (!config.channels) return [buildUserProvider(config, options)];
  const { channels: configuration, ...legacy } = config;
  const customConfig = structuredClone(config);
  for (const runtime of Object.values(customConfig.runtimes)) {
    if (runtime) delete runtime.headers;
  }
  for (const channel of customConfig.channels?.channels ?? []) {
    for (const runtime of Object.values(channel.protocols)) {
      if (runtime) delete runtime.headers;
    }
  }
  const providers: Provider[] = configuration.channels.flatMap((channel) => [
    {
      ...buildUserProvider(
        {
          ...legacy,
          id: channel.id,
          runtimes: projectChannelRuntimes(channel),
        },
        options,
      ),
      channel: {
        supplierId: config.id,
        id: channel.id,
        name: channel.name,
        protocols: Object.keys(
          channel.protocols,
        ) as import("./types.js").ProviderWireProtocol[],
      },
      channelConfig: channel,
      customConfig,
    },
    ...Object.entries(channel.protocols).map(([wire, connection]) => {
      const protocol = wire as import("./types.js").ProviderWireProtocol;
      const fixed = { ...channel, protocols: { [protocol]: connection } };
      return {
        ...buildUserProvider(
          {
            ...legacy,
            id: channelProtocolProviderId(channel.id, protocol),
            runtimes: projectChannelRuntimes(fixed),
          },
          options,
        ),
        channel: {
          supplierId: config.id,
          id: channel.id,
          name: channel.name,
          protocols: [protocol],
          protocol,
        },
        channelConfig: fixed,
        customConfig,
      };
    }),
  ]);
  if (configuration.legacyBindings || configuration.channels.length === 0) {
    providers.push({
      ...buildUserProvider(
        {
          ...legacy,
          runtimes: configuration.channels.length
            ? projectLegacyChannelRuntimes(config)
            : {},
        },
        options,
      ),
      channel: {
        supplierId: config.id,
        id: config.id,
        name: config.name,
        protocols: [],
        legacy: true,
      },
      customConfig,
      channelAliases: Object.fromEntries(
        Object.entries(configuration.legacyBindings ?? {}).flatMap(
          ([agent, id]) => {
            const channel = configuration.channels.find(
              (entry) => entry.id === id,
            );
            return channel ? [[agent, channel]] : [];
          },
        ),
      ),
    });
  }
  for (const provider of providers) {
    if (!provider.channel || provider.channel.legacy) continue;
    const aliases = [
      ...new Set([
        provider.channel.id,
        ...(configuration.legacyBindings ? [config.id] : []),
      ]),
    ].filter((id) => id !== provider.id);
    for (const models of Object.values(provider.models)) {
      for (const model of models ?? []) model.visibilityAliases = aliases;
    }
  }
  return providers;
}
