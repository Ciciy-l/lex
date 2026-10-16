import { RETIRED_COMPANION_SESSION_IDS_SQL } from './retiredCompanionSql.js';
import type Database from 'better-sqlite3';

export function persistSessionPermission(
  db: Database.Database,
  args: unknown,
): { updated: boolean } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('Invalid args'), {code: 'INVALID_PARAMS'});
  const p = args as Record<string, unknown>;
  if (typeof p.sessionId !== 'string' || !p.sessionId || typeof p.mode !== 'string') throw Object.assign(new Error('Invalid session or mode'), {code: 'INVALID_PARAMS'});
  const sessionId = p.sessionId;
  const mode = p.mode;
  if (!['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(mode)) {
    throw Object.assign(new Error('invalid permission mode'), { code: 'INVALID_PARAMS' });
  }
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE sessions SET permission_mode = ?, updated_at = ?
      WHERE id = ? AND id NOT IN (${RETIRED_COMPANION_SESSION_IDS_SQL})`)
      .run(mode, Date.now(), sessionId);
    return { updated: changed.changes === 1 };
  })();
}
