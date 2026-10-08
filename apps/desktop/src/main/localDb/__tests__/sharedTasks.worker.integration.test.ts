import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sharedTaskGuestPeer, type SharedTaskApi, type SharedTaskDetail, type SharedTaskSnapshot } from '@cindy/device-link';
import {
  closeSharedTasksInJournalForSession,
  createSharedTaskJournal,
  finalizePreparedSharedTasks,
  prepareSharedTasksForSession,
  rollbackPreparedSharedTasks,
} from '../sharedTasks.js';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport.js';
import { buildDbWorkerBundle } from './dbWorkerTestUtils.js';
import { SharedTaskHost } from '../../device-link/sharedTaskHost.js';

type RpcTransport = Pick<WorkerThreadTransport, 'send'>;
type ExecResult = { changes: number; lastInsertRowid: number | bigint };
type JournalDb = {
  exec(sql: string, params?: unknown[]): Promise<ExecResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
};

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
        recorded_at INTEGER NOT NULL,
        closure_token TEXT
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

function journalForDb(db: JournalDb) {
  return createSharedTaskJournal({
    exec: (sql, params = []) => db.exec(sql, params),
    query: <T>(sql: string, params: unknown[] = []) => db.query<T>(sql, params),
  });
}

function journalFor(transport: RpcTransport) {
  return journalForDb({
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

  it('rejects a same-revision authority race before the host installs the losing snapshot', async () => {
    const root = fs.mkdtempSync(path.join(workerRoot, 'authority-race-'));
    const profile = seedProfile(root, ['session']);
    const options = {
      workerScriptPath, dbPath: profile.dbPath, drizzleDir: profile.drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
    };
    const peerA = new WorkerThreadTransport(options);
    let peerB!: WorkerThreadTransport;
    try {
      await peerA.send('query', { sql: 'SELECT 1 AS ready' });
      peerB = new WorkerThreadTransport(options);
      await peerB.send('query', { sql: 'SELECT 1 AS ready' });
      const rawA: JournalDb = {
        exec: (sql, params = []) => peerA.send<ExecResult>('exec', { sql, params }),
        query: <T>(sql: string, params: unknown[] = []) => peerA.send<T[]>('query', { sql, params }),
      };
      const journalB = journalFor(peerB);
      let enterWrite!: () => void;
      let releaseWrite!: () => void;
      const entered = new Promise<void>((resolve) => { enterWrite = resolve; });
      const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let gated = true;
      const journalA = journalForDb({
        exec: async (sql, params = []) => {
          if (gated && sql.includes("INSERT INTO shared_task_events")) {
            gated = false;
            enterWrite();
            await released;
          }
          return rawA.exec(sql, params);
        },
        query: rawA.query,
      });
      const losingDetail: SharedTaskDetail = {
        ...snapshot('shared-race', 'session', 'account-a'),
        guests: [{ memberId: 'guest-a', accountId: 'guest-a-account', version: 1, deviceIds: ['phone-a'] }],
        title: 'Task', memberLabels: [],
      };
      const winningSnapshot = {
        ...snapshot('shared-race', 'session', 'account-a'),
        guests: [{ memberId: 'guest-b', accountId: 'guest-b-account', version: 1, deviceIds: ['phone-b'] }],
      };
      const api = {
        create: async () => ({ sharedTaskId: 'shared-race', revision: 1 }),
        list: async () => [],
        get: async () => losingDetail,
        invite: async () => ({ sharedTaskId: 'shared-race', invitation: 'x'.repeat(43) }),
        join: async () => ({ sharedTaskId: 'shared-race', memberId: 'guest-b', status: 'joined' as const, created: true }),
        remove: async () => ({ memberId: 'guest-a', status: 'removed' as const }),
        leave: async () => ({ memberId: 'guest-a', status: 'left' as const }),
        close: async () => ({ sharedTaskId: 'shared-race', status: 'closed' as const }),
      } satisfies SharedTaskApi;
      const host = new SharedTaskHost({
        api, journal: journalA, ownerAccountId: 'account-a', hostDeviceId: 'desktop',
        isCurrent: () => true, readSession: async (id) => ({ id, title: 'Task', status: 'active' }),
        revoke: () => undefined, changed: () => undefined,
      });
      const refresh = host.refresh('shared-race');
      await entered;
      await expect(journalB.recordAuthority(winningSnapshot)).resolves.toBe(true);
      releaseWrite();
      await expect(refresh).rejects.toThrow('conflict');
      expect(host.capturePeer(sharedTaskGuestPeer('shared-race', 'guest-a', 'phone-a'))).toBeNull();
      await expect(journalB.latest()).resolves.toEqual([expect.objectContaining({
        sharedTaskId: 'shared-race', terminal: false, snapshot: winningSnapshot,
      })]);
      await host.dispose();
    } finally {
      await Promise.all([peerA.close(), peerB?.close()]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps close identity checks at the SQLite write boundary and fences old prepare ownership', async () => {
    const root = fs.mkdtempSync(path.join(workerRoot, 'close-race-'));
    const profile = seedProfile(root, ['session']);
    const options = {
      workerScriptPath, dbPath: profile.dbPath, drizzleDir: profile.drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
    };
    const peerA = new WorkerThreadTransport(options);
    let peerB!: WorkerThreadTransport;
    try {
      await peerA.send('query', { sql: 'SELECT 1 AS ready' });
      peerB = new WorkerThreadTransport(options);
      await peerB.send('query', { sql: 'SELECT 1 AS ready' });
      const rawA: JournalDb = {
        exec: (sql, params = []) => peerA.send<ExecResult>('exec', { sql, params }),
        query: <T>(sql: string, params: unknown[] = []) => peerA.send<T[]>('query', { sql, params }),
      };
      const rawB: JournalDb = {
        exec: (sql, params = []) => peerB.send<ExecResult>('exec', { sql, params }),
        query: <T>(sql: string, params: unknown[] = []) => peerB.send<T[]>('query', { sql, params }),
      };
      const journalA = journalForDb(rawA);
      const journalB = journalForDb(rawB);
      const identityA = snapshot('close-race', 'session', 'account-a');
      await journalA.recordAuthority(identityA);
      let enterClose!: () => void;
      let releaseClose!: () => void;
      const entered = new Promise<void>((resolve) => { enterClose = resolve; });
      const released = new Promise<void>((resolve) => { releaseClose = resolve; });
      const gatedClose = journalForDb({
        exec: async (sql, params = []) => {
          if (sql.includes("INSERT INTO shared_task_events") && sql.includes("'local-close'")) {
            enterClose();
            await released;
          }
          return rawA.exec(sql, params);
        },
        query: rawA.query,
      });
      const closing = gatedClose.close(identityA);
      await entered;
      // Simulate an authority response from another owner which raced after
      // close's old read. The guarded close must see this row at its write.
      const other = { ...snapshot('close-race', 'session', 'account-b'), revision: 2 };
      await rawB.exec(
        `INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at) VALUES (?, ?, ?, 'authority', 0, ?, ?)`,
        [other.sharedTaskId, other.sessionId, other.revision, JSON.stringify(other), 2],
      );
      releaseClose();
      await expect(closing).rejects.toThrow('identity');
      await expect(journalB.latest()).resolves.toEqual([expect.objectContaining({
        sharedTaskId: 'close-race', terminal: false, snapshot: other,
      })]);

      const first = await prepareSharedTasksForSession(rawA, 'session');
      await rollbackPreparedSharedTasks(rawA, first);
      const second = await prepareSharedTasksForSession(rawB, 'session');
      expect(first.marker).not.toBe(second.marker);
      expect(first.rowIds).not.toEqual(second.rowIds);
      // Even if a stale process presents the current row id, its old marker
      // cannot finalize or remove a later process's preparation.
      await finalizePreparedSharedTasks(rawA, { ...first, rowIds: second.rowIds });
      await rollbackPreparedSharedTasks(rawA, { ...first, rowIds: second.rowIds });
      expect((await journalA.latest()).find((item) => item.sharedTaskId === 'close-race')).toMatchObject({ terminal: false });
      await finalizePreparedSharedTasks(rawB, second);
      expect((await journalA.latest()).find((item) => item.sharedTaskId === 'close-race')).toMatchObject({ terminal: true });
    } finally {
      await Promise.all([peerA.close(), peerB?.close()]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
