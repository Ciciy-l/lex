import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CacheFileReadHandle, CacheFileReadFs } from '../remote-file-cache.js';

const state = vi.hoisted(() => ({ userDataDir: '', ownerScope: 'owner-a:1', boundaryPending: false }));
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-remote-cache-version-test-'));
state.userDataDir = userDataDir;

vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.ownerScope,
  dataOwnerStorageKey: (ownerId: string) => ownerId,
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const {
  fetchRemoteFileToCache,
  findStaleCached,
  getRemoteFileCacheRoot,
  isInsideCacheDir,
  putCachedContent,
  readCachedFileContent,
  __cacheTesting,
} = await import('../remote-file-cache.js');

const id = {
  transport: 'device' as const,
  endpointId: 'device',
  workdir: '/repo',
  relPath: 'a.txt',
  size: 3,
  mtimeMs: 1000.1,
};

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  state.ownerScope = 'owner-a:1';
  state.boundaryPending = false;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(userDataDir, { recursive: true, force: true });
});

it('retains separate exact file versions for stale fallback', async () => {
  const oldPath = await fetchRemoteFileToCache(id, (dest) => fs.writeFile(dest, 'old'), vi.fn());
  const changed = { ...id, mtimeMs: 2000 };
  const newPath = await fetchRemoteFileToCache(changed, (dest) => fs.writeFile(dest, 'new'), vi.fn());

  expect(newPath).not.toBe(oldPath);
  expect(await fs.readFile(oldPath, 'utf8')).toBe('old');
  expect(await fs.readFile(newPath, 'utf8')).toBe('new');
  expect(await findStaleCached(id)).toBeTruthy();
});

it('distinguishes same-size sub-millisecond versions in cache reads and write-through', async () => {
  await putCachedContent(id, 'old');
  const changed = { ...id, mtimeMs: 1000.2 };
  const executor = vi.fn((dest: string) => fs.writeFile(dest, 'new'));
  const newPath = await fetchRemoteFileToCache(changed, executor, vi.fn());
  expect(executor).toHaveBeenCalledOnce();
  expect(await fs.readFile(newPath, 'utf8')).toBe('new');
  expect(await fetchRemoteFileToCache(changed, vi.fn(), vi.fn())).toBe(newPath);
  await putCachedContent({ ...id, mtimeMs: 1000.3 }, 'end');
  expect(await fs.readFile(__cacheTesting.cachePathFor({ ...id, mtimeMs: 1000.3 }), 'utf8')).toBe('end');
});

it('isolates remote cache hits and offline stale fallback by owner scope', async () => {
  const ownerAPath = await fetchRemoteFileToCache(id, (dest) => fs.writeFile(dest, 'old'), vi.fn());
  expect(isInsideCacheDir(ownerAPath)).toBe(true);
  state.ownerScope = 'owner-b:1';
  expect(isInsideCacheDir(ownerAPath)).toBe(false);
  const ownerBExecutor = vi.fn((dest: string) => fs.writeFile(dest, 'new'));
  const ownerBPath = await fetchRemoteFileToCache(id, ownerBExecutor, vi.fn());

  expect(ownerBExecutor).toHaveBeenCalledOnce();
  expect(ownerBPath).not.toBe(ownerAPath);
  expect(isInsideCacheDir(ownerBPath)).toBe(true);
  expect(await findStaleCached(id)).toBe(ownerBPath);
  state.ownerScope = 'owner-a:1';
  expect(isInsideCacheDir(ownerBPath)).toBe(false);
  expect(await findStaleCached(id)).toBe(ownerAPath);
});

it.each(['resolve', 'reject'] as const)(
  'isolates a retry from a cancelled executor that later %ss',
  async (settle) => {
    const oldStarted = barrier();
    const releaseOld = barrier();
    const newStarted = barrier();
    const releaseNew = barrier();
    const controller = new AbortController();
    let oldTemp = '';
    let newTemp = '';
    const oldProgress = vi.fn();
    const first = fetchRemoteFileToCache(
      id,
      async (dest, report) => {
        oldTemp = dest;
        await fs.writeFile(dest, 'old');
        oldStarted.resolve();
        await releaseOld.promise;
        report(3, 3);
        if (settle === 'reject') throw new Error('late failure');
      },
      oldProgress,
      controller.signal,
    );
    await oldStarted.promise;
    controller.abort();
    await expect(first).rejects.toThrow('FILE_PEER_CANCELLED');

    const replacement = fetchRemoteFileToCache(
      id,
      async (dest) => {
        newTemp = dest;
        await fs.writeFile(dest, 'new');
        newStarted.resolve();
        await releaseNew.promise;
      },
      vi.fn(),
    );
    try {
      await newStarted.promise;
      expect(newTemp).not.toBe(oldTemp);
      releaseOld.resolve();
      await vi.waitFor(async () => {
        await expect(fs.stat(oldTemp)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      expect(await fs.readFile(newTemp, 'utf8')).toBe('new');
      expect(oldProgress).not.toHaveBeenCalled();

      const unusedExecutor = vi.fn();
      const joined = fetchRemoteFileToCache(id, unusedExecutor, vi.fn());
      releaseNew.resolve();
      const result = await replacement;
      expect(await joined).toBe(result);
      expect(unusedExecutor).not.toHaveBeenCalled();
      expect(await fs.readFile(result, 'utf8')).toBe('new');
    } finally {
      releaseOld.resolve();
      releaseNew.resolve();
      await replacement.catch(() => undefined);
    }
  },
);

it('does not start a transfer for an already-cancelled consumer', async () => {
  const controller = new AbortController();
  controller.abort();
  const executor = vi.fn();
  await expect(fetchRemoteFileToCache(id, executor, vi.fn(), controller.signal))
    .rejects.toThrow('FILE_PEER_CANCELLED');
  expect(executor).not.toHaveBeenCalled();
});

it('fails closed when ownership changes while cached-file stat is pending', async () => {
  const statStarted = barrier();
  const releaseStat = barrier();
  const open = vi.fn(async () => { throw new Error('open must not run'); });
  const io: CacheFileReadFs = {
    stat: async () => {
      statStarted.resolve();
      await releaseStat.promise;
      return { size: 6, isFile: () => true };
    },
    open,
  };
  const read = readCachedFileContent(__cacheTesting.cachePathFor(id), 64, 'owner-a:1', io);
  await statStarted.promise;
  state.ownerScope = 'owner-b:1';
  releaseStat.resolve();

  await expect(read).resolves.toEqual({ ok: false, message: 'FILE_PEER_CANCELLED' });
  expect(open).not.toHaveBeenCalled();
});

it('closes an opened cache file without reading if ownership changes during open', async () => {
  const openStarted = barrier();
  const releaseOpen = barrier();
  const handle: CacheFileReadHandle = {
    read: vi.fn(async () => ({ bytesRead: 0 })),
    close: vi.fn(async () => {}),
  };
  const io: CacheFileReadFs = {
    stat: async () => ({ size: 6, isFile: () => true }),
    open: async () => {
      openStarted.resolve();
      await releaseOpen.promise;
      return handle;
    },
  };
  const read = readCachedFileContent(__cacheTesting.cachePathFor(id), 64, 'owner-a:1', io);
  await openStarted.promise;
  state.ownerScope = 'owner-b:1';
  releaseOpen.resolve();

  await expect(read).resolves.toEqual({ ok: false, message: 'FILE_PEER_CANCELLED' });
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledOnce();
});

it('discards text read across an owner switch and closes its handle', async () => {
  const readStarted = barrier();
  const releaseRead = barrier();
  const handle: CacheFileReadHandle = {
    read: async (buffer, offset, length) => {
      readStarted.resolve();
      await releaseRead.promise;
      const bytes = Buffer.from('secret');
      const bytesRead = Math.min(length, bytes.length);
      bytes.copy(buffer, offset, 0, bytesRead);
      return { bytesRead };
    },
    close: vi.fn(async () => {}),
  };
  const io: CacheFileReadFs = {
    stat: async () => ({ size: 6, isFile: () => true }),
    open: async () => handle,
  };
  const read = readCachedFileContent(__cacheTesting.cachePathFor(id), 64, 'owner-a:1', io);
  await readStarted.promise;
  state.ownerScope = 'owner-b:1';
  releaseRead.resolve();

  await expect(read).resolves.toEqual({ ok: false, message: 'FILE_PEER_CANCELLED' });
  expect(handle.close).toHaveBeenCalledOnce();
});

it('keeps cache writes inside the isolated temporary userData root', () => {
  expect(getRemoteFileCacheRoot()).toBe(path.join(userDataDir, 'remote-file-cache'));
});
