import { beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { disk.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { disk.delete(key); }),
  getAllKeys: vi.fn(async () => [...disk.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => disk.delete(key)); }),
} }));
import { cacheRemoteResourceHome, cacheRemoteResourceItems, clearRemoteResourceCache, isRemoteResourceUnread, markRemoteResourceRead, readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
const rows = (deviceId: string, lastReplyAt: number) => [{
  key: `${deviceId}:project:writer`, host: { deviceId, deviceName: deviceId },
  item: { ref: { collectionId: 'projects', kind: 'project', id: 'writer' }, display: { title: 'Writer', lastReplyAt }, revision: '1', links: [] },
}];
beforeEach(async () => { await clearRemoteResourceCache(); disk.clear(); });
it('hides retired cache entries on read without rewriting their stored bytes', async () => {
  const old = JSON.stringify({ home: [{ id: 'teammates', title: 'Old', resourceKind: 'bot', targets: [{ deviceId: 'home', deviceName: 'Home' }] }],
    items: { teammates: [{ ...rows('home', 100)[0], item: { ...rows('home', 100)[0].item, ref: { collectionId: 'teammates', kind: 'bot', id: 'old' } } }] }, read: {} });
  disk.set('cindy.remoteResources.v1.legacy-owner', old);
  expect(await readRemoteResourceSnapshot('legacy-owner')).toEqual({ home: [], items: {}, read: {} });
  expect(disk.get('cindy.remoteResources.v1.legacy-owner')).toBe(old);
});
it('keeps device-qualified read positions and treats only later host replies as unread', async () => {
  await cacheRemoteResourceItems('alice', 'projects', [...rows('home', 100), ...rows('office', 100)]);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 100)).toBe(false);
  await cacheRemoteResourceItems('alice', 'projects', [...rows('home', 200), ...rows('office', 100)]);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(true);
  expect(isRemoteResourceUnread('alice', 'office', 'writer', 100)).toBe(false);
  await markRemoteResourceRead('alice', 'home', 'writer', 200);
  await markRemoteResourceRead('alice', 'home', 'writer', 100);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(false);
  expect((await readRemoteResourceSnapshot('bob')).items).toEqual({});
});
it('restores portable roster data after process restart and never persists runtime facts', async () => {
  await cacheRemoteResourceHome('alice', [{ id: 'projects', title: 'Projects', resourceKind: 'project', targets: [{ deviceId: 'home', deviceName: 'Home' }] }]);
  const items = rows('home', 100);
  Object.assign(items[0].item, { permissionSnapshot: { secret: 'private' }, online: true });
  await cacheRemoteResourceItems('alice', 'projects', items);
  vi.resetModules();
  const fresh = await import('@/device-link/remoteResourceCache');
  const restored = await fresh.readRemoteResourceSnapshot('alice');
  expect(restored.home[0].targets[0].deviceId).toBe('home');
  expect(restored.items.projects[0].item.display.title).toBe('Writer');
  expect(JSON.stringify(restored)).not.toContain('permissionSnapshot');
  expect(JSON.stringify(restored)).not.toContain('online');
  await fresh.clearRemoteResourceCache();
  expect(disk.size).toBe(0);
});
