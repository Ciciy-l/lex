import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('refuses a second Host process through a physical directory alias without queueing a mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-process-lock-'));
  const alias = root + '-alias', output = path.join(root, 'host.cjs');
  const children: ChildProcess[] = [];
  try {
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await build({ stdin: { contents: `
      import { withNativeHistoryOperation } from ${JSON.stringify(path.resolve('src/main/maker-ipc/nativeHistoryOperation.ts'))};
      const release = new Promise(resolve => process.once('message', resolve));
      withNativeHistoryOperation(process.argv[2], 'task', async () => {
        process.send({ entered: true });
        if (process.argv[3] === 'hold') await release;
      }).then(() => process.disconnect(), error => { process.send({ refused: error.message }); process.disconnect(); });
    `, resolveDir: process.cwd() }, outfile: output, bundle: true, platform: 'node', format: 'cjs',
      plugins: [{ name: 'isolated-log-sink', setup(b) {
        b.onResolve({ filter: /logger(?:\.js)?$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const createLogger = () => ({ warn() {}, error() {}, info() {}, debug() {} });' }));
      } }] });
    const start = (directory: string, mode: string) => {
      const child = fork(output, [directory, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      return { child, message: once(child, 'message'), exit: once(child, 'exit') };
    };
    const first = start(root, 'hold');
    expect((await first.message)[0]).toEqual({ entered: true });
    const blocked = start(alias, 'once');
    expect((await blocked.message)[0]).toEqual({ refused: 'Native history is busy in another operation' });
    expect((await blocked.exit)[0]).toBe(0);
    first.child.send('release'); expect((await first.exit)[0]).toBe(0);
    const next = start(alias, 'once');
    expect((await next.message)[0]).toEqual({ entered: true }); expect((await next.exit)[0]).toBe(0);
  } finally {
    for (const child of children) if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await rm(alias, { force: true, recursive: true }); await rm(root, { force: true, recursive: true });
  }
});
