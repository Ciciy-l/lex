import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HistoryDiskIO } from './historyDiskStore';

let io: Promise<HistoryDiskIO> | undefined;
const disk = () => io ??= import('./historyDiskStoreExpo')
  .then(({ createHistoryDiskIO }) => createHistoryDiskIO('session-messages-v1'))
  .catch(error => { io = undefined; throw error; });

async function write(key: string, value: string): Promise<void> {
  try { await (await disk()).write(`${key}.json`, value); }
  catch (error) {
    void import('./cacheWriteNotice').then(module => module.notifyCacheWriteFailure()).catch(() => undefined);
    throw error;
  }
}

// Callers serialize operations per key and fence reads/writes against logout.
// Both mobile platforms use the same private cache files, with no total quota/TTL.
export const messageCacheStorage = {
  async getItem(key: string): Promise<string | null> {
    const files = await disk();
    const current = await files.read(`${key}.json`);
    if (current !== null) return current;
    const legacy = await AsyncStorage.getItem(key);
    if (legacy === null) return null;
    try {
      await write(key, legacy);
      await AsyncStorage.removeItem(key);
    } catch { /* Migration failure must leave the old cache readable. */ }
    return legacy;
  },
  async setItem(key: string, value: string): Promise<void> {
    await write(key, value);
    // Disk is authoritative even if cleanup fails; retry on the next write.
    await AsyncStorage.removeItem(key).catch(() => undefined);
  },
  async removeItem(key: string): Promise<void> {
    const files = await disk();
    // Keep a tombstone if legacy deletion fails, so fallback cannot revive it.
    await write(key, '[]');
    await AsyncStorage.removeItem(key);
    await files.remove(`${key}.json`);
  },
  async clear(prefix: string): Promise<void> {
    const files = await disk();
    const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(`${prefix}.`));
    // If legacy cleanup fails, retain tombstones before propagating the error.
    for (const key of keys) await write(key, '[]');
    if (keys.length) await AsyncStorage.multiRemove(keys);
    for (const name of await files.files()) await files.remove(name);
  },
};
