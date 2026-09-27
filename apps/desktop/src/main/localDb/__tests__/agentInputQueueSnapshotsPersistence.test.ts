import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDbClient: vi.fn(),
  getCurrentDbClientSnapshot: vi.fn(),
}));

vi.mock('../client/current', () => ({
  getDbClient: mocks.getDbClient,
  getCurrentDbClientSnapshot: mocks.getCurrentDbClientSnapshot,
}));

import {
  AgentInputQueueSnapshotTooLargeError,
  awaitAgentInputQueueSnapshotPersistence,
  hasInputDeliveryCancellation,
  readInputDeliveryReceipts,
  loadAgentInputQueueSnapshotCounts,
  saveCancelledInputDelivery,
  saveAgentInputQueueSnapshot,
} from '../agentInputQueueSnapshots.js';
import { agentInputQueueSnapshots, messages } from '../schema.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queued(text = 'queued', clientId = `client-${text}`): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'test-model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/tmp/cindy-test',
    chatMessage: { clientId, role: 'user' as const, content: text },
    createOpts: {
      agentKind: 'pi' as const,
      model: 'test-model',
      effort: 'medium',
      permissionMode: 'default',
      workingDir: '/tmp/cindy-test',
    },
  };
}

function installDb(
  opts: {
    write?: () => void | Promise<void>;
  } = {},
) {
  const onConflictDoUpdate = vi.fn(() => opts.write?.());
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn(() => Promise.resolve());
  const del = vi.fn(() => ({ where }));
  const db = { insert, delete: del };
  const client = { drizzle: db };
  mocks.getDbClient.mockReturnValue(client);
  mocks.getCurrentDbClientSnapshot.mockReturnValue({ client, clientEpoch: 1 });
  return { db, insert, onConflictDoUpdate };
}

function installDeliveryDb(initialMessages: Array<{
  sessionId: string;
  clientId: string;
  role: string;
  rewindAt: number | null;
}> = [], clientEpoch = 1, beforeInsert: () => Promise<void> = async () => {}) {
  const snapshotRows: Array<{ sessionId: string; payload: string }> = [];
  const messageRows = new Map(initialMessages.map((row) => [row.sessionId + ':' + row.clientId, row]));
  const drizzle = {
    insert: vi.fn(() => ({
      values: vi.fn((row: { sessionId: string; clientId: string; role: string; rewindAt: number | null }) => ({
        onConflictDoNothing: vi.fn(async () => {
          await beforeInsert();
          const key = row.sessionId + ':' + row.clientId;
          if (!messageRows.has(key)) messageRows.set(key, row);
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async () => table === agentInputQueueSnapshots
          || (table as { _?: { name?: string } } | null)?._?.name === 'agent_input_queue_snapshots'
          ? snapshotRows
          : [...messageRows.values()],
      }),
    })),
  };
  const client = { drizzle };
  mocks.getDbClient.mockReturnValue(client);
  mocks.getCurrentDbClientSnapshot.mockReturnValue({ client, clientEpoch });
  return { drizzle, snapshotRows, messageRows, client };
}

describe('agent input queue snapshot durability boundary', () => {
  it('waits for the current session write and resolves after the DB operation', async () => {
    const gate = deferred<void>();
    const { onConflictDoUpdate } = installDb({ write: () => gate.promise });

    const savePromise = saveAgentInputQueueSnapshot('snapshot-flush', [queued()]);
    const flushPromise = awaitAgentInputQueueSnapshotPersistence('snapshot-flush');

    let settled = false;
    void flushPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);

    gate.resolve();
    await expect(savePromise).resolves.toBeUndefined();
    await expect(flushPromise).resolves.toBeUndefined();
  });

  it('exposes a failed write to the durable waiter while allowing a later retry', async () => {
    const failure = new Error('db unavailable');
    let attempt = 0;
    const retryGate = deferred<void>();
    const { onConflictDoUpdate } = installDb({
      write: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(failure);
        return retryGate.promise;
      },
    });

    const failedSave = saveAgentInputQueueSnapshot('snapshot-retry', [queued('first')]);
    const failedFlush = awaitAgentInputQueueSnapshotPersistence('snapshot-retry');
    await expect(failedFlush).rejects.toBe(failure);
    await expect(failedSave).rejects.toBe(failure);
    await expect(awaitAgentInputQueueSnapshotPersistence('snapshot-retry')).rejects.toBe(failure);

    const retrySave = saveAgentInputQueueSnapshot('snapshot-retry', [queued('second')]);
    const retryFlush = awaitAgentInputQueueSnapshotPersistence('snapshot-retry');
    await Promise.resolve();
    await Promise.resolve();
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    retryGate.resolve();
    await expect(retrySave).resolves.toBeUndefined();
    await expect(retryFlush).resolves.toBeUndefined();
  });

  it('fails explicitly when sanitization still leaves the snapshot over the size cap', async () => {
    const { insert } = installDb();
    const hugeText = 'x'.repeat(16 * 1024 * 1024 + 1);
    const item = queued(hugeText, 'client-oversize');
    const savePromise = saveAgentInputQueueSnapshot('snapshot-oversize', [item]);
    const flushPromise = awaitAgentInputQueueSnapshotPersistence('snapshot-oversize');

    await expect(flushPromise).rejects.toBeInstanceOf(AgentInputQueueSnapshotTooLargeError);
    await expect(savePromise).rejects.toMatchObject({
      code: 'AGENT_INPUT_QUEUE_SNAPSHOT_TOO_LARGE',
      sessionId: 'snapshot-oversize',
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('counts selected snapshots in SQLite without returning payload bodies', async () => {
    const query = vi.fn().mockResolvedValue([{ sessionId: 'session-1', itemCount: 2 }]);
    mocks.getDbClient.mockReturnValue({ query } as never);

    await expect(
      loadAgentInputQueueSnapshotCounts(['session-1', 'session-2', 'session-1']),
    ).resolves.toEqual({ 'session-1': 2, 'session-2': 0 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('json_each(snapshot.payload)'), [
      'session-1',
      'session-2',
    ]);
    expect(query.mock.calls[0]?.[0]).not.toContain('SELECT payload');
  });

  it('persists cancellation tombstones and returns exact removed receipts', async () => {
    const { messageRows } = installDeliveryDb();

    await expect(saveCancelledInputDelivery('delivery-session', 'delivery-client'))
      .resolves.toBe(true);
    expect(messageRows.get('delivery-session:delivery-client')).toMatchObject({
      sessionId: 'delivery-session',
      clientId: 'delivery-client',
      role: 'message_tombstone',
    });
    await expect(readInputDeliveryReceipts('delivery-session', ['delivery-client']))
      .resolves.toEqual([{ clientId: 'delivery-client', state: 'removed' }]);
  });

  it('publishes a cancellation replay fence before the tombstone write and survives a new DB epoch', async () => {
    const gate = deferred<void>();
    const { client } = installDeliveryDb([], 1, () => gate.promise);
    const cancelled = saveCancelledInputDelivery('delivery-race-session', 'delivery-race-client');

    expect(hasInputDeliveryCancellation('delivery-race-session', 'delivery-race-client')).toBe(true);
    gate.resolve();
    await expect(cancelled).resolves.toBe(true);

    mocks.getCurrentDbClientSnapshot.mockReturnValue({ client, clientEpoch: 2 });
    await expect(readInputDeliveryReceipts('delivery-race-session', ['delivery-race-client']))
      .resolves.toEqual([{ clientId: 'delivery-race-client', state: 'removed' }]);
  });

  it('does not report an accepted message as cancelled when its client ID already exists', async () => {
    installDeliveryDb([{
      sessionId: 'delivery-session-existing',
      clientId: 'delivery-client-existing',
      role: 'user',
      rewindAt: null,
    }]);

    await expect(saveCancelledInputDelivery('delivery-session-existing', 'delivery-client-existing'))
      .resolves.toBe(false);
    await expect(readInputDeliveryReceipts('delivery-session-existing', ['delivery-client-existing']))
      .resolves.toEqual([{ clientId: 'delivery-client-existing', state: 'accepted' }]);
  });

  it('reports only user rows as accepted and distinguishes restored queue snapshots from unknown IDs', async () => {
    const { snapshotRows } = installDeliveryDb([{
      sessionId: 'delivery-session-roles',
      clientId: 'delivery-client-non-user',
      role: 'thinking',
      rewindAt: null,
    }]);
    snapshotRows.push({
      sessionId: 'delivery-session-roles',
      payload: JSON.stringify([queued('pending', 'delivery-client-pending')]),
    });

    await expect(readInputDeliveryReceipts('delivery-session-roles', [
      'delivery-client-non-user',
      'delivery-client-pending',
      'delivery-client-unknown',
    ])).resolves.toEqual([
      { clientId: 'delivery-client-non-user', state: 'unknown' },
      { clientId: 'delivery-client-pending', state: 'pending' },
      { clientId: 'delivery-client-unknown', state: 'unknown' },
    ]);
  });

  it('matches restore de-duplication and clear-boundary filtering for cold queued counts', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cleared_at INTEGER
      );
      CREATE TABLE agent_input_queue_snapshots (
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        UNIQUE(session_id, client_id)
      );
    `);
    const accepted = {
      ...queued('accepted', 'client-accepted'),
      hostAcceptedAtMs: 301,
    };
    const beforeClear = {
      ...queued('before clear', 'client-before-clear'),
      hostAcceptedAtMs: 299,
    };
    const missingReceipt = queued('missing receipt', 'client-missing-receipt');
    const waiting = {
      ...queued('waiting', 'client-waiting'),
      hostAcceptedAtMs: 301,
    };
    const staleScheduler = {
      ...queued('stale scheduler', 'client-stale-scheduler'),
      hostAcceptedAtMs: 301,
      origin: {
        kind: 'scheduler' as const,
        scheduleId: 'schedule-legacy',
        scheduleName: 'Legacy heartbeat',
      },
    };
    db.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, ?)').run(
      'session-crash-window',
      300,
    );
    db.prepare(
      'INSERT INTO agent_input_queue_snapshots (session_id, payload, updated_at) VALUES (?, ?, ?)',
    ).run(
      'session-crash-window',
      JSON.stringify([
        accepted,
        beforeClear,
        missingReceipt,
        waiting,
        staleScheduler,
        'malformed legacy row',
      ]),
      Date.now(),
    );
    db.prepare('INSERT INTO messages (session_id, client_id) VALUES (?, ?)').run(
      'session-crash-window',
      accepted.clientId,
    );
    const query = vi.fn(async <T = unknown>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...params) as T[]);
    mocks.getDbClient.mockReturnValue({ query } as never);

    try {
      await expect(
        loadAgentInputQueueSnapshotCounts(['session-crash-window']),
      ).resolves.toEqual({ 'session-crash-window': 1 });
      expect(query.mock.calls[0]?.[0]).toContain('NOT EXISTS');
      expect(query.mock.calls[0]?.[0]).toContain('FROM messages');
      expect(query.mock.calls[0]?.[0]).toContain('session.cleared_at');
      expect(query.mock.calls[0]?.[0]).toContain('$.hostAcceptedAtMs');
      expect(query.mock.calls[0]?.[0]).toContain('$.origin.kind');
    } finally {
      db.close();
    }
  });

  it('isolates corrupt snapshots while preserving database read failures', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        { sessionId: 'corrupt', itemCount: null },
        { sessionId: 'healthy', itemCount: 2 },
      ])
      .mockRejectedValueOnce(new Error('db unavailable'));
    mocks.getDbClient.mockReturnValue({ query } as never);

    await expect(loadAgentInputQueueSnapshotCounts(['corrupt', 'healthy'])).resolves.toEqual({
      corrupt: 0,
      healthy: 2,
    });
    await expect(loadAgentInputQueueSnapshotCounts(['unavailable'])).rejects.toThrow(
      'db unavailable',
    );
  });
});
