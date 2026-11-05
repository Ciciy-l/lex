import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';

import type { OrcaContextAuditEvent } from '../../shared/orcaContextPolicy.js';
import type { OrcaContextOwnerScope } from '../maker-ipc/orcaContextOwner.js';
import { getDbClient } from './client/current.js';
import { orcaContextEvents } from './schema.js';

export interface OrcaContextAuditRecord extends OrcaContextAuditEvent {
  id: string;
  createdAt: number;
}

/**
 * Best-effort, content-free audit; callers must not let a write failure change
 * dispatch. When an owner scope is supplied, the event is written to that
 * captured DB only while the same owner/generation is still current. An owner
 * switch skips the write entirely: a best-effort audit must never leak owner A
 * identifiers into owner B's database.
 */
export async function recordOrcaContextEvent(
  event: OrcaContextAuditEvent,
  owner?: OrcaContextOwnerScope | null,
  now = Date.now(),
): Promise<OrcaContextAuditRecord | null> {
  let db: ReturnType<typeof getDbClient>['drizzle'];
  if (owner) {
    try {
      owner.assertCurrent();
    } catch {
      return null;
    }
    db = owner.client.drizzle;
  } else {
    db = getDbClient().drizzle;
  }
  const row = {
    id: createId(),
    leadSessionId: event.leadSessionId,
    workerId: event.workerId,
    workerSessionId: event.workerSessionId,
    policy: event.policy as 'clear' | 'compact',
    outcome: event.outcome,
    reason: event.reason ?? null,
    createdAt: now,
  };
  await db.insert(orcaContextEvents).values(row);
  return { ...event, id: row.id, createdAt: now };
}

export async function listOrcaContextEvents(
  workerId: string,
  limit = 20,
): Promise<OrcaContextAuditRecord[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(orcaContextEvents)
    .where(eq(orcaContextEvents.workerId, workerId))
    .orderBy(desc(orcaContextEvents.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => ({
    id: row.id,
    leadSessionId: row.leadSessionId,
    workerId: row.workerId,
    workerSessionId: row.workerSessionId,
    policy: row.policy,
    outcome: row.outcome,
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.createdAt,
  }));
}
