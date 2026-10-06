import { randomUUID } from 'node:crypto';
import { parseSharedTaskSnapshot, type SharedTaskIdentity, type SharedTaskSnapshot } from '@cindy/device-link';
import type { DbClient } from './client/DbClient.js';
import { CLOSE_SHARED_TASKS_FOR_SESSION_SQL, PREPARE_SHARED_TASKS_FOR_SESSION_SQL } from './sharedTaskClosureSql.js';

function nextClosureMarker(): string {
  // recorded_at is also the ownership marker for prepared rows. A timestamp
  // plus a process-local counter is not unique when two profile workers
  // prepare at the same instant, so use an opaque cross-process nonce.
  return randomUUID();
}

export interface PreparedSharedTaskClosure {
  sessionId: string;
  marker: string;
  rowIds: number[];
  /** Explicitly distinguishes a lease from an existing prepare or no rows. */
  status: 'acquired' | 'occupied' | 'none';
  lease: 'acquired' | 'occupied' | 'none';
}

/** Persist the local-close fence before a session enters a terminal state. */
export async function prepareSharedTasksForSession(
  db: Pick<DbClient, 'exec' | 'query'>,
  sessionId: string,
): Promise<PreparedSharedTaskClosure> {
  const marker = nextClosureMarker();
  const sourceRows = await db.query<{ shared_task_id: string }>(
    "SELECT DISTINCT shared_task_id FROM shared_task_events WHERE session_id = ?",
    [sessionId],
  );
  if (sourceRows.length === 0) {
    return { sessionId, marker, rowIds: [], status: 'none', lease: 'none' };
  }
  await db.exec(PREPARE_SHARED_TASKS_FOR_SESSION_SQL, [Date.now(), marker, sessionId]);
  const rows = await db.query<{ id: number; terminal: number; closure_token: string | null }>(
    "SELECT id, terminal, closure_token FROM shared_task_events WHERE session_id = ? AND kind = 'local-close' AND revision = 0",
    [sessionId],
  );
  const acquired = rows.filter((row) => row.terminal === 0 && row.closure_token === marker);
  const hasTerminal = rows.some((row) => row.terminal === 1);
  const status = acquired.length > 0 ? 'acquired' : hasTerminal ? 'none' : 'occupied';
  return { sessionId, marker, rowIds: acquired.map((row) => row.id), status, lease: status };
}

/** Remove only a prepare whose terminal session write did not commit. */
export async function rollbackPreparedSharedTasks(
  db: Pick<DbClient, 'exec'>,
  prepared: PreparedSharedTaskClosure,
): Promise<void> {
  if (prepared.rowIds.length === 0) return;
  const placeholders = prepared.rowIds.map(() => '?').join(',');
  await db.exec(
    "DELETE FROM shared_task_events WHERE id IN (" + placeholders + ") AND session_id = ? AND kind = 'local-close' AND revision = 0 AND terminal = 0 AND closure_token = ?",
    [...prepared.rowIds, prepared.sessionId, prepared.marker],
  );
}

/** Make a previously prepared closure durable after the terminal status commit. */
export async function finalizePreparedSharedTasks(
  db: Pick<DbClient, 'exec'>,
  prepared: PreparedSharedTaskClosure,
): Promise<void> {
  if (prepared.rowIds.length === 0) return;
  const placeholders = prepared.rowIds.map(() => '?').join(',');
  await db.exec(
    "UPDATE shared_task_events SET terminal = 1, closure_token = NULL WHERE id IN (" + placeholders + ") AND session_id = ? AND kind = 'local-close' AND revision = 0 AND terminal = 0 AND closure_token = ?",
    [...prepared.rowIds, prepared.sessionId, prepared.marker],
  );
}

/** Does not require a live Host; the captured profile DB owns these closures. */
export async function closeSharedTasksInJournalForSession(db: Pick<DbClient, 'exec' | 'query'>, sessionId: string): Promise<string[]> {
  await db.exec(CLOSE_SHARED_TASKS_FOR_SESSION_SQL, [Date.now(), sessionId]);
  const rows = await db.query<{ shared_task_id: string }>(
    'SELECT DISTINCT shared_task_id FROM shared_task_events WHERE session_id = ? AND terminal = 1', [sessionId]);
  return rows.map((row) => row.shared_task_id);
}

/** Close host-owned journal snapshots even when no relay runtime is bound. */
export async function closeOwnedSharedTasksInJournal(
  db: Pick<DbClient, 'exec' | 'query'>,
  ownerAccountId: string,
  hostDeviceId: string,
): Promise<string[]> {
  const journal = createSharedTaskJournal(db);
  const ids: string[] = [];
  for (const item of await journal.latest()) {
    if (item.terminal || !item.snapshot ||
        item.snapshot.ownerAccountId !== ownerAccountId ||
        item.snapshot.hostDeviceId !== hostDeviceId) continue;
    await journal.close(item.snapshot);
    ids.push(item.sharedTaskId);
  }
  return ids;
}

export interface SharedTaskJournalEntry {
  sharedTaskId: string;
  sessionId: string;
  terminal: boolean;
  snapshot: SharedTaskSnapshot | null;
}

export class SharedTaskJournalConflictError extends Error {
  readonly code = 'SHARED_TASK_JOURNAL_CONFLICT';
  constructor(message = 'SharedTask journal authority conflict') {
    super(message);
    this.name = 'SharedTaskJournalConflictError';
  }
}

type SharedTaskJournalRow = {
  session_id: string;
  kind: 'authority' | 'local-close';
  revision: number;
  terminal: number;
  snapshot: string | null;
};

function sameSnapshot(left: SharedTaskSnapshot, right: SharedTaskSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertAuthorityRowsCompatible(rows: SharedTaskJournalRow[], snapshot: SharedTaskSnapshot): void {
  for (const row of rows) {
    if (row.session_id !== snapshot.sessionId) {
      throw new SharedTaskJournalConflictError('SharedTask journal scope mismatch');
    }
    if (!row.snapshot) continue;
    const stored = parseSharedTaskSnapshot(JSON.parse(row.snapshot));
    if (stored.ownerAccountId !== snapshot.ownerAccountId || stored.hostDeviceId !== snapshot.hostDeviceId) {
      throw new SharedTaskJournalConflictError('SharedTask journal identity mismatch');
    }
  }
}

function classifyAuthorityWrite(rows: SharedTaskJournalRow[], snapshot: SharedTaskSnapshot): boolean {
  assertAuthorityRowsCompatible(rows, snapshot);
  for (const row of rows) {
    if (row.terminal === 1 || row.kind === 'local-close') return false;
    if (row.kind !== 'authority') continue;
    if (row.revision === snapshot.revision) {
      const stored = row.snapshot ? parseSharedTaskSnapshot(JSON.parse(row.snapshot)) : null;
      if (stored && sameSnapshot(stored, snapshot)) return false;
      throw new SharedTaskJournalConflictError();
    }
    if (row.revision > snapshot.revision) return false;
  }
  // An INSERT ... SELECT which reported no changes must have observed a row
  // (or a unique conflict). Treat an impossible empty/incomplete read as an
  // error rather than silently classifying a lost write as stale.
  throw new SharedTaskJournalConflictError('SharedTask journal write could not be classified');
}

/** Bound to one profile's DbClient; never resolves a different account after an await. */
export function createSharedTaskJournal(db: Pick<DbClient, 'exec' | 'query'>, now: () => number = Date.now) {
  return {
    async recordAuthority(value: SharedTaskSnapshot): Promise<boolean> {
      const snapshot = parseSharedTaskSnapshot(value);
      // The predicate is evaluated by SQLite at the write boundary. Do not
      // split this into a pre-read followed by an INSERT: another profile
      // worker may commit a same-revision snapshot between those operations.
      const result = await db.exec(`
        INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at, closure_token)
        SELECT ?, ?, ?, 'authority', ?, ?, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM shared_task_events
          WHERE shared_task_id = ? AND (terminal = 1 OR kind = 'local-close' OR session_id <> ?
            OR revision >= ? OR (snapshot IS NOT NULL AND (
              json_extract(snapshot, '$.ownerAccountId') <> ?
              OR json_extract(snapshot, '$.hostDeviceId') <> ?
            )))
        )
        ON CONFLICT (shared_task_id, kind, revision) DO NOTHING
      `, [snapshot.sharedTaskId, snapshot.sessionId, snapshot.revision, snapshot.status === 'closed' ? 1 : 0,
        JSON.stringify(snapshot), now(), snapshot.sharedTaskId, snapshot.sessionId, snapshot.revision,
        snapshot.ownerAccountId, snapshot.hostDeviceId]);
      if (result.changes > 0) return true;
      const rows = await db.query<SharedTaskJournalRow>(
        'SELECT session_id, kind, revision, terminal, snapshot FROM shared_task_events WHERE shared_task_id = ?',
        [snapshot.sharedTaskId],
      );
      return classifyAuthorityWrite(rows, snapshot);
    },
    async close(identity: SharedTaskIdentity): Promise<void> {
      // Revision zero is reserved for a local closure, not a server revision.
      // Never manufacture a higher authority revision from the local clock.
      const checked = parseSharedTaskSnapshot({ ...identity, revision: 1, status: 'closed', guests: [] });
      // Keep immutable identity checks in this statement too. A pre-read can
      // become stale while another worker records a different authority.
      const result = await db.exec(`
        INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at, closure_token)
        SELECT ?, ?, 0, 'local-close', 1, NULL, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM shared_task_events
          WHERE shared_task_id = ? AND (session_id <> ? OR (snapshot IS NOT NULL AND (
            COALESCE(json_extract(snapshot, '$.ownerAccountId'), '') <> ?
            OR COALESCE(json_extract(snapshot, '$.hostDeviceId'), '') <> ?
          )))
        )
        ON CONFLICT (shared_task_id, kind, revision) DO UPDATE SET
          terminal = 1,
          recorded_at = excluded.recorded_at
      `, [checked.sharedTaskId, checked.sessionId, now(), checked.sharedTaskId, checked.sessionId,
        checked.ownerAccountId, checked.hostDeviceId]);
      if (result.changes > 0) return;
      const rows = await db.query<SharedTaskJournalRow>(
        'SELECT session_id, kind, revision, terminal, snapshot FROM shared_task_events WHERE shared_task_id = ?',
        [checked.sharedTaskId],
      );
      assertAuthorityRowsCompatible(rows, { ...checked, revision: 1, status: 'closed', guests: [] });
      throw new SharedTaskJournalConflictError('SharedTask closure write was rejected');
    },
    async latest(): Promise<SharedTaskJournalEntry[]> {
      const rows = await db.query<{ shared_task_id: string; session_id: string; terminal: number; snapshot: string | null }>(`
        SELECT shared_task_id, session_id, terminal, snapshot FROM shared_task_events
        WHERE id IN (SELECT MAX(id) FROM shared_task_events GROUP BY shared_task_id)
      `);
      return rows.map((row) => {
        const snapshot = row.snapshot === null ? null : parseSharedTaskSnapshot(JSON.parse(row.snapshot));
        if (snapshot && (snapshot.sharedTaskId !== row.shared_task_id || snapshot.sessionId !== row.session_id)) throw new Error('SharedTask journal scope mismatch');
        return { sharedTaskId: row.shared_task_id, sessionId: row.session_id, terminal: row.terminal === 1, snapshot };
      });
    },
  };
}

export type SharedTaskJournal = ReturnType<typeof createSharedTaskJournal>;
