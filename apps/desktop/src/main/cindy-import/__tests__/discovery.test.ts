import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ identity: vi.fn(), holders: vi.fn() }));
vi.mock('../../desktopProcessIdentity', async original => ({
  ...await original<typeof import('../../desktopProcessIdentity')>(), readDesktopProcessIdentity: probe.identity,
}));
vi.mock('../occupancy', () => ({ sourceDatabaseHolders: probe.holders }));
import { assertSourceStopped, discoverSources } from '../discovery';
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lex-cindy-discovery-')));
  probe.identity.mockReset().mockResolvedValue(null); probe.holders.mockReset().mockResolvedValue([]);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('accepts a stopped source and ignores residual WAL/SHM/lock files', async () => {
  const file = path.join(root, 'cindy-owner.db');
  for (const suffix of ['', '-wal', '-shm']) await fs.writeFile(file + suffix, 'synthetic residue');
  await fs.writeFile(path.join(root, 'SingletonLock'), 'stale');
  await expect(assertSourceStopped(root, file)).resolves.toBeUndefined();
  expect(probe.holders).toHaveBeenCalledWith(file); expect(probe.identity).not.toHaveBeenCalled();
});
it('checks exact database holders without treating Lex or unrelated Cindy instances as the source', async () => {
  probe.holders.mockResolvedValue([process.pid]);
  await expect(assertSourceStopped(root, '/synthetic/db')).resolves.toBeUndefined();
  probe.holders.mockResolvedValue([12345]);
  probe.identity.mockResolvedValue({ executablePath: process.platform === 'win32' ? 'C:\\apps\\Cindy.exe' : '/Apps/Cindy.app/Contents/MacOS/Cindy', startedAtMs: 1000 });
  await expect(assertSourceStopped(root, '/synthetic/db')).rejects.toMatchObject({ code: 'sourceRunning' });
  probe.identity.mockResolvedValue({ executablePath: process.execPath, startedAtMs: 1000 });
  await expect(assertSourceStopped(root, '/synthetic/db')).rejects.toMatchObject({ code: 'sourceBusy' });
  probe.holders.mockResolvedValue([]);
  await expect(assertSourceStopped(root, '/synthetic/db')).resolves.toBeUndefined();
});
it('uses the selected profile registry and ignores dead or copied records', async () => {
  await fs.mkdir(path.join(root, '.dev-instances'));
  const record = path.join(root, '.dev-instances', '12345.json');
  await fs.writeFile(record, JSON.stringify({ userDataDir: root, startedAtMs: 1000 }));
  vi.spyOn(process, 'kill').mockReturnValue(true);
  probe.identity.mockResolvedValue({ executablePath: process.platform === 'win32' ? 'C:\\apps\\electron.exe' : '/Apps/Electron.app/Contents/MacOS/Electron', startedAtMs: 1000 });
  await expect(assertSourceStopped(root)).rejects.toMatchObject({ code: 'sourceRunning' });
  await fs.writeFile(record, JSON.stringify({ userDataDir: path.join(root, 'other'), startedAtMs: 1000 }));
  await expect(assertSourceStopped(root)).resolves.toBeUndefined();
  await fs.writeFile(record, JSON.stringify({ userDataDir: '', startedAtMs: 1000 }));
  await expect(assertSourceStopped(root)).resolves.toBeUndefined();
  await fs.writeFile(record, JSON.stringify({ userDataDir: root, startedAtMs: 1000 }));
  probe.identity.mockResolvedValue({ executablePath: '/Apps/Electron.app/Contents/MacOS/Electron', startedAtMs: 10000 });
  await expect(assertSourceStopped(root)).resolves.toBeUndefined();
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  await expect(assertSourceStopped(root)).resolves.toBeUndefined();
});
it('does not mislabel process inspection or permission errors as a running source', async () => {
  probe.holders.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'sourceUnreadable' }));
  await expect(assertSourceStopped(root, '/synthetic/db')).rejects.toMatchObject({ code: 'sourceUnreadable' });
});
it('excludes source dev sandboxes and every Lex subdirectory', async () => {
  const lex = path.join(root, 'Lex'); await fs.mkdir(lex);
  const dirs = ['Cindy-dev2-test', 'CindyDev', 'LexGlobal', 'Lex/nested'];
  for (const name of dirs) {
    const dir = path.join(root, name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'cindy-owner.db'), 'synthetic');
  }
  expect(await discoverSources(dirs.map((name) => path.join(root, name)), lex)).toEqual([]);
});
it('prefers the current account database over the retained legacy copy', async () => {
  const lex = path.join(root, 'Lex'); await fs.mkdir(lex);
  await fs.writeFile(path.join(root, 'cindy-owner.db'), 'current');
  await fs.writeFile(path.join(root, 'xdt-maker-owner.db'), 'legacy');
  const sources = await discoverSources([root], lex);
  expect(sources).toHaveLength(1);
  expect(sources[0].file).toBe(path.join(root, 'cindy-owner.db'));
});
