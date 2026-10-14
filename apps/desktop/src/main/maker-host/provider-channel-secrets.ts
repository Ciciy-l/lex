import { createHash } from 'node:crypto';
import {
  planLegacyProviderChannels,
  type AgentKind,
  type CustomProviderConfig,
  type ProviderWireProtocol,
} from '@cindy/model-providers';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  readCustomProviderKeyForMutation,
  readCustomProviderHeadersForMutation,
  storeCustomProviderKey,
  storeCustomProviderHeaders,
  UNRECOVERABLE_PROVIDER_CREDENTIAL,
  removeCustomProviderKey,
  removeCustomProviderHeaders,
} from '../secrets/providerSecretStore.js';
import {
  assertProviderChannelIdsAvailable,
  getCustomProvider,
  updateCustomProviderIfUnchanged,
} from './custom-provider-store.js';
import { isManagedSidecarProviderId } from '../../shared/localModelRuntime.js';
import {
  providerStorageMutationPending,
  withProviderStorageMutation,
} from './provider-storage-mutation.js';

export function channelCredentialSlot(protocol: ProviderWireProtocol): string {
  return `protocol-${protocol}`;
}

/**
 * Copy first, publish second. Old secrets and route IDs remain intact. A crash
 * before CAS leaves only encrypted, owner-scoped copies; the next load resumes.
 * No secret is ever stored in the migration record or diagnostics.
 */
export async function migrateProviderChannels(
  config: CustomProviderConfig,
): Promise<CustomProviderConfig> {
  if (
    config.channels ||
    config.auth?.method === 'oauth' ||
    isManagedSidecarProviderId(config.id) ||
    providerStorageMutationPending()
  )
    return config;
  const owner = getCurrentDbClientUserId();
  const generation = getActiveAppSession().generation;
  if (!owner || isAppSessionBoundaryPending()) return config;
  return withProviderStorageMutation(async () => {
    const assertOwner = (): void => {
      if (
        getCurrentDbClientUserId() !== owner ||
        isAppSessionBoundaryPending() ||
        getActiveAppSession().generation !== generation
      )
        throw new Error('Provider channel migration owner changed');
    };
    try {
      assertOwner();
      const fresh = await getCustomProvider(config.id);
      assertOwner();
      if (!fresh || fresh.channels) return fresh ?? config;
      config = fresh;
      const snapshots = new Map<
        AgentKind,
        { key: string | null; headers: Record<string, string> | null }
      >();
      const identities: Partial<Record<AgentKind, string>> = {};
      for (const agent of Object.keys(config.runtimes) as AgentKind[]) {
        const key = readCustomProviderKeyForMutation(config.id, agent);
        const headers = readCustomProviderHeadersForMutation(config.id, agent);
        if (
          key === UNRECOVERABLE_PROVIDER_CREDENTIAL ||
          headers === UNRECOVERABLE_PROVIDER_CREDENTIAL
        )
          return config;
        snapshots.set(agent, { key, headers });
        identities[agent] = createHash('sha256')
          .update(JSON.stringify([key, headers]))
          .digest('hex');
      }
      const planned = planLegacyProviderChannels(config, identities);
      if (!planned) return config;
      const latest = await getCustomProvider(config.id);
      assertOwner();
      if (!latest || latest.channels) return latest ?? config;
      if (JSON.stringify(latest.runtimes) !== JSON.stringify(config.runtimes)) return latest;
      await assertProviderChannelIdsAvailable({ ...config, channels: planned.configuration });
      for (const copy of planned.credentials) {
        assertOwner();
        const source = snapshots.get(copy.agent)!;
        const slot = channelCredentialSlot(copy.protocol);
        // A previous unpublished copy is not authoritative. Missing source secrets
        // must also overwrite it, otherwise a crash/retry can resurrect stale keys.
        if (
          !(source.key === null
            ? removeCustomProviderKey(copy.channelId, slot).success
            : storeCustomProviderKey(copy.channelId, slot, source.key))
        )
          throw new Error('Could not copy encrypted channel credential');
        assertOwner();
        if (
          !(source.headers === null
            ? removeCustomProviderHeaders(copy.channelId, slot).success
            : storeCustomProviderHeaders(copy.channelId, slot, source.headers))
        )
          throw new Error('Could not copy encrypted channel headers');
      }
      assertOwner();
      const migrated = { ...config, channels: planned.configuration };
      const published = await updateCustomProviderIfUnchanged(config.id, config, migrated);
      assertOwner();
      const result = (await getCustomProvider(config.id)) ?? (published ? migrated : config);
      assertOwner();
      return result;
    } catch {
      // The legacy connection remains usable; unpublished encrypted copies are
      // retried on the next load. Never cross an owner transition for fallback.
      assertOwner();
      return config;
    }
  });
}
