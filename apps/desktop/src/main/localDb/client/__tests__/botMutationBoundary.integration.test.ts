import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../__tests__/dbWorkerTestUtils.js';
import { WorkerThreadTransport } from '../WorkerThreadTransport.js';

/**
 * These are actual named Bot transactions over the worker transport, not a
 * service mock or a hand-written bot_profiles UPDATE. The fixture keeps two
 * independent peers and Bot identities in one task-owned SQLite database so
 * the host dispatch barrier is exercised with the production default of 128
 * in-flight RPCs.
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

  it('denies profile, canonical and lifecycle writes after peer revocation', async () => {
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
    seed.exec([
      'CREATE TABLE sessions (',
      '  id TEXT PRIMARY KEY, title TEXT NOT NULL, working_dir TEXT, workspace_kind TEXT NOT NULL,',
      '  model TEXT NOT NULL, effort TEXT NOT NULL, permission_mode TEXT NOT NULL, status TEXT NOT NULL,',
      '  sdk_session_id TEXT, total_token_usage INTEGER NOT NULL, total_cost_usd REAL NOT NULL,',
      '  context_tokens INTEGER NOT NULL, context_window INTEGER NOT NULL, fast_mode INTEGER NOT NULL,',
      '  plan_mode_enabled INTEGER NOT NULL, cleared_at INTEGER, pinned_at INTEGER, user_send_at INTEGER,',
      '  agent_kind TEXT NOT NULL, orca_role TEXT, parent_session_id TEXT, forked_at_message_id TEXT,',
      '  worktree_path TEXT, extra_dirs TEXT NOT NULL, remote_host_id TEXT, provider_id TEXT,',
      '  source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE bot_profiles (',
      '  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL, avatar TEXT NOT NULL,',
      '  avatar_color TEXT NOT NULL, status TEXT NOT NULL, current_version INTEGER NOT NULL,',
      '  hidden_at INTEGER, pinned_at INTEGER, attention_reason TEXT, attention_at INTEGER,',
      '  canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,',
      '  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE bot_profile_versions (',
      '  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,',
      '  version INTEGER NOT NULL, identity_source TEXT NOT NULL, capabilities_json TEXT NOT NULL,',
      '  created_at INTEGER NOT NULL, UNIQUE(bot_id, version)',
      ');',
      'CREATE TABLE bot_session_links (',
      '  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,',
      '  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,',
      '  profile_version INTEGER NOT NULL, role TEXT NOT NULL, route_key TEXT,',
      '  created_at INTEGER NOT NULL, archived_at INTEGER',
      ');',
      "CREATE UNIQUE INDEX uniq_bot_canonical ON bot_session_links(bot_id) WHERE role = 'canonical';",
      'CREATE TABLE bot_lifecycle_events (',
      '  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,',
      '  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, event_type TEXT NOT NULL,',
      '  payload_json TEXT NOT NULL, created_at INTEGER NOT NULL',
      ');',
    ].join(String.fromCharCode(10)));
    seed.close();

    const peerA = new WorkerThreadTransport({
      workerScriptPath,
      dbPath,
      drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      maxQueuedRpcs: 8,
    });
    const peerB = new WorkerThreadTransport({
      workerScriptPath,
      dbPath,
      drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      maxQueuedRpcs: 8,
    });
    const profile = (id: string, displayName: string) => ({
      id, displayName, description: '', avatar: '🤖', avatarColor: 'blue',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    });
    const session = (id: string, title: string, now: number) => ({
      id, title, workingDir: '/tmp/' + id, workspaceKind: 'dialogue',
      model: 'claude-sonnet-4-6', effort: 'high', permissionMode: 'ask', agentKind: 'cc',
      remoteHostId: null, providerId: null, extraDirs: '[]', source: 'bot',
      createdAt: now, updatedAt: now,
    });
    let ownerA = 'owner-a';
    let ownerB = 'owner-b';
    let revokedA = false;
    let revokedB = false;
    try {
      await peerA.send('tx', { name: 'bots.createProfile', args: profile('bot-a', 'A') });
      await peerA.send('tx', { name: 'bots.createProfile', args: profile('bot-b', 'B') });

      const activeProfile = peerA.send('sleep', { ms: 70 });
      const deniedProfile = peerA.send(
        'tx',
        { name: 'bots.updateProfile', args: {
          id: 'bot-a', expectedCurrentVersion: 1, displayName: 'A revoked',
          profileContentChanged: false, identitySource: 'identity', capabilitiesJson: '{}', now: 2,
        } },
        undefined,
        () => { if (revokedA || ownerA !== 'owner-a') throw new Error('peer A operation revoked'); },
      );
      revokedA = true;
      ownerA = 'owner-a-replaced';
      await expect(activeProfile).resolves.toEqual({ slept: 70 });
      await expect(deniedProfile).rejects.toThrow('peer A operation revoked');

      const activeCanonical = peerB.send('sleep', { ms: 70 });
      const deniedCanonical = peerB.send(
        'tx',
        { name: 'bots.replaceCanonicalSession', args: {
          botId: 'bot-b', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
          session: session('canonical-b', 'B', 2), now: 2,
        } },
        undefined,
        () => { if (revokedB || ownerB !== 'owner-b') throw new Error('peer B operation revoked'); },
      );
      revokedB = true;
      ownerB = 'owner-b-replaced';
      await expect(activeCanonical).resolves.toEqual({ slept: 70 });
      await expect(deniedCanonical).rejects.toThrow('peer B operation revoked');

      const activeLifecycle = peerA.send('sleep', { ms: 70 });
      const deniedLifecycle = peerA.send(
        'tx',
        { name: 'bots.pauseLifecycle', args: {
          botId: 'bot-a', expectedProfileStatus: 'active', canonicalSessionId: null,
          eventId: 'bot-a:pause:2', at: 2,
        } },
        undefined,
        () => { if (revokedA || ownerA !== 'owner-a') throw new Error('peer A lifecycle revoked'); },
      );
      await expect(activeLifecycle).resolves.toEqual({ slept: 70 });
      await expect(deniedLifecycle).rejects.toThrow('peer A lifecycle revoked');

      await expect(peerA.send('query', {
        sql: 'SELECT id, display_name AS name, status, current_version AS version FROM bot_profiles ORDER BY id',
      })).resolves.toEqual([
        { id: 'bot-a', name: 'A', status: 'active', version: 1 },
        { id: 'bot-b', name: 'B', status: 'active', version: 1 },
      ]);
      await expect(peerA.send('query', { sql: 'SELECT COUNT(*) AS count FROM sessions' }))
        .resolves.toEqual([{ count: 0 }]);
      await expect(peerA.send('query', { sql: 'SELECT COUNT(*) AS count FROM bot_lifecycle_events' }))
        .resolves.toEqual([{ count: 2 }]);

      // An allowed guarded operation still runs at the same final dispatch
      // boundary; revocation, rather than transport serialization, decides it.
      revokedA = false;
      await expect(peerA.send(
        'tx',
        { name: 'bots.updateProfile', args: {
          id: 'bot-a', expectedCurrentVersion: 1, displayName: 'A allowed',
          profileContentChanged: false, identitySource: 'identity', capabilitiesJson: '{}', now: 3,
        } },
        undefined,
        () => { if (revokedA || ownerA !== 'owner-a-replaced') throw new Error('peer A operation revoked'); },
      )).resolves.toEqual({ currentVersion: 1 });
    } finally {
      await Promise.all([peerA.close(), peerB.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
