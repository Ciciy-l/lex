import { and, not, sql } from 'drizzle-orm';
import { schedules, scheduleRuns } from '../localDb/schema.js';
import { retiredCompanionSessionSql } from '../localDb/retiredCompanionSql.js';

/** Retained routine history must never be adopted by the ordinary scheduler. */
export function publicScheduleWhere() {
  return and(
    sql`coalesce(${schedules.source}, '') != 'bot'`,
    not(retiredCompanionSessionSql(schedules.targetSessionId)),
    not(retiredCompanionSessionSql(schedules.skipLogSessionId)),
    // A legacy schedule may have lost its target but retain a companion run.
    // Fence its parent too: deleting the schedule would cascade into that history.
    sql`NOT EXISTS (SELECT 1 FROM schedule_runs AS retained_run
      WHERE retained_run.schedule_id = ${schedules.id}
        AND ${retiredCompanionSessionSql(sql`retained_run.session_id`)})`,
  )!;
}

export function publicScheduleRunWhere() {
  return and(
    sql`${scheduleRuns.scheduleId} IN (SELECT ${schedules.id} FROM ${schedules} WHERE ${publicScheduleWhere()})`,
    not(retiredCompanionSessionSql(scheduleRuns.sessionId)),
  )!;
}
