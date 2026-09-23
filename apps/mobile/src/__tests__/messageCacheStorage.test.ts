import { beforeEach, describe, expect, it, vi } from 'vitest';
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/session/cacheWriteNotice', () => ({ notifyCacheWriteFailure: notify }));

const state = vi.hoisted(() => ({ legacy: new Map<string, string>(), files: new Map<string, string>() }));
const io = vi.hoisted(() => ({
  read: vi.fn(async (name: string) => state.files.get(name) ?? null),
  write: vi.fn(async (name: string, value: string) => { state.files.set(name, value); }),
  remove: vi.fn(async (name: string) => { state.files.delete(name); }),
  files: vi.fn(async () => [...state.files.keys()]),
}));
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => io }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => state.legacy.get(key) ?? null),
  removeItem: vi.fn(async (key: string) => { state.legacy.delete(key); }),
  getAllKeys: vi.fn(async () => [...state.legacy.keys()]),
  multiRemove: vi.fn(async (keys: readonly string[]) => { keys.forEach(key => state.legacy.delete(key)); }),
} }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { messageCacheStorage as storage } from '@/session/messageCacheStorage';

beforeEach(() => { state.legacy.clear(); state.files.clear(); vi.clearAllMocks(); });
describe('message cache file migration', () => {
  it('migrates only the requested legacy entry and reads it after module restart', async () => {
    state.legacy.set('cache.a', '[1]'); state.legacy.set('cache.b', '[2]');
    expect(await storage.getItem('cache.a')).toBe('[1]');
    expect(state.files.get('cache.a.json')).toBe('[1]');
    expect(state.legacy.has('cache.a')).toBe(false);
    expect(state.legacy.get('cache.b')).toBe('[2]');
    vi.resetModules();
    const restarted = (await import('@/session/messageCacheStorage')).messageCacheStorage;
    expect(await restarted.getItem('cache.a')).toBe('[1]');
  });
  it('keeps legacy content readable if migration cannot write', async () => {
    state.legacy.set('cache.a', '[1]');
    io.write.mockRejectedValueOnce(new Error('disk full'));
    expect(await storage.getItem('cache.a')).toBe('[1]');
    expect(state.legacy.get('cache.a')).toBe('[1]');
    expect(state.files.size).toBe(0);
    expect(await storage.getItem('cache.a')).toBe('[1]');
    expect(state.legacy.size).toBe(0);
  });
  it('preserves the committed file when replacement fails', async () => {
    await storage.setItem('cache.a', 'old');
    io.write.mockRejectedValueOnce(new Error('disk full'));
    await expect(storage.setItem('cache.a', 'new')).rejects.toThrow();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(await storage.getItem('cache.a')).toBe('old');
  });
  it('never falls back to stale legacy content after a successful replacement', async () => {
    state.legacy.set('cache.a', 'old');
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('busy'));
    await storage.setItem('cache.a', 'new');
    expect(await storage.getItem('cache.a')).toBe('new');
  });
  it('propagates failed legacy deletion without removing the authoritative file', async () => {
    state.legacy.set('cache.a', 'old');
    state.files.set('cache.a.json', 'new');
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('busy'));
    await expect(storage.removeItem('cache.a')).rejects.toThrow();
    expect(await storage.getItem('cache.a')).toBe('new');
    await storage.removeItem('cache.a');
    expect(await storage.getItem('cache.a')).toBeNull();
  });
  it('deletes both backends without writing when the disk is full', async () => {
    state.legacy.set('cache.a', 'old');
    state.files.set('cache.a.json', 'new');
    await storage.removeItem('cache.a');
    expect(state.legacy.size).toBe(0);
    expect(state.files.size).toBe(0);
    expect(io.write).not.toHaveBeenCalled();
  });
  it.each(['enumerate', 'legacy', 'files'])('propagates %s cleanup failure and supports retry', async kind => {
    state.legacy.set('cache.a', 'old');
    state.files.set('cache.a.json', 'new');
    const error = new Error('storage unavailable');
    if (kind === 'enumerate') vi.mocked(AsyncStorage.getAllKeys).mockRejectedValueOnce(error);
    if (kind === 'legacy') vi.mocked(AsyncStorage.multiRemove).mockRejectedValueOnce(error);
    if (kind === 'files') io.remove.mockRejectedValueOnce(error);
    await expect(storage.clear('cache')).rejects.toThrow(error);
    await storage.clear('cache');
    expect(await storage.getItem('cache.a')).toBeNull();
    expect(io.write).not.toHaveBeenCalled();
  });
  it('does not hide an IO failure by falling back to older data', async () => {
    state.legacy.set('cache.a', 'old');
    io.read.mockRejectedValueOnce(new Error('read failed'));
    await expect(storage.getItem('cache.a')).rejects.toThrow();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  });
  it('clears both backends while leaving preferences alone', async () => {
    state.legacy.set('cache.a', 'old'); state.legacy.set('preferences', 'keep');
    await storage.setItem('cache.b', 'new');
    await storage.clear('cache');
    expect(state.files.size).toBe(0);
    expect([...state.legacy]).toEqual([['preferences', 'keep']]);
  });
  it('retains files beyond 6 MB total without evicting earlier entries', async () => {
    const body = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 8; i++) await storage.setItem(`cache.${i}`, body);
    expect(state.files.size).toBe(8);
    expect(await storage.getItem('cache.0')).toBe(body);
    expect(state.legacy.size).toBe(0);
  });
});
