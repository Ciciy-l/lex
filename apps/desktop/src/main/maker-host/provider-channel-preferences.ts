import { legacyChannelModelPreferenceId, type AgentKind } from '@cindy/model-providers';
import { getActiveCatalog } from './active-catalog.js';

/** Keep existing preferences editable/resettable through either identity of the
 * same migrated route. This does not join different channels or protocols. */
export function providerChannelPreferenceTarget<
  T extends { providerId: string; agent: AgentKind; modelId: string },
>(target: T): T {
  const provider = getActiveCatalog().providers.find((entry) => entry.id === target.providerId);
  const previousId =
    provider && legacyChannelModelPreferenceId(provider, target.agent, target.modelId);
  return previousId ? { ...target, providerId: previousId } : target;
}

/** Refresh all live identities that share an edited legacy preference. */
export function providerChannelPreferenceAliases<
  T extends { providerId: string; agent: AgentKind; modelId: string },
>(targets: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const target of targets) {
    const source = providerChannelPreferenceTarget(target);
    const add = (value: T) =>
      result.set(JSON.stringify([value.agent, value.providerId, value.modelId]), value);
    add(target);
    add(source);
    for (const provider of getActiveCatalog().providers) {
      if (
        legacyChannelModelPreferenceId(provider, target.agent, target.modelId) === source.providerId
      )
        add({ ...target, providerId: provider.id });
    }
  }
  return [...result.values()];
}
