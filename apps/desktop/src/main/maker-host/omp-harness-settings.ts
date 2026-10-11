import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OMP_HARNESS_DEFAULTS,
  type OmpHarnessSettings,
  type OmpHarnessState,
} from '../../shared/harnessSettings.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { readMemorySettings } from './memory-settings-store.js';
import { createLogger } from '../logger.js';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';

const log = createLogger('omp-harness-settings');
const numeric: Partial<Record<keyof OmpHarnessSettings, readonly [number, number]>> = {
  maxConcurrency: [0, 128],
  maxRecursionDepth: [0, 16],
  compactionThreshold: [50, 95],
  keepRecentTokens: [0, 1_000_000],
};
export function parseOmpHarnessPatch(raw: unknown): Partial<OmpHarnessSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('INVALID_OMP_SETTINGS');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(OMP_HARNESS_DEFAULTS, key)) throw new Error('INVALID_OMP_SETTING');
    if (key === 'subagentModel') {
      if (
        value !== null &&
        (typeof value !== 'string' ||
          !value.trim() ||
          value.length > 256 ||
          /[\x00-\x1f\x7f]/.test(value))
      )
        throw new Error('INVALID_OMP_MODEL');
      patch[key] = typeof value === 'string' ? value.trim() : null;
    } else if (numeric[key as keyof OmpHarnessSettings]) {
      const [min, max] = numeric[key as keyof OmpHarnessSettings]!;
      if (
        value !== null &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      )
        throw new Error('INVALID_OMP_RANGE');
      patch[key] = value;
    } else {
      if (typeof value !== 'boolean') throw new Error('INVALID_OMP_BOOLEAN');
      patch[key] = value;
    }
  }
  return patch;
}
function normalize(raw: unknown): OmpHarnessSettings {
  const result = { ...OMP_HARNESS_DEFAULTS };
  if (raw && typeof raw === 'object')
    for (const [key, value] of Object.entries(raw)) {
      try {
        Object.assign(result, parseOmpHarnessPatch({ [key]: value }));
      } catch {
        /* preserve valid keys */
      }
    }
  return result;
}
const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<OmpHarnessSettings>>>();
function currentStore() {
  const root = ownerScopedUserDataPath();
  let store = stores.get(root);
  if (!store) {
    store = createOverrideSettingsFile({
      filePath: () => path.join(root, 'omp-harness-settings.json'),
      defaults: OMP_HARNESS_DEFAULTS,
      normalize,
      log,
      label: 'OMP Harness',
      scopeKey: () => String(getActiveAppSession().generation) + ':' + ownerScopedUserDataPath(),
      maxBytes: 16 * 1024,
      preserveUnreadableFile: true,
      logLoadedValue: false,
    });
    stores.set(root, store);
  }
  store.invalidateIfChanged();
  return store;
}
export function readOmpHarnessSettings(): OmpHarnessSettings {
  return currentStore().read();
}
export function ompHarnessState(): OmpHarnessState {
  return {
    ...currentStore().readState(),
    unifiedEnabled: readMemorySettings().maker,
    ownerGeneration: getActiveAppSession().generation,
  };
}
export async function writeOmpHarnessSettings(
  patch: Partial<OmpHarnessSettings>,
): Promise<OmpHarnessState> {
  if (!getActiveAppSession().dataOwnerId) throw new Error('ACCOUNT_REQUIRED');
  const generation = getActiveAppSession().generation;
  await currentStore().writePatchAtomic(parseOmpHarnessPatch(patch));
  if (getActiveAppSession().generation !== generation) throw new Error('ACCOUNT_CHANGED');
  return ompHarnessState();
}
export function ompNativeMemoryPath(): string {
  return path.join(ownerScopedUserDataPath(), 'omp-memory', 'data', 'mnemopi.db');
}

function assertCanonicalMemoryPath(target: string, root: string): void {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const ownerRoot = path.dirname(root);
  const expected = path.join(fs.realpathSync(ownerRoot), path.relative(ownerRoot, target));
  if (
    fs.lstatSync(ownerRoot).isSymbolicLink() ||
    fs.lstatSync(target).isSymbolicLink() ||
    normalize(fs.realpathSync(target)) !== normalize(expected)
  )
    throw new Error('INVALID_MEMORY_PATH');
}

/** A short cross-process gate admits a runtime lease or clears idle data, never both. */
async function memoryGate<T>(root: string, action: () => Promise<T>): Promise<T> {
  await fs.promises.mkdir(root, { recursive: true });
  assertCanonicalMemoryPath(root, root);
  return withSecurityBoundaryLock(
    path.join(root, 'memory.lock'),
    { label: 'omp-memory' },
    async (lock) => {
      if (!lock.held) throw new Error('OMP_MEMORY_BUSY');
      assertCanonicalMemoryPath(root, root);
      return action();
    },
  );
}
export async function acquireOmpMemoryLease(dbPath: string): Promise<() => Promise<void>> {
  const root = path.dirname(path.dirname(dbPath));
  const owner = getActiveAppSession().generation;
  if (dbPath !== ompNativeMemoryPath() || !getActiveAppSession().dataOwnerId)
    throw new Error('ACCOUNT_CHANGED');
  const file = path.join(root, 'lease-' + process.pid + '-' + randomUUID());
  await memoryGate(root, async () => {
    if (owner !== getActiveAppSession().generation) throw new Error('ACCOUNT_CHANGED');
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    assertCanonicalMemoryPath(path.dirname(dbPath), root);
    if (fs.existsSync(dbPath)) assertCanonicalMemoryPath(dbPath, root);
    if (owner !== getActiveAppSession().generation) throw new Error('ACCOUNT_CHANGED');
    await fs.promises.writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  });
  return async () => {
    await fs.promises.rm(file, { force: true });
  };
}
export async function clearOmpNativeMemory(): Promise<void> {
  if (!getActiveAppSession().dataOwnerId) throw new Error('ACCOUNT_REQUIRED');
  const root = path.dirname(path.dirname(ompNativeMemoryPath()));
  const owner = getActiveAppSession().generation;
  await memoryGate(root, async () => {
    if (owner !== getActiveAppSession().generation) throw new Error('ACCOUNT_CHANGED');
    for (const file of await fs.promises.readdir(root)) {
      if (!file.startsWith('lease-')) continue;
      const pid = Number(file.split('-')[1]);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive) throw new Error('OMP_MEMORY_BUSY');
      await fs.promises.rm(path.join(root, file), { force: true });
    }
    // Rename only the captured account's fixed data directory before recursive cleanup.
    const data = path.join(root, 'data');
    const trash = path.join(root, 'cleared-' + randomUUID());
    if (!fs.existsSync(data)) return;
    if (owner !== getActiveAppSession().generation) throw new Error('ACCOUNT_CHANGED');
    assertCanonicalMemoryPath(root, root);
    assertCanonicalMemoryPath(data, root);
    await fs.promises.rename(data, trash);
    await fs.promises.rm(trash, { recursive: true, force: true });
  });
}
