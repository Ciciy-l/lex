import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../__tests__/dbWorkerTestUtils.js';
import { WorkerThreadTransport } from '../WorkerThreadTransport.js';

describe('retired companion transactions at the worker boundary', () => {
  let workerDir: string;
  let workerScriptPath: string;
  beforeAll(async () => {
    workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-bot-mutation-boundary-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(workerDir, 'worker'));
  });
  afterAll(() => { if (workerDir) fs.rmSync(workerDir, { recursive: true, force: true }); });

  it.each([false, true])('rejects retired writes without reviving services and keeps peer revocation checks (inline=%s)', async (inline) => {
    const dir = fs.mkdtempSync(path.join(workerDir, 'fixture-'));
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'retained.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), 'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    createMigratedSmokeDb(dbPath);
    const seed = new Database(dbPath);
    // Establish the persistent WAL mode before either independent peer opens the fixture.
    seed.pragma('journal_mode = WAL');
    seed.exec("CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, display_name TEXT); INSERT INTO bot_profiles VALUES ('old', 'Retained original');");
    seed.close();
    const options = {
      ...(inline ? { useInlineWorker: true } : { workerScriptPath }),
      dbPath, drizzleDir, betterSqliteModulePath: require.resolve('better-sqlite3'), maxQueuedRpcs: 8,
    };
    const peerA = new WorkerThreadTransport(options);
    const peerB = new WorkerThreadTransport(options);
    let owner = 'owner-a';
    let revoked = false;
    try {
      for (const name of ['bots.createProfile', 'bots.updateProfile', 'bots.replaceCanonicalSession', 'bots.pauseLifecycle', 'bots.resumeLifecycle', 'bots.archiveLifecycle', 'bots.deleteProfile', 'bots.createDelegation']) {
        await expect(peerA.send('tx', { name, args: { id: 'old', displayName: 'changed' } })).rejects.toThrow('unknown tx');
      }
      for (const [peer, name] of [[peerA, 'bots.updateProfile'], [peerB, 'bots.replaceCanonicalSession'], [peerA, 'bots.pauseLifecycle']] as const) {
        revoked = false;
        owner = 'owner-a';
        const active = peer.send('sleep', { ms: 70 });
        const pending = peer.send('tx', { name, args: {} }, undefined, () => {
          if (revoked || owner !== 'owner-a') throw new Error('peer operation revoked');
        });
        revoked = true;
        owner = 'owner-replaced';
        await expect(active).resolves.toEqual({ slept: 70 });
        await expect(pending).rejects.toThrow('peer operation revoked');
      }
      await expect(peerA.send('query', { sql: 'SELECT * FROM bot_profiles' })).resolves.toEqual([{ id: 'old', display_name: 'Retained original' }]);
      // Ordinary authorized writes still use the same transport guard.
      revoked = false;
      await peerA.send('exec', { sql: "UPDATE worker_smoke SET name = 'ordinary'" }, undefined, () => {
        if (revoked || owner !== 'owner-replaced') throw new Error('peer operation revoked');
      });
      await expect(peerB.send('query', { sql: 'SELECT name FROM worker_smoke' })).resolves.toEqual([{ name: 'ordinary' }]);
      await expect(peerB.send('query', { sql: 'SELECT * FROM bot_profiles' })).resolves.toEqual([{ id: 'old', display_name: 'Retained original' }]);
    } finally {
      await Promise.all([peerA.close(), peerB.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
