import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  probeReviewOwnerLiveness,
  startReviewOwnerLiveness,
  type ReviewOwnerLivenessHandle,
} from '../reviewOwnerLiveness.js';
import { shouldFailInterruptedReview } from '../reviewRunRecovery.js';

/** Observe only this fixture's sockets; never retain the challenge or reply body. */
function observeLiveness() {
  const started = performance.now();
  const events: Record<string, unknown>[] = [];
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    if (events.length < 24) {
      events.push({ event, ms: Math.round((performance.now() - started) * 100) / 100, ...detail });
    }
  };
  const sockets: { socket: net.Socket; closed: Promise<void> }[] = [];
  const createConnection = net.createConnection;
  const spy = vi.spyOn(net, 'createConnection').mockImplementation((...args) => {
    const socket: net.Socket = Reflect.apply(createConnection, net, args);
    record('probe:create');
    socket.on('connect', () => record('probe:connect'));
    socket.on('data', (chunk) => record('probe:data', { bytes: Buffer.byteLength(chunk) }));
    socket.on('end', () => record('probe:end'));
    socket.on('timeout', () => record('probe:timeout'));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      record('probe:error', { code: error.code ?? null }),
    );
    const closed = new Promise<void>((resolve) => {
      socket.once('close', (hadError) => {
        record('probe:close', { hadError, destroyed: socket.destroyed });
        resolve();
      });
    });
    sockets.push({ socket, closed });
    return socket;
  });
  return {
    events,
    record,
    async closeSockets() {
      for (const { socket } of sockets) socket.destroy();
      await Promise.all(sockets.map(({ closed }) => closed));
    },
    restore: () => spy.mockRestore(),
  };
}

describe('Review owner exact liveness', () => {
  let handle: ReviewOwnerLivenessHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  it('recognizes only the exact live Main instance challenge', async () => {
    handle = await startReviewOwnerLiveness();

    await expect(probeReviewOwnerLiveness(handle.identity)).resolves.toBe('alive');
    await expect(
      probeReviewOwnerLiveness({ ...handle.identity, token: 'wrong-instance-token' }),
    ).resolves.toBe('ended');
  });

  it('reports the owner ended after its endpoint closes', async () => {
    const trace = observeLiveness();
    try {
      trace.record('listen:requested');
      handle = await startReviewOwnerLiveness();
      trace.record('listen:resolved');
      const identity = handle.identity;
      trace.record('close:requested');
      await handle.close();
      trace.record('close:resolved');
      handle = null;

      const result = await probeReviewOwnerLiveness(identity);
      trace.record('probe:resolved', { result });
      // Observe cleanup after the result, without delaying or retrying the probe.
      await trace.closeSockets();
      expect(result, 'Owner liveness events: ' + JSON.stringify(trace.events)).toBe('ended');
    } finally {
      try {
        await handle?.close();
        handle = null;
        await trace.closeSockets();
      } finally {
        trace.restore();
      }
    }
  });

  it.each([
    ['timeout', 'unknown'],
    ['ECONNRESET', 'unknown'],
    ['EACCES', 'unknown'],
    ['ECONNREFUSED', 'ended'],
    ['ENOENT', 'ended'],
  ] as const)(
    'keeps %s transport results fail-closed through recovery',
    async (event, expected) => {
      // An unconnected owned socket makes event ordering deterministic, without I/O or timers.
      const socket = new net.Socket();
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const spy = vi.spyOn(net, 'createConnection').mockReturnValue(socket);
      const owner = {
        instanceId: 'synthetic-previous-owner',
        processId: 300,
        liveness: { version: 1 as const, port: 1, token: 'synthetic-challenge' },
      };
      try {
        const result = probeReviewOwnerLiveness(owner.liveness);
        if (event === 'timeout') socket.emit('timeout');
        else
          socket.emit(
            'error',
            Object.assign(new Error('synthetic transport error'), { code: event }),
          );
        // A late contradictory event cannot reclassify a settled unknown or trigger a retry.
        socket.emit('data', 'unrelated-owner\n');
        socket.emit('timeout');
        await expect(result).resolves.toBe(expected);
        await expect(
          shouldFailInterruptedReview(
            {
              version: 1,
              runId: 'run-1',
              sourceSessionId: 'source-1',
              reviewerSessionId: 'reviewer-1',
              status: 'running',
              targetKind: 'changes',
              startedAt: 1,
              owner,
            },
            { instanceId: 'current-owner', processId: 200 },
            () => false,
            () => result,
          ),
        ).resolves.toBe(expected === 'ended');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(socket.destroyed).toBe(true);
      } finally {
        socket.destroy();
        await closed;
        spy.mockRestore();
      }
    },
  );
});
