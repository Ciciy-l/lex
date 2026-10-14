import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';
const state = vi.hoisted(() => ({
  owner: 'owner-a',
  generation: 1,
  stored: null as CustomProviderConfig | null,
  read: vi.fn(),
  readHeaders: vi.fn(),
  write: vi.fn(),
  writeHeaders: vi.fn(),
  cas: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientUserId: () => state.owner }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ generation: state.generation }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  UNRECOVERABLE_PROVIDER_CREDENTIAL: Symbol('unreadable'),
  readCustomProviderKeyForMutation: state.read,
  readCustomProviderHeadersForMutation: state.readHeaders,
  storeCustomProviderKey: state.write,
  storeCustomProviderHeaders: state.writeHeaders,
  removeCustomProviderKey: () => ({ success: true }),
  removeCustomProviderHeaders: () => ({ success: true }),
}));
vi.mock('../custom-provider-store.js', () => ({
  getCustomProvider: async () => state.stored,
  assertProviderChannelIdsAvailable: async () => undefined,
  updateCustomProviderIfUnchanged: state.cas,
}));
import { migrateProviderChannels } from '../provider-channel-secrets.js';
import { UNRECOVERABLE_PROVIDER_CREDENTIAL } from '../../secrets/providerSecretStore.js';
const legacy: CustomProviderConfig = {
  id: 'supplier',
  name: 'Supplier',
  runtimes: {
    codex: { baseUrl: 'https://a.example', models: [{ id: 'same', name: 'Same' }] },
    pi: { baseUrl: 'https://a.example', models: [{ id: 'same', name: 'Same' }] },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  state.owner = 'owner-a';
  state.generation = 1;
  state.stored = structuredClone(legacy);
  state.read.mockImplementation((_id, agent) => (agent === 'codex' ? 'key-a' : 'key-b'));
  state.readHeaders.mockReturnValue({ 'x-vendor-auth': 'header-secret' });
  state.write.mockReturnValue(true);
  state.writeHeaders.mockReturnValue(true);
  state.cas.mockImplementation(async (_id, _before, next) => {
    state.stored = { ...next, readRevision: 2 };
    return true;
  });
});
describe('encrypted channel migration publication', () => {
  it('copies each exact protocol credential before publishing and never stores plaintext', async () => {
    const result = await migrateProviderChannels(state.stored!);
    expect(state.write).toHaveBeenCalledWith(
      'supplier-channel-codex',
      'protocol-openai-responses',
      'key-a',
    );
    expect(state.write).toHaveBeenCalledWith(
      'supplier-channel-pi',
      'protocol-openai-chat',
      'key-b',
    );
    expect(state.cas).toHaveBeenCalledOnce();
    expect(state.write.mock.invocationCallOrder.at(-1)).toBeLessThan(
      state.cas.mock.invocationCallOrder[0],
    );
    expect(result.readRevision).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/key-a|key-b|header-secret/);
    const writes = state.write.mock.calls.length;
    await migrateProviderChannels(result);
    expect(state.write).toHaveBeenCalledTimes(writes);
  });
  it('keeps the original usable config when an encrypted write fails', async () => {
    state.write.mockReturnValue(false);
    expect(await migrateProviderChannels(state.stored!)).toEqual(legacy);
    expect(state.cas).not.toHaveBeenCalled();
    expect(state.stored?.channels).toBeUndefined();
  });
  it('leaves unreadable ciphertext and legacy metadata untouched', async () => {
    state.read.mockReturnValue(UNRECOVERABLE_PROVIDER_CREDENTIAL);
    expect(await migrateProviderChannels(state.stored!)).toEqual(legacy);
    expect(state.write).not.toHaveBeenCalled();
    expect(state.writeHeaders).not.toHaveBeenCalled();
    expect(state.cas).not.toHaveBeenCalled();
  });
  it('does not publish a channel plan when the metadata CAS loses to another edit', async () => {
    const newer = { ...structuredClone(legacy), name: 'Newer settings' };
    state.cas.mockImplementation(async () => { state.stored = newer; return false; });
    expect(await migrateProviderChannels(state.stored!)).toEqual(newer);
    expect(state.stored?.channels).toBeUndefined();
    expect(state.write).toHaveBeenCalledTimes(2);
  });
  it('does not publish or write later slots after the owner generation changes', async () => {
    state.write.mockImplementation(() => {
      state.generation++;
      return true;
    });
    await expect(migrateProviderChannels(state.stored!)).rejects.toThrow('owner changed');
    expect(state.cas).not.toHaveBeenCalled();
    expect(state.write).toHaveBeenCalledTimes(1);
  });
});
