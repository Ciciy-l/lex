import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { not } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import * as schema from '../schema';
import { assertNotRetiredCompanionSession, readRetiredCompanionSessions } from '../retiredCompanions';
import { retiredCompanionSessionSql } from '../retiredCompanionSql';
import { persistSessionPermission } from '../sessionPermissionSql';
import { tx } from '../worker/opHandlers/tx';
import { readLocalWorktreeReferences } from '../worker/worktreeReferences';
import { DrizzleScheduleStorage } from '../../scheduler-host/storage';
import { applyScheduleRunCostMetaChange, recordScheduleRunCostDirect } from '../../scheduler-host/runCostLedger';

vi.mock('../../appSessionState', () => ({ isAppSessionBoundaryPending: () => false }));
vi.mock('../../maker-ipc/broadcastSessionPatched', () => ({ broadcastSessionPatched: vi.fn() }));

// Registered by migrationReplay.test.ts: run against the published lineage in its dedicated tier.
const lineageIt = process.platform === 'win32' || process.platform === 'darwin' ? it : it.skip;
lineageIt('preserves four legacy ownership forms, their history, permissions, jobs and files after retirement', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lex-retained-companions-'));
  const db = createBetterSqliteDatabase(path.join(dir, 'lex.db'));
  let client: DbClient | undefined;
  try {
    // Match the product's persistent journal mode without relaxing synchronous
    // durability. Replaying and seeding a real file must not create a rollback
    // journal for every individual write on a slow Windows disk.
    expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
    const desktop = path.resolve(__dirname, '../../../..');
    db.loadExtension(path.join(desktop, 'native', 'sqlite-vec', process.platform + '-' + process.arch, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
    runMigrationReplay(db, { drizzleDir: path.join(desktop, 'drizzle') });
    const orm = drizzle(db, { schema });
    client = {
      query: async (query, params = []) => db.prepare(query).all(...params),
      queryOne: async (query, params = []) => db.prepare(query).get(...params),
      exec: async (query, params = []) => db.prepare(query).run(...params),
      tx: async (name: string, args: unknown) => tx(db, { name, args }),
      drizzle: orm, vecAvailable: true, dispose: async () => {},
    } as DbClient;
    setCurrentDbClient(client, 'retirement-fixture');
    const retired = ['by-source', 'by-link', 'by-profile', 'by-delegation'];
    const ordinary = ['ordinary', 'orca', 'telegram'];
    const file = path.join(dir, 'retained-memory.md');
    const queue = path.join(dir, 'routines.json');
    writeFileSync(file, 'Retained user memory and attachment bytes');
    writeFileSync(queue, '{"routines":[{"botId":"legacy"}]}');
    const skipTargets = retired.map(id => 'skip-' + id);
    // Only fixture preparation is batched. Every production mutation below
    // still runs with its own transaction and retirement checks.
    db.transaction(() => {
      for (const id of [...retired, ...ordinary]) {
        db.prepare('INSERT INTO sessions (id, source, status, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
          .run(id, id === 'by-source' ? 'bot' : id === 'telegram' ? 'telegram' : 'desktop', 'archived', path.join(dir, id));
        db.prepare('INSERT INTO messages (id, session_id, client_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, 2)')
          .run('message-' + id, id, 'client-' + id, 'tool_result', 'preserve original tool result');
      }
      db.prepare('INSERT INTO bot_profiles (id, display_name, canonical_session_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
        .run('legacy', 'Retained companion', 'by-profile');
      db.prepare('INSERT INTO bot_session_links (id, bot_id, session_id, role, created_at, archived_at) VALUES (?, ?, ?, ?, 1, 2)')
        .run('link', 'legacy', 'by-link', 'history');
      db.prepare('INSERT INTO bot_delegations (id, requesting_bot_id, child_session_id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
        .run('delegation', 'legacy', 'by-delegation', 'preserve objective', 'completed');
      for (const id of ['routine-source', ...retired, ...skipTargets, 'ordinary']) {
        db.prepare('INSERT INTO schedules (id, name, prompt, source, cron_expr, timezone, target_session_id, agent_kind, created_at, updated_at, next_fire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 100)')
          .run('schedule-' + id, id, 'preserved prompt', id === 'routine-source' ? 'bot' : 'user', '* * * * *', 'UTC', id === 'routine-source' || id.startsWith('skip-') ? null : id, 'claude-code');
        if (id.startsWith('skip-')) db.prepare('UPDATE schedules SET skip_log_session_id = ? WHERE id = ?').run(id.slice(5), 'schedule-' + id);
        db.prepare('INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at, status) VALUES (?, ?, ?, 1, ?)')
          .run('run-' + id, 'schedule-' + id, id === 'routine-source' || id.startsWith('skip-') ? null : id, 'running');
      }
    })();
    const retainedTables = ['sessions', 'messages', 'bot_profiles', 'bot_session_links', 'bot_delegations', 'schedules', 'schedule_runs'];
    const before = new Map(retainedTables.map(table => [table, JSON.stringify(db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all())]));
    expect([...await readRetiredCompanionSessions([...retired, ...ordinary])].sort()).toEqual([...retired].sort());
    expect((await orm.select({ id: schema.sessions.id }).from(schema.sessions).where(not(retiredCompanionSessionSql(schema.sessions.id)))).map(row => row.id).sort()).toEqual([...ordinary].sort());
    const storage = new DrizzleScheduleStorage(() => orm);
    expect((await storage.listActive()).map(row => row.id)).toEqual(['schedule-ordinary']);
    for (const id of retired) {
      await expect(assertNotRetiredCompanionSession(id)).rejects.toThrow('NOT_FOUND');
      expect(persistSessionPermission(db, { sessionId: id, mode: 'bypassPermissions' })).toEqual({ updated: false });
      expect(() => tx(db, { name: 'sessions.setTerminalStatus', args: { sessionId: id, status: 'deleted' } })).toThrow('Retired session');
      tx(db, { name: 'toolResults.compactSession', args: { sessionId: id, now: 100 } });
    }
    for (const id of ['routine-source', ...retired, ...skipTargets]) {
      const scheduleId = 'schedule-' + id;
      expect(await storage.get(scheduleId)).toBeNull();
      expect(await storage.claimDueFire(scheduleId, 100)).toBeNull();
      expect(await storage.update(scheduleId, { status: 'paused' })).toBeNull();
      expect(await storage.updateRun('run-' + id, { status: 'aborted' })).toBeNull();
      expect(await storage.listRuns(scheduleId)).toEqual([]);
      expect(await recordScheduleRunCostDirect({ runId: 'run-' + id, money: { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' } })).toBeNull();
      await applyScheduleRunCostMetaChange({}, { origin: { kind: 'scheduler', runId: 'run-' + id }, turnCostUsd: 2 });
      await storage.delete(scheduleId);
    }
    await expect(storage.insertRun({ id: 'blocked-run', scheduleId: 'schedule-ordinary', sessionId: retired[0], status: 'running', firedAt: 4 })).rejects.toThrow('unavailable');
    expect(await storage.deleteOrphanRuns()).toBe(0);
    const refs = readLocalWorktreeReferences(db, Database);
    expect(refs.filter(row => row.source === 'bot').map(row => row.id).sort()).toEqual([...retired].sort());
    for (const table of retainedTables) expect(JSON.stringify(db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all())).toBe(before.get(table));
    // Verify committed retention from an independent disk connection, not just
    // the writer's view; this also covers rows still residing in the WAL.
    const reopened = createBetterSqliteDatabase(path.join(dir, 'lex.db'), { readonly: true });
    try {
      for (const table of retainedTables) expect(JSON.stringify(reopened.prepare('SELECT * FROM ' + table + ' ORDER BY id').all())).toBe(before.get(table));
    } finally {
      reopened.close();
    }
    expect(readFileSync(file, 'utf8')).toBe('Retained user memory and attachment bytes');
    expect(readFileSync(queue, 'utf8')).toBe('{"routines":[{"botId":"legacy"}]}');
    for (const id of ordinary) {
      await expect(assertNotRetiredCompanionSession(id)).resolves.toBeUndefined();
      expect(persistSessionPermission(db, { sessionId: id, mode: 'auto' })).toEqual({ updated: true });
    }
    expect(await storage.claimDueFire('schedule-ordinary', 100)).not.toBeNull();
  } finally {
    if (client) clearCurrentDbClient(client);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
