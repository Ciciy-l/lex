import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { SessionShareSource, SessionRow, MessageRow, OrcaWorkerSource } from '../session-share/sessionShareExport';
import { resolveMediaFile } from '../session-share/sessionShareExport';
import type { MediaScheme } from '../session-share/mediaUrlRewrite.pure';
import { copyStableFile, importError, inside, SnapshotReader } from './snapshot';
import type { Source } from './discovery';
import { databaseStamp } from './discovery';
import { collectNative } from './transcripts';

const SESSION_FIELDS = 'id title workingDir workspaceKind model effort permissionMode status sdkSessionId totalTokenUsage totalCostUsd contextTokens contextWindow fastMode planModeEnabled agentKind orcaRole remoteHostId codexHistoryHasProductPrompt clearedAt userSendAt createdAt updatedAt'.split(' ');
const MESSAGE_FIELDS = 'id clientId role content toolUseId agentMeta agentKind createdAt rewindAt'.split(' ');
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
export const SUPPORTED_ENGINES = new Set(['cc', 'codex', 'pi', 'omp']);

/** Fixed schema capability discovery; no migrations, globals or source-side SQLite opens. */
export class CindySource implements SessionShareSource {
  private static readonly MAX_STAGED_BYTES = 8 * 1024 ** 3;
  private static readonly MAX_CACHED_MESSAGE_BYTES = 256 * 1024 ** 2;
  readonly mediaRoots: string[];
  readonly issues = new Set<string>();
  private stagedBytes = 0;
  private frozen = new Map<string, string>();
  private databases = new Map<string, string>();
  observeFile = (file: string, stat: Stats): void => {
    const stamp = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isDirectory()]);
    if (this.frozen.has(file) && this.frozen.get(file) !== stamp) throw importError('sourceChanged');
    this.frozen.set(file, stamp);
  };
  async observeDatabase(file: string): Promise<void> {
    const stamp = await databaseStamp(file);
    if (this.databases.has(file) && this.databases.get(file) !== stamp) throw importError('sourceChanged');
    this.databases.set(file, stamp);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = await fs.lstat(file + suffix).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat) this.reserveStaging(stat.size);
    }
  }
  async assertFilesUnchanged(): Promise<void> {
    for (const [file, stamp] of this.frozen) {
      this.assertStillValid();
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat || (!stat.isFile() && !stat.isDirectory()) || JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isDirectory()]) !== stamp) throw importError('sourceChanged');
    }
    for (const [file, stamp] of this.databases) {
      this.assertStillValid();
      if (await databaseStamp(file) !== stamp) throw importError('sourceChanged');
    }
  }
  readonly missingFiles = new Set<string>();
  private columns = new Map<string, Set<string>>();
  private sessions = new Map<string, SessionRow>();
  private messages = new Map<string, MessageRow[]>();
  private cachedMessageBytes = 0;
  private retired = new Set<string>();
  constructor(readonly origin: Source, readonly reader: SnapshotReader, readonly staging: string,
    readonly assertStillValid: () => void) { this.mediaRoots = [staging]; }

  async init(): Promise<{ rows: SessionRow[]; excluded: number }> {
    for (const table of ['sessions', 'messages', 'bot_session_links', 'bot_profiles', 'bot_delegations', 'orca_teams', 'orca_workers']) {
      const cols = await this.reader.query<{ name: string }>('PRAGMA table_info(' + table + ')');
      this.columns.set(table, new Set(cols.map((c) => c.name)));
    }
    this.require('sessions', ['id', 'title', 'source', 'status', 'agent_kind', 'working_dir', 'workspace_kind', 'created_at', 'updated_at', 'remote_host_id', 'cleared_at', 'orca_role']);
    this.require('messages', ['id', 'session_id', 'role', 'content', 'created_at']);
    for (const [table, field] of [['bot_session_links', 'session_id'], ['bot_profiles', 'canonical_session_id'], ['bot_delegations', 'child_session_id']]) {
      if (!this.columns.get(table)?.size) continue;
      this.require(table, [field]);
      for (const row of await this.reader.query<{ id: string }>('SELECT ' + field + ' AS id FROM ' + table)) this.retired.add(row.id);
    }
    const rows = await this.reader.query<SessionRow & { source: string }>('SELECT ' + this.projection('sessions', SESSION_FIELDS) + ', source FROM sessions ORDER BY updated_at DESC LIMIT 10001');
    if (rows.length > 10000) throw importError('tooLarge');
    for (const row of rows) {
      if (row.source === 'bot') this.retired.add(row.id);
      if (!this.retired.has(row.id) && row.status !== 'deleted' && !row.remoteHostId && SUPPORTED_ENGINES.has(row.agentKind)) this.sessions.set(row.id, row);
    }
    const candidates = [...this.sessions.values()].filter((row) => row.orcaRole !== 'worker');
    return { rows: candidates, excluded: rows.length - candidates.length };
  }
  private require(table: string, fields: string[]) {
    if (fields.some((field) => !this.columns.get(table)?.has(field))) throw importError('schemaUnsupported');
  }
  private projection(table: string, fields: string[]): string {
    return fields.map((field) => (this.columns.get(table)?.has(snake(field)) ? snake(field) : 'NULL') + ' AS ' + field).join(', ');
  }
  async readSession(id: string): Promise<SessionRow | null> { this.assertStillValid(); return this.sessions.get(id) ?? null; }
  async readMessages(id: string, clearedAt: number | null): Promise<MessageRow[]> {
    this.assertStillValid();
    if (!this.sessions.has(id)) throw importError('sourceChanged');
    if (this.messages.has(id)) return this.messages.get(id)!;
    const where = ' WHERE session_id = ?' + (clearedAt == null ? '' : ' AND created_at > ?');
    const params = clearedAt == null ? [id] : [id, clearedAt];
    const metadataBytes = this.columns.get('messages')?.has('agent_meta') ? ' + coalesce(length(CAST(agent_meta AS BLOB)), 0)' : '';
    const [size] = await this.reader.query<{ bytes: number; count: number }>('SELECT sum(coalesce(length(CAST(content AS BLOB)), 0)' + metadataBytes + ') AS bytes, count(*) AS count FROM messages' + where, params);
    const bytes = Number(size?.bytes ?? 0);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > 128 * 1024 * 1024 || (size?.count ?? 0) > 100000 || this.cachedMessageBytes + bytes > CindySource.MAX_CACHED_MESSAGE_BYTES) throw importError('tooLarge');
    const rows = await this.reader.query<MessageRow>('SELECT ' + this.projection('messages', MESSAGE_FIELDS) + ' FROM messages' + where + ' ORDER BY created_at, id', params);
    for (const row of rows) if (!row.clientId) row.clientId = row.id;
    this.messages.set(id, rows);
    this.cachedMessageBytes += bytes;
    return rows;
  }
  async readWorkers(id: string): Promise<{ teamStatus: 'active'; workers: OrcaWorkerSource[] } | null> {
    this.assertStillValid();
    this.require('orca_teams', ['id', 'lead_session_id', 'status', 'updated_at', 'created_at']);
    this.require('orca_workers', ['id', 'team_id', 'session_id', 'status', 'label', 'role', 'focused', 'created_at']);
    // Same authoritative ordering as getActiveTeamByLead, without its write-time stale-team repair.
    const [team] = await this.reader.query<{ id: string; status: 'active' }>("SELECT id, status FROM orca_teams WHERE lead_session_id = ? AND status = 'active' ORDER BY updated_at DESC, created_at DESC LIMIT 1", [id]);
    if (!team) return null;
    const records = await this.reader.query<OrcaWorkerSource['record'] & { sessionId: string }>('SELECT session_id AS sessionId, status, label, role, focused FROM orca_workers WHERE team_id = ? ORDER BY created_at, id', [team.id]);
    const workers: OrcaWorkerSource[] = [];
    const seen = new Set<string>([id]);
    for (const record of records) {
      const session = await this.readSession(record.sessionId);
      if (!session || session.orcaRole !== 'worker' || seen.has(session.id)) throw importError('teamIncomplete');
      seen.add(session.id);
      workers.push({ record, session, messages: await this.readMessages(session.id, session.clearedAt) });
    }
    return { teamStatus: team.status, workers };
  }
  collectNative(session: SessionRow, messages: MessageRow[], prefix: string) {
    return collectNative(this, session, messages, prefix);
  }
  async stage(root: string, file: string): Promise<string> {
    this.assertStillValid();
    const stat = await fs.lstat(file);
    const release = this.reserveStaging(stat.size);
    try {
      const space = await fs.statfs(this.staging);
      if (space.bavail * space.bsize < stat.size + 64 * 1024 * 1024) throw importError('diskFull');
    } catch (error) { release(); throw error; }
    const target = path.join(this.staging, randomUUID() + path.extname(file));
    try {
      await copyStableFile(root, file, target);
      this.observeFile(file, stat);
      this.assertStillValid();
      return target;
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      release();
      throw error;
    }
  }

  /** Bound aggregate temporary disk use across multi-task previews and archive staging. */
  reserveStaging(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.stagedBytes + bytes > CindySource.MAX_STAGED_BYTES) throw importError('tooLarge');
    this.stagedBytes += bytes;
    let released = false;
    return () => { if (!released) { released = true; this.stagedBytes -= bytes; } };
  }
  async resolveMedia(scheme: MediaScheme, url: string) {
    const resolved = resolveMediaFile(scheme, url);
    if (!resolved?.absPath) { this.issues.add('mediaMissing'); return resolved; }
    let file = resolved.absPath;
    if (resolved.entry.kind !== 'loose') {
      const relative = path.relative(app.getPath('userData'), file);
      if (!inside(app.getPath('userData'), file)) throw importError('unsafePath');
      file = path.join(this.origin.root, relative);
    }
    const roots = [
      ['cc-agent', 'images'], ['cc-agent', 'lizi-art-media'], ['cc-agent', 'lizi-mivo-models'],
      ['cc-agent', 'shared-media'], ['cindy-media', 'blobs'], ['cc-agent', 'feishu-media', 'images'],
      ['cc-agent', 'feishu-media', 'files'], ['cc-agent', 'lizi-confluence', 'attachments'],
      ['cc-agent', 'lizi-jira', 'attachments'],
    ].map((parts) => path.join(this.origin.root, ...parts));
    const root = roots.find((r) => inside(r, file));
    try {
      if (!root) throw importError('unsafePath');
      const stat = await fs.lstat(file);
      if (stat.size > 256 * 1024 * 1024) throw importError('tooLarge');
      return { ...resolved, absPath: await this.stage(root, file) };
    } catch (error) {
      if (['sourceChanged', 'canceled', 'ownerChanged', 'tooLarge'].includes((error as { code?: string }).code ?? '')) throw error;
      this.issues.add('mediaMissing'); this.missingFiles.add(resolved.entry.filename);
      return { ...resolved, absPath: null };
    }
  }
}
