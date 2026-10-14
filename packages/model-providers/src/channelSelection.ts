import type { ProviderView } from "./registry.js";
import type { UnifiedModelEntry } from "./unifiedSelection.js";
import { providerChannelGroupKey } from "./providerChannels.js";

/** Presentation only. Never merge capabilities, prices or model IDs from
 * different connections. The returned entry is always a real selectable route. */
export function groupProviderChannelEntries(
  entries: readonly UnifiedModelEntry[],
  providers: readonly ProviderView[],
  selected?: { providerId: string | null; modelId: string },
): UnifiedModelEntry[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const groups = new Map<string, UnifiedModelEntry[]>();
  for (const entry of entries) {
    const channel = byId.get(entry.providerId)?.channel;
    if (channel?.legacy && selected?.providerId !== entry.providerId) continue;
    const key = channel
      ? providerChannelGroupKey(channel.supplierId, entry.modelId)
      : providerChannelGroupKey(entry.providerId, entry.modelId);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map(
    (group) =>
      group.find(
        (entry) =>
          selected?.providerId === entry.providerId &&
          (entry.modelId === selected.modelId ||
            Object.values(entry.capabilities).some(
              (cap) => cap?.wireModelId === selected.modelId,
            )),
      ) ??
      group.find((entry) => {
        const channel = byId.get(entry.providerId)?.channel;
        return channel && !channel.protocol && !channel.legacy;
      }) ??
      group[0],
  );
}

export function providerChannelChoices(
  entry: UnifiedModelEntry,
  entries: readonly UnifiedModelEntry[],
  providers: readonly ProviderView[],
): UnifiedModelEntry[] {
  const channel = providers.find(
    (provider) => provider.id === entry.providerId,
  )?.channel;
  if (!channel) return [];
  const ids = new Set(
    providers
      .filter(
        (provider) =>
          provider.channel?.supplierId === channel.supplierId &&
          (!provider.channel.legacy || provider.id === entry.providerId),
      )
      .map((provider) => provider.id),
  );
  return entries.filter(
    (candidate) =>
      ids.has(candidate.providerId) && candidate.modelId === entry.modelId,
  );
}
