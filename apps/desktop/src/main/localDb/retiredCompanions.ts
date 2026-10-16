export { retiredCompanionSessionSql, RETIRED_COMPANION_SESSION_IDS_SQL } from './retiredCompanionSql.js';
import { getCurrentDbClientSnapshot } from './client/current.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';

/** A bounded batch reads the current owner's retained rows; no runtime/profile service is loaded. */
export async function readRetiredCompanionSessions(ids: readonly string[]): Promise<ReadonlySet<string>> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner || isAppSessionBoundaryPending()) throwIpcError('NOT_FOUND', 'Session does not exist');
  const retired = new Set<string>();
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 200) {
    const chunk = unique.slice(offset, offset + 200);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await owner.client.query<{ id: string }>(`
      SELECT id FROM sessions WHERE id IN (${placeholders}) AND source = 'bot'
      UNION SELECT session_id AS id FROM bot_session_links WHERE session_id IN (${placeholders})
      UNION SELECT canonical_session_id AS id FROM bot_profiles WHERE canonical_session_id IN (${placeholders})
      UNION SELECT child_session_id AS id FROM bot_delegations WHERE child_session_id IN (${placeholders})
    `, [...chunk, ...chunk, ...chunk, ...chunk]);
    if (getCurrentDbClientSnapshot() !== owner || isAppSessionBoundaryPending()) throwIpcError('NOT_FOUND', 'Session does not exist');
    for (const row of rows) retired.add(row.id);
  }
  return retired;
}

/** Use before restore/start/send, including internal recovery and direct-ID callers. */
export async function assertNotRetiredCompanionSession(sessionId: string, source?: unknown): Promise<void> {
  if (source === 'bot' || (await readRetiredCompanionSessions([sessionId])).has(sessionId)) {
    throwIpcError('NOT_FOUND', 'Session does not exist');
  }
}
