import { and, eq, isNull, not, sql } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import { sessions } from './schema.js';
import { retiredCompanionSessionSql } from './retiredCompanions.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Shared Main clear persistence body. Native retirement supplies a CAS guard;
 * ordinary clear keeps its existing monotonic boundary and notification flow. */
export async function commitSessionContextClear(client: DbClient, sessionId: string, ts: number,
  expected?: { nativeId: string | null; clearedAt: number | null }) {
  const db = client.drizzle;
  const update = db
    .update(sessions)
    .set({
      sdkSessionId: null,
      codexPlanJson: null,
      // Concurrent /clear calls may finish their DB awaits out of order. Keep
      // both persisted boundaries monotonic so the older completion cannot
      // make pre-clear history visible again or invalidate a newer input token.
      clearedAt: sql<number>`MAX(COALESCE(${sessions.clearedAt}, 0), ${ts})`,
      updatedAt: sql<number>`MAX(COALESCE(${sessions.updatedAt}, 0), ${ts})`,
      listPreview: null,
      listPreviewRole: null,
    })
    .where(and(not(retiredCompanionSessionSql(sessions.id)), eq(sessions.id, sessionId),
      ...(expected ? [expected.nativeId === null ? isNull(sessions.sdkSessionId) : eq(sessions.sdkSessionId, expected.nativeId),
        expected.clearedAt === null ? isNull(sessions.clearedAt) : eq(sessions.clearedAt, expected.clearedAt)] : [])));
  const fields = { clearedAt: sessions.clearedAt, updatedAt: sessions.updatedAt, nativeId: sessions.sdkSessionId };
  // Native CAS must prove that this UPDATE matched, not mistake a different
  // writer's later clear for its own commit. Ordinary clear keeps its existing
  // readback of the newest monotonic boundary for device-link broadcasts.
  if (!expected) await update;
  const [updated] = expected ? await update.returning(fields)
    : await db.select(fields).from(sessions)
      .where(and(not(retiredCompanionSessionSql(sessions.id)), eq(sessions.id, sessionId))).limit(1);
  if (expected && (!updated || updated.nativeId !== null || updated.clearedAt === null || updated.clearedAt < ts))
    throwIpcError('PRECONDITION_FAILED', 'Native history clear did not commit');
  return updated;
}
