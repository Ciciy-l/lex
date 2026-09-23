import { describe, expect, it } from 'vitest';
import { startOmpProcess } from './process-host.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OMP Windows direct-child lifecycle', () => {
  it.runIf(process.platform === 'win32')(
    'keeps descendant-held pipes bounded and reports the unconfirmed exit honestly',
    async ({ skip }) => {
      const fixturePid = deferred<number>();
      const unconfirmed = deferred<void>();
      const physicallyClosed = deferred<void>();
      let grandchildPid: number | undefined;
      let host: ReturnType<typeof startOmpProcess> | undefined;
      let fixtureTimeout: ReturnType<typeof setTimeout> | undefined;
      const seenEvents: string[] = [];
      const seenStates: string[] = [];
      const terminations: boolean[] = [];
      const grandchildScript = 'setInterval(() => {}, 30000)';
      const lineBreak = String.fromCharCode(10);
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const grandchild = spawn(process.execPath, ['-e', " + JSON.stringify(grandchildScript) + "], { stdio: 'inherit', detached: true });",
        'grandchild.unref();',
        "process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1] }) + String.fromCharCode(10));",
        "process.stdout.write(JSON.stringify({ type: 'fixture_pid', pid: grandchild.pid }) + String.fromCharCode(10), () => process.exit(0));",
      ].join(lineBreak);

      try {
        host = startOmpProcess({
          executablePath: process.execPath,
          workingDirectory: process.cwd(),
          arguments: ['-e', parentScript],
          environment: {
            SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR ?? '',
          },
          terminateProcessTree: (_child, force) => {
            terminations.push(force);
          },
          onEvent: (event) => {
            if (typeof event.type === 'string') seenEvents.push(event.type);
            if (event.type === 'fixture_pid' && Number.isSafeInteger(event.pid)) {
              grandchildPid = event.pid as number;
              fixturePid.resolve(grandchildPid);
            }
          },
          onState: (state) => {
            seenStates.push(state);
            if (state === 'exit-unconfirmed') unconfirmed.resolve();
            if (state === 'exited') physicallyClosed.resolve();
          },
        });

        await Promise.race([
          fixturePid.promise,
          new Promise<never>((_, reject) => {
            fixtureTimeout = setTimeout(() => {
              reject(new Error('OMP Windows lifecycle fixture PID timed out; states=' + seenStates.join(',') + '; events=' + seenEvents.join(',')));
            }, 5_000);
          }),
        ]);
        if (fixtureTimeout) clearTimeout(fixtureTimeout);
        fixtureTimeout = undefined;

        try {
          process.kill(grandchildPid!, 0);
        } catch {
          skip('the test host terminates grandchildren when their parent exits');
        }

        const outcome = await Promise.race([
          unconfirmed.promise.then(() => 'unconfirmed'),
          physicallyClosed.promise.then(() => 'closed'),
          new Promise<never>((_, reject) => {
            fixtureTimeout = setTimeout(() => {
              reject(new Error('OMP Windows lifecycle did not settle; states=' + seenStates.join(',') + '; events=' + seenEvents.join(',')));
            }, 15_000);
          }),
        ]);

        expect(outcome, 'states=' + seenStates.join(',') + '; events=' + seenEvents.join(',')).toBe('unconfirmed');
        expect(host.getState()).toBe('exit-unconfirmed');
        await expect(host.stopAndWait()).resolves.toBe(false);
        expect(terminations).toEqual([]);
      } finally {
        if (fixtureTimeout) clearTimeout(fixtureTimeout);
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            // The fixture may already have exited after the assertion failed.
          }
        }
        if (host) {
          await Promise.race([
            physicallyClosed.promise,
            new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
          ]);
        }
      }
    },
    25_000,
  );
});
