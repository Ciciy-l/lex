import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { terminateOmpProcessTree } from './process-tree.js';

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error('Timed out waiting for process-tree fixture');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

describe.runIf(process.platform !== 'win32')('OMP POSIX process-tree containment', () => {
  it('reclaims a grandchild after its detached root has naturally exited', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-process-tree-'));
    const marker = path.join(root, 'grandchild.pid');
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      "writeFileSync(process.env.OMP_PROCESS_TREE_MARKER, String(grandchild.pid), 'utf8');",
      'setTimeout(() => process.exit(0), 25);',
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', parentScript], {
      detached: true,
      env: { OMP_PROCESS_TREE_MARKER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(parent, 'exit');
    const closed = once(parent, 'close');

    try {
      const grandchildPid = Number(
        await waitFor(async () => {
          try {
            return (await readFile(marker, 'utf8')).trim();
          } catch {
            return undefined;
          }
        }),
      );
      expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      await exited;
      expect(isAlive(grandchildPid)).toBe(true);

      terminateOmpProcessTree(parent, true);

      await waitFor(async () => (isAlive(grandchildPid) ? undefined : true));
      await closed;
    } finally {
      if (parent.pid !== undefined) {
        try {
          process.kill(-parent.pid, 'SIGKILL');
        } catch {
          // The detached group was already reclaimed.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
