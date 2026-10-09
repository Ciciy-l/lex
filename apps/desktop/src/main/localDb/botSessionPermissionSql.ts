import type Database from 'better-sqlite3';

export function botsPersistSessionPermission(
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
  const profilePermission = mode === 'bypassPermissions' ? 'trusted' : mode === 'auto' ? 'auto' : mode === 'ask' ? 'ask' : null;
  return db.transaction(() => {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return { updated: false };
    if (!profilePermission) {
      db.prepare('UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?')
        .run(mode, Date.now(), sessionId);
      return { updated: true };
    }
    const link = db.prepare(`SELECT bot_id AS botId FROM bot_session_links
      WHERE session_id = ? AND role = 'canonical' AND archived_at IS NULL`).get(sessionId) as { botId: string } | undefined;
    if (link) {
      const profile = db.prepare('SELECT current_version AS version FROM bot_profiles WHERE id = ?')
        .get(link.botId) as { version: number } | undefined;
      const version = profile
        ? db.prepare('SELECT capabilities_json AS json FROM bot_profile_versions WHERE bot_id = ? AND version = ?')
          .get(link.botId, profile.version) as { json: string } | undefined
        : undefined;
      if (!profile || !version) {
        throw Object.assign(new Error('Bot profile version missing'), { code: 'PRECONDITION_FAILED' });
      }
      let config: Record<string, unknown>;
      try {
        const parsed = JSON.parse(version.json) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unreadable');
        config = parsed as Record<string, unknown>;
      } catch {
        throw Object.assign(new Error('Bot profile capabilities are unreadable'), { code: 'PRECONDITION_FAILED' });
      }
      if (config.permissions !== profilePermission) {
        const next = JSON.stringify({ ...config, permissions: profilePermission });
        const changed = db.prepare(`UPDATE bot_profile_versions SET capabilities_json = ?
          WHERE bot_id = ? AND version = ? AND capabilities_json = ?`).run(next, link.botId, profile.version, version.json);
        if (changed.changes !== 1) {
          throw Object.assign(new Error('Bot profile changed while saving permission'), { code: 'PRECONDITION_FAILED' });
        }
      }
    }
    db.prepare('UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?')
      .run(mode, Date.now(), sessionId);
    return { updated: true };
  })();
}

