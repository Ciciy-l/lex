import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Fixed identifiers only; all nullable legacy references are excluded from this set. */
export const RETIRED_COMPANION_SESSION_IDS_SQL = `
  SELECT id FROM sessions WHERE source = 'bot'
  UNION SELECT session_id FROM bot_session_links WHERE session_id IS NOT NULL
  UNION SELECT canonical_session_id FROM bot_profiles WHERE canonical_session_id IS NOT NULL
  UNION SELECT child_session_id FROM bot_delegations WHERE child_session_id IS NOT NULL
`;

/** Read-only tombstone: historical companion ownership must never become an ordinary task. */
export function retiredCompanionSessionSql(id: SQLWrapper): SQL<boolean> {
  return sql<boolean>`(
    EXISTS (SELECT 1 FROM sessions AS retired_session WHERE retired_session.id = ${id} AND retired_session.source = 'bot')
    OR EXISTS (SELECT 1 FROM bot_session_links AS retired_link WHERE retired_link.session_id = ${id})
    OR EXISTS (SELECT 1 FROM bot_profiles AS retired_profile WHERE retired_profile.canonical_session_id = ${id})
    OR EXISTS (SELECT 1 FROM bot_delegations AS retired_delegation WHERE retired_delegation.child_session_id = ${id})
  )`;
}
