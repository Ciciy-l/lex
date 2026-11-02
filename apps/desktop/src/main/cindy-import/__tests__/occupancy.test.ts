import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseLsofHolders, sourceDatabaseHolders } from '../occupancy';

it('retains partial lsof matches and distinguishes unheld paths from inspection failures', () => {
  for (const code of [0, 1]) {
    expect(parseLsofHolders({ code, stdout: 'p123\nf11\np123\nf12\np456\nf7\n', stderr: '' })).toEqual([123, 456]);
    expect(parseLsofHolders({ code, stdout: '', stderr: '' })).toEqual([]);
  }
  for (const result of [
    { code: 1, stdout: 'p123\nf11\n', stderr: 'permission denied' },
    { code: 2, stdout: 'p123\nf11\n', stderr: '' },
    { code: 'ENOENT', stdout: '', stderr: '' },
    { code: 1, stdout: 'p123\nf11\n', stderr: '', killed: true, signal: 'SIGTERM' },
    { code: 1, stdout: 'unexpected probe output', stderr: '' },
    { code: 1, stdout: 'f11\n', stderr: '' },
    { code: 1, stdout: 'p0\n', stderr: '' },
  ]) expect(() => parseLsofHolders(result)).toThrowError(expect.objectContaining({ code: 'sourceUnreadable' }));
});

// Real OS probe, synthetic file and a child owned by this test only. Never open
// a user's Cindy database or stop a desktop instance to satisfy this test.
it.skipIf(!['darwin', 'win32'].includes(process.platform)).each([
  { label: 'DB only', sidecars: [], held: [''] },
  { label: 'held DB and unheld WAL', sidecars: ['-wal'], held: [''] },
  { label: 'unheld DB and held WAL', sidecars: ['-wal', '-shm'], held: ['-wal'] },
  { label: 'held DB and WAL with unheld SHM', sidecars: ['-wal', '-shm'], held: ['', '-wal'] },
  { label: 'held journal with unheld DB/WAL/SHM', sidecars: ['-wal', '-shm', '-journal'], held: ['-journal'] },
])('detects $label, retries after exit and leaves every source byte unchanged', async ({ sidecars, held }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-source-holder-test-'));
  let child: ChildProcess | undefined;
  try {
    const file = path.join(root, 'synthetic.db'); await fs.writeFile(file, 'synthetic database bytes');
    for (const suffix of sidecars) await fs.writeFile(file + suffix, 'synthetic residual ' + suffix);
    const files = ['', ...sidecars].map(suffix => file + suffix);
    const digests = () => Promise.all(files.map(async name => createHash('sha256').update(await fs.readFile(name)).digest('hex')));
    const before = await digests();
    expect(await sourceDatabaseHolders(file)).toEqual([]);
    child = spawn(process.execPath, ['-e', "for(const file of process.argv.slice(1))require('fs').openSync(file,'r');process.stdout.write('ready');setInterval(()=>{},1000)", ...held.map(suffix => file + suffix)], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout!, 'data');
    expect(await sourceDatabaseHolders(file)).toContain(child.pid);
    const exited = once(child, 'exit'); child.kill(); await exited; child = undefined;
    expect(await sourceDatabaseHolders(file)).toEqual([]);
    expect(await digests()).toEqual(before);
    await expect(sourceDatabaseHolders(path.join(root, 'missing.db'))).rejects.toMatchObject({ code: 'sourceMissing' });
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
