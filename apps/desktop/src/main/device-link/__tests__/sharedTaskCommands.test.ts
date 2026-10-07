import { describe, expect, it, vi } from 'vitest';
import type { SharedTaskApi, SharedTaskListItem } from '@cindy/device-link';
import { executeSharedTaskAccountCommand } from '../sharedTaskCommands.js';

function listItem(sharedTaskId: string, overrides: Partial<SharedTaskListItem> = {}): SharedTaskListItem {
  return {
    sharedTaskId, sessionId: 'session-' + sharedTaskId, ownerAccountId: 'owner',
    hostDeviceId: 'device-a', title: 'task ' + sharedTaskId, revision: 1, ...overrides,
  };
}

function api(items: SharedTaskListItem[], failing = new Set<string>()): SharedTaskApi {
  return {
    list: vi.fn(async () => items),
    close: vi.fn(async (sharedTaskId: string) => {
      if (failing.has(sharedTaskId)) throw new Error('server busy');
      return { sharedTaskId, status: 'closed' as const };
    }),
  } as unknown as SharedTaskApi;
}

describe('sharedTask account commands', () => {
  it('lists owned shares for the caller account and flags locally hosted ones', async () => {
    const list = [listItem('a'), listItem('b', { ownerAccountId: 'someone-else' }), listItem('c', { hostDeviceId: 'device-b' })];
    const result = await executeSharedTaskAccountCommand({ action: 'owned' }, api(list), 'owner', { hostedIds: () => ['a'] });
    expect(result).toEqual([
      { ...listItem('a'), local: true },
      { ...listItem('c', { hostDeviceId: 'device-b' }), local: false },
    ]);
  });

  it('returns no owned shares without an account', async () => {
    const listSpy = api([listItem('a')]);
    expect(await executeSharedTaskAccountCommand({ action: 'owned' }, listSpy, undefined)).toEqual([]);
    expect(listSpy.list).not.toHaveBeenCalled();
  });

  it('closes a locally hosted task through the host journal, not the raw api', async () => {
    const closeHosted = vi.fn(async () => undefined);
    const listSpy = api([listItem('a')]);
    const result = await executeSharedTaskAccountCommand({ action: 'close', sharedTaskId: 'a' }, listSpy, 'owner',
      { hostedIds: () => ['a'], closeHosted });
    expect(closeHosted).toHaveBeenCalledWith('a');
    expect(listSpy.close).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: ['a'], failed: [] });
  });

  it('closes remote-hosted tasks through the authenticated physical host and keeps failed items for retry', async () => {
    const closeHosted = vi.fn(async () => undefined);
    const closeRemoteHosted = vi.fn(async (sharedTaskId: string) => {
      if (new Set(['c']).has(sharedTaskId)) throw new Error('host offline');
    });
    const listSpy = api([listItem('a'), listItem('b', { hostDeviceId: 'device-b' }), listItem('c', { hostDeviceId: 'device-b' })], new Set(['c']));
    const result = await executeSharedTaskAccountCommand({ action: 'close', all: true }, listSpy, 'owner',
      { hostedIds: () => ['a'], closeHosted, closeRemoteHosted });
    expect(closeHosted).toHaveBeenCalledTimes(1);
    expect(closeRemoteHosted).toHaveBeenNthCalledWith(1, 'b', 'device-b');
    expect(closeRemoteHosted).toHaveBeenNthCalledWith(2, 'c', 'device-b');
    expect(listSpy.close).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: ['a', 'b'], failed: [{ sharedTaskId: 'c' }] });
  });

  it('rejects a renderer id not owned by the captured account and never reaches the API close fallback', async () => {
    const listSpy = api([listItem('owned'), listItem('joined', { ownerAccountId: 'other' })]);
    const closeRemoteHosted = vi.fn(async () => undefined);
    const result = await executeSharedTaskAccountCommand({ action: 'close', sharedTaskId: 'joined' }, listSpy, 'owner', { closeRemoteHosted });
    expect(result).toEqual({ closed: [], failed: [{ sharedTaskId: 'joined' }] });
    expect(closeRemoteHosted).not.toHaveBeenCalled();
    expect(listSpy.close).not.toHaveBeenCalled();
  });

  it('stops a frozen all-target batch when the owner scope changes while a host closes', async () => {
    let current = true;
    let release!: () => void;
    const closeRemoteHosted = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      current = false;
    });
    const listSpy = api([listItem('a', { hostDeviceId: 'device-a' }), listItem('b', { hostDeviceId: 'device-b' })]);
    const promise = executeSharedTaskAccountCommand({ action: 'close', all: true }, listSpy, 'owner', { closeRemoteHosted, isCurrent: () => current });
    await vi.waitFor(() => expect(closeRemoteHosted).toHaveBeenCalledWith('a', 'device-a'));
    release();
    await expect(promise).resolves.toEqual({ closed: [], failed: [{ sharedTaskId: 'a' }] });
    expect(closeRemoteHosted).toHaveBeenCalledTimes(1);
  });

  it('discards a late owner list before any close starts', async () => {
    let release!: (items: SharedTaskListItem[]) => void;
    const listSpy = api([]);
    listSpy.list = vi.fn(() => new Promise<SharedTaskListItem[]>(resolve => { release = resolve; })) as typeof listSpy.list;
    let current = true;
    const closeRemoteHosted = vi.fn(async () => undefined);
    const pending = executeSharedTaskAccountCommand({ action: 'close', all: true }, listSpy, 'owner', {
      closeRemoteHosted,
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(listSpy.list).toHaveBeenCalledTimes(1));
    current = false;
    release([listItem('late', { hostDeviceId: 'device-b' })]);
    await expect(pending).resolves.toEqual({ closed: [], failed: [] });
    expect(closeRemoteHosted).not.toHaveBeenCalled();
  });

  it('still rejects unknown account commands', async () => {
    await expect(executeSharedTaskAccountCommand({ action: 'nope' }, api([]), 'owner'))
      .rejects.toThrow('INVALID_PARAMS');
  });
});
