import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../__tests__/dbWorkerTestUtils.js';
import { WorkerThreadTransport } from '../WorkerThreadTransport.js';

/**
 * This is deliberately an actual SQLite/worker-transport test.  The service
 * tests exercise which guard is supplied; this fixture proves that a request
 * which waited behind another DB RPC is denied at the host dispatch boundary
 * for each peer/bot independently, before SQLite sees the write.
 */
describe('remote Bot mutation dispatch boundary', () => {
  let workerDir: string;
  let workerScriptPath: string;

  beforeAll(async () => {
    workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-bot-mutation-boundary-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(workerDir, 'worker'));
  });

  afterAll(() => {
    if (workerDir) fs.rmSync(workerDir, { recursive: true, force: true });
  });

  it('rejects queued writes after peer/owner revocation across two SQLite worker clients', async () => {
    const dir = fs.mkdtempSync(path.join(workerDir, 'fixture-'));
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'bots.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
      'utf8',
    );
    createMigratedSmokeDb(dbPath);
    const seed = new (await import('better-sqlite3')).default(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.close();

    const peerA = new WorkerThreadTransport({
      workerScriptPath,
      dbPath,
      drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      maxInFlightRpcs: 1,
      maxQueuedRpcs: 2,
    });
    const peerB = new WorkerThreadTransport({
      workerScriptPath,
      dbPath,
      drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      maxInFlightRpcs: 1,
      maxQueuedRpcs: 2,
    });
    await peerA.send('query', { sql: 'SELECT 1 AS ready' });
    await peerB.send('query', { sql: 'SELECT 1 AS ready' });
    let ownerA = 'owner-a';
    let ownerB = 'owner-b';
    let peerARevoked = false;
    let peerBRevoked = false;
    try {
      await peerA.send('exec', {
        sql: `CREATE TABLE bot_profiles (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          name TEXT NOT NULL,
          revision INTEGER NOT NULL
        )`,
      });
      await peerA.send('exec', {
        sql: 'INSERT INTO bot_profiles (id, owner, name, revision) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        params: ['bot-a', ownerA, 'A', 1, 'bot-b', ownerB, 'B', 1],
      });

      const activeA = peerA.send('sleep', { ms: 50 });
      const activeB = peerB.send('sleep', { ms: 50 });
      const queuedA = peerA.send(
        'exec',
        { sql: 'UPDATE bot_profiles SET name = ?, revision = revision + 1 WHERE id = ? AND owner = ?', params: ['A-unauthorized', 'bot-a', ownerA] },
        undefined,
        () => {
          if (peerARevoked || ownerA !== 'owner-a') throw new Error('peer A operation revoked');
        },
      );
      const queuedB = peerB.send(
        'exec',
        { sql: 'UPDATE bot_profiles SET name = ?, revision = revision + 1 WHERE id = ? AND owner = ?', params: ['B-unauthorized', 'bot-b', ownerB] },
        undefined,
        () => {
          if (peerBRevoked || ownerB !== 'owner-b') throw new Error('peer B operation revoked');
        },
      );
      const deniedA = queuedA.then(
        () => { throw new Error('peer A write unexpectedly dispatched'); },
        (error: unknown) => expect(error).toHaveProperty('message', 'peer A operation revoked'),
      );
      const deniedB = queuedB.then(
        () => { throw new Error('peer B write unexpectedly dispatched'); },
        (error: unknown) => expect(error).toHaveProperty('message', 'peer B operation revoked'),
      );

      // Revoke after both requests entered their transport queues.  Changing
      // the captured owner models account/owner replacement while the queue is
      // blocked; the callback still runs in the host immediately before send.
      peerARevoked = true;
      ownerA = 'owner-a-replaced';
      peerBRevoked = true;
      ownerB = 'owner-b-replaced';
      await expect(activeA).resolves.toEqual({ slept: 50 });
      await expect(activeB).resolves.toEqual({ slept: 50 });
      await Promise.all([deniedA, deniedB]);

      await expect(peerA.send('query', { sql: 'SELECT id, owner, name, revision FROM bot_profiles ORDER BY id' })).resolves.toEqual([
        { id: 'bot-a', owner: 'owner-a', name: 'A', revision: 1 },
        { id: 'bot-b', owner: 'owner-b', name: 'B', revision: 1 },
      ]);
    } finally {
      await Promise.all([peerA.close(), peerB.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
