import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  __testing,
  clearClipboardInvitationHistory,
  hasSeenClipboardInvitation,
  invitationDigest,
  rememberClipboardInvitation,
} from '@/device-link/clipboardInvitationHistory';

const account = '["global","mobile-account"]';
const day = 24 * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
  __testing.reset();
  storage.values.clear();
  storage.getItem.mockReset().mockImplementation(async (key: string) => storage.values.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation(async (key: string, value: string) => { storage.values.set(key, value); });
  storage.removeItem.mockReset().mockImplementation(async (key: string) => { storage.values.delete(key); });
});

afterEach(async () => {
  await __testing.flush();
  vi.useRealTimers();
});

describe('mobile shared-task clipboard invitation history', () => {
  it('stores digest-only records, keeps the newest 16, and isolates accounts', async () => {
    const digests = Array.from({ length: 18 }, (_, index) => invitationDigest(`invitation-${index}`));
    for (const digest of digests) {
      vi.setSystemTime(Date.now() + 1);
      await rememberClipboardInvitation(account, digest);
    }

    const raw = storage.values.get(__testing.storageKey(account));
    expect(raw).toBeDefined();
    expect(raw).not.toContain('invitation-17');
    expect(JSON.parse(raw!).entries).toHaveLength(16);
    expect(await hasSeenClipboardInvitation(account, digests[0])).toBe(false);
    expect(await hasSeenClipboardInvitation(account, digests[17])).toBe(true);
    expect(await hasSeenClipboardInvitation('["cn","mobile-account"]', digests[17])).toBe(false);
  });

  it('expires records at 30 days without extending the timestamp on reads', async () => {
    const digest = invitationDigest('expiring');
    await rememberClipboardInvitation(account, digest);
    const before = JSON.parse(storage.values.get(__testing.storageKey(account))!).entries[0].seenAt;
    vi.setSystemTime(Date.now() + 29 * day);
    expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
    vi.setSystemTime(Date.now() + day);
    expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
    expect(storage.values.has(__testing.storageKey(account))).toBe(false);
    expect(before).toBeLessThan(Date.now());
  });

  it('does not resurrect a retired account after an in-flight read or write', async () => {
    const digest = invitationDigest('late');
    let finishRead!: (value: string | null) => void;
    storage.getItem.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const write = rememberClipboardInvitation(account, digest);
    await Promise.resolve();
    const clearing = clearClipboardInvitationHistory(account);
    await Promise.resolve();
    finishRead(JSON.stringify({ version: 1, entries: [{ digest, seenAt: Date.now() }] }));
    await Promise.all([write, clearing]);

    expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
    expect(storage.values.has(__testing.storageKey(account))).toBe(false);
    await rememberClipboardInvitation(account, digest);
    expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  });
});
