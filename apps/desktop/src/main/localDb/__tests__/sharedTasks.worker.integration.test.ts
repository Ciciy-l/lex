import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SharedTaskSnapshot } from '@cindy/device-link';
import {
  closeSharedTasksInJournalForSession,
  createSharedTaskJournal,
  finalizePreparedSharedTasks,
  prepareSharedTasksForSession,
  rollbackPreparedSharedTasks,
} from '../sharedTasks.js';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport.js';
import { buildDbWorkerBundle } from './dbWorkerTestUtils.js';

type RpcTransport = Pick<WorkerThreadTransport, 'send'>;
type ExecResult = { changes: number; lastInsertRowid: number | bigint };

function seedProfile(root: string, sessions: string[]): { dbPath: string; drizzleDir: string } {
  const drizzleDir = path.join(root, 'drizzle');
  const dbPath = path.join(root, 'profile.db');
  fs.mkdirSync(drizzleDir, { recursive: true });
  fs.writeFileSync(
    path.join(drizzleDir, '0000_init.sql'),
    'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    'utf8',
  );
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO migration_meta (key, value) VALUES ('schema_version', '0');
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE shared_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        shared_task_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        terminal INTEGER NOT NULL,
        snapshot TEXT,
        recorded_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX shared_task_events_revision_idx
        ON shared_task_events(shared_task_id, kind, revision);
      CREATE INDEX shared_task_events_session_idx
        ON shared_task_events(session_id, id);
    `);
    const insert = db.prepare('INSERT INTO sessions (id) VALUES (?)');
    for (const session of sessions) insert.run(session);
  } finally {
    db.close();
  }
  return { dbPath, drizzleDir };
}

function journalFor(transport: RpcTransport) {
  return createSharedTaskJournal({
    exec: (sql, params = []) => transport.send<ExecResult>('exec', { sql, params }),
    query: <T>(sql: string, params: unknown[] = []) => transport.send<T[]>('query', { sql, params }),
  });
}

function snapshot(
  sharedTaskId: string,
  sessionId: string,
  ownerAccountId: string,
  revision = 1,
): SharedTaskSnapshot {
  return {
    sharedTaskId, sessionId, ownerAccountId, hostDeviceId: 'desktop', revision, status: 'active',
    guests: [{ memberId: 'guest', accountId: 'guest-account', version: 1, deviceIds: ['phone'] }],
  };
}

describe('SharedTask profile journal over real worker and inline transports', () => {
  let workerRoot: string;
  let workerScriptPath: string;

  beforeAll(async () => {
    workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-shared-task-worker-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(workerRoot, 'worker'));
  });

  afterAll(() => {
    if (workerRoot) fs.rmSync(workerRoot, { recursive: true, force: true });
  });

  it('keeps two tasks and two profile databases isolated while closure races cross-worker writes', async () => {
    const profileARoot = fs.mkdtempSync(path.join(workerRoot, 'profile-a-'));
    const profileBRoot = fs.mkdtempSync(path.join(workerRoot, 'profile-b-'));
    const profileA = seedProfile(profileARoot, ['task-a', 'task-b']);
    const profileB = seedProfile(profileBRoot, ['task-b']);
    const options = (profile: typeof profileA) => ({
      workerScriptPath, dbPath: profile.dbPath, drizzleDir: profile.drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
    });
    const peerA = new WorkerThreadTransport(options(profileA));
    const peerAInline = new WorkerThreadTransport({ ...options(profileA), useInlineWorker: true });
    const peerB = new WorkerThreadTransport(options(profileB));
    try {
      // Explicit readiness ordering mirrors startup: the second writer is only
      // started after the first worker has opened its profile database.
      await peerA.send('query', { sql: 'SELECT 1 AS ready' });
      await peerAInline.send('query', { sql: 'SELECT 1 AS ready' });
      await peerB.send('query', { sql: 'SELECT 1 AS ready' });

      const profileAJournal = journalFor(peerA);
      const profileAInlineJournal = journalFor(peerAInline);
      const profileBJournal = journalFor(peerB);
      await profileAJournal.recordAuthority(snapshot('share-a', 'task-a', 'account-a'));
      await profileAInlineJournal.recordAuthority(snapshot('share-b', 'task-b', 'account-a'));
      await profileBJournal.recordAuthority(snapshot('share-b', 'task-b', 'account-b'));

      await expect(peerA.send('query', {
        sql: 'SELECT COUNT(*) AS count FROM shared_task_events',
      })).resolves.toEqual([{ count: 2 }]);
      await expect(peerB.send('query', {
        sql: 'SELECT COUNT(*) AS count FROM shared_task_events',
      })).resolves.toEqual([{ count: 1 }]);
      expect((await profileAInlineJournal.latest()).map((item) => item.sharedTaskId).sort())
        .toEqual(['share-a', 'share-b']);
      expect((await profileBJournal.latest()).map((item) => item.sharedTaskId))
        .toEqual(['share-b']);

      // A close from one process wins over a concurrent late authority reply;
      // the terminal fence is visible to the other process and never revives.
      await profileAJournal.close(snapshot('share-a', 'task-a', 'account-a'));
      const lateAuthority = await profileAInlineJournal.recordAuthority(
        snapshot('share-a', 'task-a', 'account-a', 2),
      );
      expect(lateAuthority).toBe(false);
      expect((await profileAJournal.latest()).find((item) => item.sharedTaskId === 'share-a'))
        .toMatchObject({ terminal: true });
      expect(await profileAJournal.recordAuthority(
        snapshot('share-a', 'task-a', 'account-a', 99),
      )).toBe(false);

      // A prepare marker is scoped to its own session and cannot be rolled back
      // after another writer has durably upgraded the closure to terminal.
      const inlineDb = {
        exec: (sql: string, params: unknown[] = []) => peerAInline.send<ExecResult>('exec', { sql, params }),
        query: <T>(sql: string, params: unknown[] = []) => peerAInline.send<T[]>('query', { sql, params }),
      };
      const prepared = await prepareSharedTasksForSession(inlineDb, 'task-b');
      expect(prepared.rowIds).toHaveLength(1);
      await profileAJournal.close(snapshot('share-b', 'task-b', 'account-a'));
      await rollbackPreparedSharedTasks(inlineDb, prepared);
      expect((await profileAInlineJournal.latest()).find((item) => item.sharedTaskId === 'share-b'))
        .toMatchObject({ terminal: true });

      expect(await closeSharedTasksInJournalForSession(inlineDb, 'task-a'))
        .toEqual(['share-a']);
      expect((await profileBJournal.latest()).find((item) => item.sharedTaskId === 'share-b'))
        .toMatchObject({ terminal: false });
    } finally {
      await Promise.all([peerA.close(), peerAInline.close(), peerB.close()]);
      fs.rmSync(profileARoot, { recursive: true, force: true });
      fs.rmSync(profileBRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
