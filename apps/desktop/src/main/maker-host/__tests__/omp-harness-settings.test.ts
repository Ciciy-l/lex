import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({
  root: '',
  owner: 'a',
  generation: 1,
  unified: true,
  drift: false,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: env.owner, generation: env.generation }),
  ownerScopedUserDataPath: () => path.join(env.root, env.owner),
}));
vi.mock('../memory-settings-store.js', () => ({
  readMemorySettings: () => ({ maker: env.unified }),
}));
vi.mock('../../device-link/crossProcessLock.js', () => {
  const lock = async (
    _path: string,
    _opts: unknown,
    action: (status: { held: boolean }) => unknown,
  ) => {
    if (env.drift) {
      env.owner = 'b';
      env.generation++;
    }
    return action({ held: true });
  };
  return { withCrossProcessLock: lock, withSecurityBoundaryLock: lock };
});
beforeEach(() => {
  vi.resetModules();
  Object.assign(env, {
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'omp-settings-')),
    owner: 'a',
    generation: 1,
    unified: true,
    drift: false,
  });
});
afterEach(() => {
  fs.rmSync(env.root, { recursive: true, force: true });
});
describe('OMP Harness owner settings', () => {
  it('persists overrides per owner and restores defaults by removing overrides', async () => {
    const store = await import('../omp-harness-settings.js');
    expect(store.ompHarnessState()).toMatchObject({
      isCustomized: false,
      value: { nativeMemory: false },
    });
    await store.writeOmpHarnessSettings({ nativeMemory: true, maxConcurrency: 4 });
    expect(store.ompHarnessState()).toMatchObject({
      unifiedEnabled: true,
      value: { nativeMemory: true },
    });
    env.owner = 'b';
    env.generation++;
    expect(store.readOmpHarnessSettings().nativeMemory).toBe(false);
    env.owner = 'a';
    env.generation++;
    expect(store.readOmpHarnessSettings().maxConcurrency).toBe(4);
    await store.writeOmpHarnessSettings({ nativeMemory: false, maxConcurrency: null });
    expect(store.ompHarnessState().isCustomized).toBe(false);
    expect(fs.existsSync(path.join(env.root, 'a', 'omp-harness-settings.json'))).toBe(false);
  });
  it('rejects invalid settings and owner drift while waiting for the write lock', async () => {
    const store = await import('../omp-harness-settings.js');
    for (const bad of [
      { maxConcurrency: -1 },
      { maxRecursionDepth: 1.5 },
      { nativeMemory: 'yes' },
      { dbPath: '/elsewhere' },
      { compactionThreshold: 99 },
    ])
      expect(() => store.parseOmpHarnessPatch(bad)).toThrow();
    env.drift = true;
    await expect(store.writeOmpHarnessSettings({ nativeMemory: true })).rejects.toThrow(
      'scope changed',
    );
    expect(store.readOmpHarnessSettings().nativeMemory).toBe(false);
  });
  it('blocks clearing an occupied database and clears only the captured owner after release', async () => {
    const store = await import('../omp-harness-settings.js');
    const file = store.ompNativeMemoryPath();
    const release = await store.acquireOmpMemoryLease(file);
    fs.writeFileSync(file, 'memory');
    await expect(store.clearOmpNativeMemory()).rejects.toThrow('OMP_MEMORY_BUSY');
    expect(fs.readFileSync(file, 'utf8')).toBe('memory');
    const other = path.join(env.root, 'b', 'omp-memory', 'data', 'mnemopi.db');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'other owner');
    await release();
    await store.clearOmpNativeMemory();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('other owner');
  });
});

it('refuses a redirected native database directory before starting a runtime', async () => {
  const store = await import('../omp-harness-settings.js');
  const dbPath = store.ompNativeMemoryPath();
  const root = path.dirname(path.dirname(dbPath));
  const outside = path.join(env.root, 'other-data');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.dirname(dbPath), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(store.acquireOmpMemoryLease(dbPath)).rejects.toThrow('INVALID_MEMORY_PATH');
  expect(fs.readdirSync(outside)).toEqual([]);
});
