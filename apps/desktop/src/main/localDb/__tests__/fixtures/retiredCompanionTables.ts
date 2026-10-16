/** Minimal retained ownership columns used by ordinary-session SQLite fixtures. */
export const RETAINED_COMPANION_DDL = [
  'CREATE TABLE bot_session_links (session_id TEXT)',
  'CREATE TABLE bot_profiles (canonical_session_id TEXT)',
  'CREATE TABLE bot_delegations (child_session_id TEXT)',
];
