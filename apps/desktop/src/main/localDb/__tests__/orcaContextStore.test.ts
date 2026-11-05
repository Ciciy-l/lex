import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import {
  clearCurrentDbClient,
  getCurrentDbClientSnapshot,
  setCurrentDbClient,
} from '../client/current.js';
import * as schema from '../schema.js';

describe('orcaContextStore', () => {
  let client: DbClient | null = null;
  let raw: Database.Database | null = null;

  afterEach(() => {
    if (client) {
      clearCurrentDbClient(client);
      client = null;
    }
    raw?.close();
    raw = null;
    vi.clearAllMocks();
  });

  function createClient(): DbClient {
    const dbHandle = new Database(':memory:');
    raw = dbHandle;
    dbHandle.exec(`
      CREATE TABLE orca_context_events (
        id TEXT PRIMARY KEY NOT NULL,
        lead_session_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        worker_session_id TEXT NOT NULL,
        policy TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_orca_context_events_lead_created
        ON orca_context_events (lead_session_id, created_at);
      CREATE INDEX idx_orca_context_events_worker_created
        ON orca_context_events (worker_id, created_at);
    `);
    const db = drizzle(dbHandle, { schema });
    const created: DbClient = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => dbHandle.prepare(sql).run(...params),
      tx: (async () => {
        throw new Error('not used');
      }) as DbClient['tx'],
      drizzle: db,
      vecAvailable: false,
      dispose: async () => {},
    };
    client = created;
    setCurrentDbClient(created, 'test-user');
    return created;
  }

  it('records only safe identity/outcome fields and lists newest first', async () => {
    createClient();
    const store = await import('../orcaContextStore.js');
    await store.recordOrcaContextEvent(
      {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
        policy: 'clear',
        outcome: 'cleared',
      },
      undefined,
      100,
    );
    await store.recordOrcaContextEvent(
      {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
        policy: 'compact',
        outcome: 'refused',
        reason: 'native-completion-unverified',
      },
      undefined,
      200,
    );
    const rows = await store.listOrcaContextEvents('worker-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      policy: 'compact',
      outcome: 'refused',
      reason: 'native-completion-unverified',
      createdAt: 200,
    });
    expect(rows[1]).toMatchObject({ policy: 'clear', outcome: 'cleared', createdAt: 100 });
    const rawRows = await client!.query<Record<string, unknown>>(
      'SELECT * FROM orca_context_events ORDER BY created_at',
    );
    expect(JSON.stringify(rawRows)).not.toContain('message');
  });

  it('returns an empty list for an unknown worker', async () => {
    createClient();
    const store = await import('../orcaContextStore.js');
    await expect(store.listOrcaContextEvents('missing')).resolves.toEqual([]);
  });
});


describe('orcaContextStore owner fencing', () => {
  function makeDb() {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE orca_context_events (
        id TEXT PRIMARY KEY NOT NULL,
        lead_session_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        worker_session_id TEXT NOT NULL,
        policy TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    const db = drizzle(raw, { schema });
    const client: DbClient = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        raw.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        raw.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => raw.prepare(sql).run(...params),
      tx: (async () => {
        throw new Error('not used');
      }) as DbClient['tx'],
      drizzle: db,
      vecAvailable: false,
      dispose: async () => {},
    };
    return { raw, client };
  }

  it('skips an audit write after the owner switches instead of writing owner B', async () => {
    const a = makeDb();
    const b = makeDb();
    try {
      setCurrentDbClient(a.client, 'owner-a');
      const snapshotA = getCurrentDbClientSnapshot();
      const ownerA = {
        client: a.client,
        generation: 1,
        assertCurrent() {
          if (!snapshotA || getCurrentDbClientSnapshot() !== snapshotA) {
            throw new Error('owner changed');
          }
        },
      };
      const store = await import('../orcaContextStore.js');
      const event = {
        leadSessionId: 'synthetic-lead-a',
        workerId: 'synthetic-worker-a',
        workerSessionId: 'synthetic-session-a',
        policy: 'compact' as const,
        outcome: 'refused' as const,
        reason: 'native-completion-unverified',
      };
      await expect(store.recordOrcaContextEvent(event, ownerA, 100)).resolves.toMatchObject({
        leadSessionId: 'synthetic-lead-a',
      });
      expect(a.raw.prepare('SELECT * FROM orca_context_events').all()).toHaveLength(1);

      setCurrentDbClient(b.client, 'owner-b');
      await expect(store.recordOrcaContextEvent(event, ownerA, 200)).resolves.toBeNull();
      expect(b.raw.prepare('SELECT * FROM orca_context_events').all()).toEqual([]);
      expect(a.raw.prepare('SELECT * FROM orca_context_events').all()).toHaveLength(1);
    } finally {
      clearCurrentDbClient();
      a.raw.close();
      b.raw.close();
    }
  });
});
