import { describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';
import {
  stageProviderChannelCredentials,
  providerChannelSecretIo,
} from '../provider-channel-mutations.js';
import { UNRECOVERABLE_PROVIDER_CREDENTIAL } from '../../secrets/providerSecretStore.js';

const config = (): CustomProviderConfig => ({
  id: 'supplier',
  name: 'Supplier',
  runtimes: {},
  channels: {
    version: 1,
    channels: [
      {
        id: 'channel-a',
        name: 'A',
        protocols: {
          'google-generative-ai': {
            baseUrl: 'https://a.example',
            models: [{ id: 'same', name: 'Same' }],
          },
          'openai-responses': {
            baseUrl: 'https://b.example',
            models: [{ id: 'same', name: 'Same' }],
          },
        },
      },
    ],
  },
});

function memory() {
  const keys = new Map<string, string>();
  const headers = new Map<string, Record<string, string>>();
  const slot = (id: string, protocol: string) => id + ':' + protocol;
  const io: typeof providerChannelSecretIo = {
    readKey: vi.fn((id, protocol) => keys.get(slot(id, protocol)) ?? null),
    readHeaders: vi.fn((id, protocol) => headers.get(slot(id, protocol)) ?? null),
    storeKey: vi.fn((id, protocol, key) => {
      keys.set(slot(id, protocol), key);
      return true;
    }),
    storeHeaders: vi.fn((id, protocol, value) => {
      headers.set(slot(id, protocol), value);
      return true;
    }),
    removeKey: vi.fn((id, protocol) => {
      keys.delete(slot(id, protocol));
      return { success: true };
    }),
    removeHeaders: vi.fn((id, protocol) => {
      headers.delete(slot(id, protocol));
      return { success: true };
    }),
  };
  return { io, keys, headers };
}

describe('channel credential transaction', () => {
  it('isolates same-model protocol keys and rolls back a failed metadata commit', () => {
    const { io, keys } = memory();
    const restore = stageProviderChannelCredentials(
      config(),
      null,
      {
        'channel-a': {
          'google-generative-ai': 'google-key',
          'openai-responses': 'responses-key',
        },
      },
      () => {},
      io,
    );
    expect([...keys.values()]).toEqual(['google-key', 'responses-key']);
    expect(restore()).toBe(true);
    expect(keys.size).toBe(0);
  });
  it('clears endpoint-bound credentials without touching another protocol', () => {
    const { io, keys, headers } = memory();
    const google = 'channel-a:protocol-google-generative-ai';
    const responses = 'channel-a:protocol-openai-responses';
    keys.set(google, 'old');
    keys.set(responses, 'other');
    headers.set(google, { Authorization: 'old' });
    const before = config();
    const after = config();
    after.channels!.channels[0].protocols['google-generative-ai']!.baseUrl = 'https://new.example';
    stageProviderChannelCredentials(after, before, undefined, () => {}, io);
    expect(keys.has(google)).toBe(false);
    expect(headers.has(google)).toBe(false);
    expect(keys.get(responses)).toBe('other');
  });
  it('rolls back an earlier slot when a later encrypted write fails', () => {
    const { io, keys } = memory();
    const store = io.storeKey;
    io.storeKey = vi.fn((id, slot, key) =>
      slot.endsWith('openai-responses') ? false : store(id, slot, key),
    );
    expect(() =>
      stageProviderChannelCredentials(
        config(),
        null,
        {
          'channel-a': {
            'google-generative-ai': 'first',
            'openai-responses': 'second',
          },
        },
        () => {},
        io,
      ),
    ).toThrow('encrypted channel key');
    expect(keys.size).toBe(0);
  });
  it('rejects orphan credential input before any write', () => {
    const { io } = memory();
    expect(() =>
      stageProviderChannelCredentials(
        config(),
        null,
        { unknown: { 'openai-chat': 'key' } },
        () => {},
        io,
      ),
    ).toThrow('unconfigured');
    expect(io.storeKey).not.toHaveBeenCalled();
  });
  it('allows explicit repair but never deletes unreadable ciphertext implicitly', () => {
    const { io } = memory();
    io.readKey = vi.fn<typeof providerChannelSecretIo.readKey>(() => UNRECOVERABLE_PROVIDER_CREDENTIAL);
    expect(() => stageProviderChannelCredentials(null, config(), undefined, () => {}, io)).toThrow(
      'replacement',
    );
    expect(io.removeKey).not.toHaveBeenCalled();
    stageProviderChannelCredentials(
      config(),
      config(),
      { 'channel-a': { 'google-generative-ai': 'replacement' } },
      () => {},
      io,
    );
    expect(io.storeKey).toHaveBeenCalledWith(
      'channel-a',
      'protocol-google-generative-ai',
      'replacement',
    );
  });
  it('does not compensate into another owner after an account boundary', () => {
    const { io } = memory();
    let current = true;
    const restore = stageProviderChannelCredentials(
      config(),
      null,
      { 'channel-a': { 'google-generative-ai': 'key' } },
      () => {
        if (!current) throw new Error('owner changed');
      },
      io,
    );
    current = false;
    const before = vi.mocked(io.removeKey).mock.calls.length;
    expect(restore).toThrow('owner changed');
    expect(vi.mocked(io.removeKey).mock.calls.length).toBe(before);
  });
});
