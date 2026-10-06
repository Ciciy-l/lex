import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeOwnedSharedTasksInJournal,
  closeSharedTasksInJournalForSession,
  createSharedTaskJournal,
  finalizePreparedSharedTasks,
  prepareSharedTasksForSession,
  rollbackPreparedSharedTasks,
} from '../sharedTasks.js';
import type { SharedTaskSnapshot } from '@cindy/device-link';

const snapshot = (revision = 1): SharedTaskSnapshot => ({
  sharedTaskId: 'sharedTask', sessionId: 'session', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  revision, status: 'active', guests: [{ memberId: 'member', accountId: 'guest', version: 1, deviceIds: ['phone'] }],
});
let db: Database.Database;
let journal: ReturnType<typeof createSharedTaskJournal>;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('session'), ('other-session')");
  db.exec(readFileSync(resolve(process.cwd(), 'drizzle/0112_amused_guardsmen.sql'), 'utf8'));
  db.exec(readFileSync(resolve(process.cwd(), 'drizzle/0113_yummy_maelstrom.sql'), 'utf8'));
  journal = createSharedTaskJournal({
    async exec(sql, params = []) { return db.prepare(sql).run(...params); },
    async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
  });
});
afterEach(() => db.close());

describe('sharedTask authority journal', () => {
  it('prepares a terminal fence and rolls back only that preparation', async () => {
    await journal.recordAuthority(snapshot());
    const writer = {
      async exec(sql: string, params = []) { return db.prepare(sql).run(...params); },
      async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
    };
    const prepared = await prepareSharedTasksForSession(writer, 'session');
    expect(prepared.rowIds).toHaveLength(1);
    expect(prepared.status).toBe('acquired');
    expect(prepared.marker).toMatch(/^[0-9a-f-]{36}$/);
    expect(await journal.latest()).toMatchObject([{ terminal: false }]);
    await rollbackPreparedSharedTasks(writer, prepared);
    expect(await journal.latest()).toMatchObject([{ terminal: false }]);
    const committed = await prepareSharedTasksForSession(writer, 'session');
    await finalizePreparedSharedTasks(writer, committed);
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
  });

  it('hands off all generations of only the terminal task through the shared profile journal', async () => {
    await journal.recordAuthority(snapshot());
    await journal.recordAuthority({ ...snapshot(), sharedTaskId: 'new-share' });
    await journal.recordAuthority({ ...snapshot(), sharedTaskId: 'other-share', sessionId: 'other-session' });
    const writer = {
      async exec(sql: string, params: unknown[] = []) { return db.prepare(sql).run(...params); },
      async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
    };
    expect((await closeSharedTasksInJournalForSession(writer, 'session')).sort()).toEqual(['new-share', 'sharedTask']);
    await closeSharedTasksInJournalForSession(writer, 'session');
    expect(await journal.recordAuthority(snapshot(99))).toBe(false);
    const records = await journal.latest();
    expect(records.filter((item) => item.sessionId === 'session').every((item) => item.terminal)).toBe(true);
    expect(records.find((item) => item.sharedTaskId === 'other-share')?.terminal).toBe(false);
    expect(await closeSharedTasksInJournalForSession(writer, 'unshared')).toEqual([]);
  });
  it('closes only host-owned snapshots when no relay runtime is bound', async () => {
    await journal.recordAuthority(snapshot());
    await journal.recordAuthority({ ...snapshot(), sharedTaskId: 'foreign', ownerAccountId: 'other-owner' });
    const writer = {
      async exec(sql: string, params = []) { return db.prepare(sql).run(...params); },
      async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
    };
    await expect(closeOwnedSharedTasksInJournal(writer, 'owner', 'desktop')).resolves.toEqual(['sharedTask']);
    expect((await journal.latest()).find((item) => item.sharedTaskId === 'sharedTask')?.terminal).toBe(true);
    expect((await journal.latest()).find((item) => item.sharedTaskId === 'foreign')?.terminal).toBe(false);
  });
  it('retains membership changes and reads only the latest authority', async () => {
    expect(await journal.recordAuthority(snapshot())).toBe(true);
    expect(await journal.recordAuthority({ ...snapshot(2), guests: [] })).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM shared_task_events').get()).toEqual({ n: 2 });
    expect(await journal.latest()).toMatchObject([{ snapshot: { revision: 2, guests: [] }, terminal: false }]);
  });
  it('ignores stale and duplicate revisions without losing audit history', async () => {
    await journal.recordAuthority(snapshot(2));
    expect(await journal.recordAuthority(snapshot())).toBe(false);
    expect(await journal.recordAuthority(snapshot(2))).toBe(false);
    expect(await journal.latest()).toMatchObject([{ snapshot: { revision: 2 } }]);
  });
  it('distinguishes same-revision content and immutable identity conflicts from stale authority', async () => {
    await journal.recordAuthority(snapshot());
    await expect(journal.recordAuthority({ ...snapshot(), guests: [] })).rejects.toThrow('conflict');
    await expect(journal.recordAuthority({ ...snapshot(2), ownerAccountId: 'other-owner' })).rejects.toThrow('identity');
    await expect(journal.recordAuthority({ ...snapshot(2), hostDeviceId: 'other-host' })).rejects.toThrow('identity');
    await expect(journal.recordAuthority({ ...snapshot(2), sessionId: 'other-session' })).rejects.toThrow('scope');
    expect(await journal.recordAuthority(snapshot(1))).toBe(false);
  });
  it('does not let another task reuse a sharedTask identity', async () => {
    await journal.recordAuthority(snapshot());
    await expect(journal.recordAuthority({ ...snapshot(2), sessionId: 'other-session' })).rejects.toThrow('scope');
    await expect(journal.close({ ...snapshot(), sessionId: 'other-session' })).rejects.toThrow('scope');
    expect(await journal.latest()).toMatchObject([{ sessionId: 'session', terminal: false }]);
  });
  it.each(['local', 'server'])('keeps a %s closure terminal when late replies arrive', async (source) => {
    await journal.recordAuthority(snapshot());
    if (source === 'local') { await journal.close(snapshot()); await journal.close(snapshot()); }
    else await journal.recordAuthority({ ...snapshot(2), status: 'closed' });
    expect(await journal.recordAuthority(snapshot(20))).toBe(false);
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
  });
  it('allows a fresh sharedTask for the same task after closing the previous one', async () => {
    await journal.close(snapshot());
    expect(await journal.recordAuthority({ ...snapshot(), sharedTaskId: 'new-sharedTask' })).toBe(true);
    expect(await journal.latest()).toHaveLength(2);
  });
  it('cascades journal deletion only with its owning task', async () => {
    await journal.recordAuthority(snapshot());
    db.prepare("DELETE FROM sessions WHERE id = 'other-session'").run();
    expect(await journal.latest()).toHaveLength(1);
    db.prepare("DELETE FROM sessions WHERE id = 'session'").run();
    expect(await journal.latest()).toEqual([]);
  });

  it('upgrades its own prepared closure atomically and rollback cannot undo it', async () => {
    await journal.recordAuthority(snapshot());
    const writer = {
      async exec(sql: string, params = []) { return db.prepare(sql).run(...params); },
      async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
    };
    const prepared = await prepareSharedTasksForSession(writer, 'session');
    await journal.close(snapshot());
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
    await rollbackPreparedSharedTasks(writer, prepared);
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shared_task_events WHERE kind = 'local-close'").get()).toEqual({ n: 1 });
  });

  it('does not let interleaved preparations steal a marker or downgrade terminal state', async () => {
    await journal.recordAuthority(snapshot());
    const writer = {
      async exec(sql: string, params = []) { return db.prepare(sql).run(...params); },
      async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
    };
    const first = await prepareSharedTasksForSession(writer, 'session');
    const second = await prepareSharedTasksForSession(writer, 'session');
    expect(first.rowIds).toHaveLength(1);
    expect(second.rowIds).toEqual([]);
    expect(second.status).toBe('occupied');
    await finalizePreparedSharedTasks(writer, second);
    expect(await journal.latest()).toMatchObject([{ terminal: false }]);
    await rollbackPreparedSharedTasks(writer, second);
    expect(await journal.latest()).toMatchObject([{ terminal: false }]);
    await finalizePreparedSharedTasks(writer, first);
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
    await rollbackPreparedSharedTasks(writer, first);
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
  });

  it('refuses an owner or host identity change before touching the closure row', async () => {
    await journal.recordAuthority(snapshot());
    await expect(journal.close({ ...snapshot(), ownerAccountId: 'other-owner' })).rejects.toThrow('identity');
    await expect(journal.close({ ...snapshot(), hostDeviceId: 'other-host' })).rejects.toThrow('identity');
    expect(await journal.latest()).toMatchObject([{ terminal: false }]);
  });
});
