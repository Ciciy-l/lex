import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HistoryDiskIO } from './historyDiskStore';

let io: Promise<HistoryDiskIO> | undefined;
const disk = () => io ??= import('./historyDiskStoreExpo')
  .then(({ createHistoryDiskIO }) => createHistoryDiskIO('session-messages-v1'))
  .catch(error => { io = undefined; throw error; });

async function persist(operation: () => Promise<void>): Promise<void> {
  try { await operation(); }
  catch (error) {
    void import('./cacheWriteNotice').then(module => module.notifyCacheWriteFailure()).catch(() => undefined);
    throw error;
  }
}

function write(key: string, value: string): Promise<void> {
  return persist(async () => { await (await disk()).write(`${key}.json`, value); });
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
    await persist(async () => {
      const files = await disk();
      // Delete fallback first: deletion must not need free space for a new file.
      await AsyncStorage.removeItem(key);
      await files.remove(`${key}.json`);
    });
  },
  async clear(prefix: string): Promise<void> {
    await persist(async () => {
      const files = await disk();
      const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(`${prefix}.`));
      if (keys.length) await AsyncStorage.multiRemove(keys);
      for (const name of await files.files()) await files.remove(name);
    });
  },
};
