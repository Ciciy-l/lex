import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: Object.assign(execute, {
  [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => new Promise((resolve, reject) => {
    execute(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
  }),
}) }));
import { assertSourceStopped, discoverSources } from '../discovery';
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lex-cindy-discovery-')));
  execute.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('accepts a stopped source without touching SQLite or process arguments', async () => {
  await expect(assertSourceStopped(root)).resolves.toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(1);
  const args = execute.mock.calls[0][1] as string[];
  expect(args.join(' ')).not.toMatch(/CommandLine|args=|command=/);
});
it('rejects a running release process independently of stale/missing locks', async () => {
  execute.mockImplementation((_file, _args, _options, callback) => callback(null, 'Cindy', ''));
  await expect(assertSourceStopped(root)).rejects.toMatchObject({ code: 'sourceRunning' });
});
it('detects a live Electron development instance registered in the source profile', async () => {
  await fs.mkdir(path.join(root, '.dev-instances'));
  await fs.writeFile(path.join(root, '.dev-instances', '12345.json'), '{}');
  vi.spyOn(process, 'kill').mockReturnValue(true);
  execute.mockImplementation((_file, _args, _options, callback) => callback(null, 'Electron', ''));
  await expect(assertSourceStopped(root)).rejects.toMatchObject({ code: 'sourceRunning' });
});
it('rejects unverifiable process state and ignores dead profile records', async () => {
  execute.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error('unavailable'), '', ''));
  await expect(assertSourceStopped(root)).rejects.toMatchObject({ code: 'sourceUnreadable' });
  await fs.mkdir(path.join(root, '.dev-instances'));
  await fs.writeFile(path.join(root, '.dev-instances', '12345.json'), '{}');
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  await expect(assertSourceStopped(root)).resolves.toBeUndefined();
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
