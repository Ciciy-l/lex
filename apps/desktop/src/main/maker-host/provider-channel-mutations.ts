import {
  isProviderWireProtocol,
  type CustomProviderConfig,
  type ProviderWireProtocol,
} from '@cindy/model-providers';
import type { ProviderChannelKeys } from '../../shared/customProviderUpdate.js';
import {
  readCustomProviderKeyForMutation,
  readCustomProviderHeadersForMutation,
  storeCustomProviderKey,
  storeCustomProviderHeaders,
  removeCustomProviderKey,
  removeCustomProviderHeaders,
  UNRECOVERABLE_PROVIDER_CREDENTIAL,
} from '../secrets/providerSecretStore.js';
import { channelCredentialSlot } from './provider-channel-secrets.js';

export const providerChannelSecretIo = {
  readKey: readCustomProviderKeyForMutation,
  readHeaders: readCustomProviderHeadersForMutation,
  storeKey: storeCustomProviderKey,
  storeHeaders: storeCustomProviderHeaders,
  removeKey: removeCustomProviderKey,
  removeHeaders: removeCustomProviderHeaders,
};

export function parseProviderChannelKeys(input: unknown): ProviderChannelKeys | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.keys(input).length > 64) return null;
  const keys: ProviderChannelKeys = Object.create(null);
  for (const [id, value] of Object.entries(input)) {
    if (
      !/^[a-z0-9_-]{1,128}$/u.test(id) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return null;
    const entries = Object.entries(value);
    if (
      entries.some(
        ([protocol, key]) =>
          !isProviderWireProtocol(protocol) || typeof key !== 'string' || key.length > 32768,
      )
    )
      return null;
    keys[id] = Object.fromEntries(entries);
  }
  return keys;
}

/** Invoked only inside the supplier mutation queue, after capturing its owner. */
export function stageProviderChannelCredentials(
  next: CustomProviderConfig | null,
  previous: CustomProviderConfig | null,
  keys: ProviderChannelKeys | undefined,
  assertOwner: () => void,
  io = providerChannelSecretIo,
): () => boolean {
  const nextChannels = next?.channels?.channels ?? [];
  for (const [id, protocols] of Object.entries(keys ?? {})) {
    const channel = nextChannels.find((entry) => entry.id === id);
    if (
      !channel ||
      Object.keys(protocols).some(
        (protocol) => !channel.protocols[protocol as ProviderWireProtocol],
      )
    )
      throw new Error('Credential input refers to an unconfigured channel protocol');
  }
  const ids = [
    ...new Set(
      [...nextChannels, ...(previous?.channels?.channels ?? [])].map((channel) => channel.id),
    ),
  ];
  type OldKey = ReturnType<typeof io.readKey>;
  type OldHeaders = ReturnType<typeof io.readHeaders>;
  const mutations: {
    id: string;
    slot: string;
    oldKey: OldKey;
    newKey: OldKey;
    oldHeaders: OldHeaders;
    newHeaders: OldHeaders;
  }[] = [];
  assertOwner();
  for (const id of ids) {
    const channel = nextChannels.find((entry) => entry.id === id);
    const oldChannel = previous?.channels?.channels.find((entry) => entry.id === id);
    for (const protocol of new Set([
      ...Object.keys(channel?.protocols ?? {}),
      ...Object.keys(oldChannel?.protocols ?? {}),
    ])) {
      if (!isProviderWireProtocol(protocol)) throw new Error('Unknown channel protocol');
      const connection = channel?.protocols[protocol];
      const oldConnection = oldChannel?.protocols[protocol];
      const slot = channelCredentialSlot(protocol);
      const oldKey = io.readKey(id, slot);
      const oldHeaders = io.readHeaders(id, slot);
      const changed =
        !!oldConnection &&
        (connection?.baseUrl !== oldConnection.baseUrl ||
          connection?.modelsUrl !== oldConnection.modelsUrl);
      const supplied = keys?.[id]?.[protocol];
      const newKey =
        !connection || next?.auth?.method === 'none'
          ? null
          : supplied !== undefined
            ? supplied.trim() || null
            : changed || !oldConnection
              ? null
              : oldKey;
      const newHeaders =
        !connection || next?.auth?.method === 'none'
          ? null
          : connection.headers !== undefined
            ? Object.keys(connection.headers).length
              ? connection.headers
              : null
            : changed || !oldConnection
              ? null
              : oldHeaders;
      // Unreadable ciphertext may stay untouched on a metadata-only edit. Only
      // an explicit nonempty replacement authorizes repair, as for legacy keys.
      if (
        (oldKey === UNRECOVERABLE_PROVIDER_CREDENTIAL && newKey !== oldKey && !supplied?.trim()) ||
        (oldHeaders === UNRECOVERABLE_PROVIDER_CREDENTIAL &&
          newHeaders !== oldHeaders &&
          (!connection?.headers || !Object.keys(connection.headers).length))
      )
        throw new Error(
          'Existing channel credentials cannot be decrypted; enter a replacement first',
        );
      mutations.push({ id, slot, oldKey, newKey, oldHeaders, newHeaders });
    }
  }
  const rollback: (() => boolean)[] = [];
  const restore = (): boolean => {
    assertOwner();
    let ok = true;
    for (const undo of [...rollback].reverse()) {
      if (!undo()) ok = false;
    }
    return ok;
  };
  try {
    for (const change of mutations) {
      assertOwner();
      if (change.newKey !== change.oldKey && typeof change.newKey !== 'symbol') {
        const undo = () =>
          typeof change.oldKey === 'string'
            ? io.storeKey(change.id, change.slot, change.oldKey)
            : io.removeKey(change.id, change.slot).success;
        if (typeof change.oldKey !== 'symbol') rollback.push(undo);
        const ok =
          change.newKey === null
            ? io.removeKey(change.id, change.slot).success
            : io.storeKey(change.id, change.slot, change.newKey);
        if (!ok) throw new Error('Could not store encrypted channel key');
        if (typeof change.oldKey === 'symbol') rollback.push(undo);
      }
      assertOwner();
      if (
        JSON.stringify(change.newHeaders) !== JSON.stringify(change.oldHeaders) &&
        typeof change.newHeaders !== 'symbol'
      ) {
        const undo = () =>
          change.oldHeaders && typeof change.oldHeaders === 'object'
            ? io.storeHeaders(change.id, change.slot, change.oldHeaders)
            : io.removeHeaders(change.id, change.slot).success;
        if (typeof change.oldHeaders !== 'symbol') rollback.push(undo);
        const ok =
          change.newHeaders === null
            ? io.removeHeaders(change.id, change.slot).success
            : io.storeHeaders(change.id, change.slot, change.newHeaders);
        if (!ok) throw new Error('Could not store encrypted channel headers');
        if (typeof change.oldHeaders === 'symbol') rollback.push(undo);
      }
    }
  } catch (error) {
    if (!restore())
      throw new Error('Channel credential update could not be rolled back', { cause: error });
    throw error;
  }
  return restore;
}
