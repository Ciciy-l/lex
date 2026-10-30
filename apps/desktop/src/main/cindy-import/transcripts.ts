import { nativeMetadataIds } from '../session-share/nativeSessionMetadata.pure';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { findClaudeSessionJsonl } from '@cindy/maker-core';
import type { SessionRow, MessageRow, SessionPhaseA } from '../session-share/sessionShareExport';
import type { CodexThreadStateDump } from '../maker-host/codex-local-sessions';
import type { CindySource } from './source';
import { importError, inside, localPath, snapshotDatabase, SnapshotReader } from './snapshot';

export async function walkFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 16) throw importError('tooLarge');
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of entries) {
      if (++visited > 100000) throw importError('tooLarge');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && accept(entry.name)) files.push(file);
    }
  };
  await walk(root, 0);
  return files;
}
function safeId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
function idsFromMessages(session: SessionRow, messages: MessageRow[]): string[] {
  const ids = new Set<string>(session.sdkSessionId ? [session.sdkSessionId] : []);
  for (const message of messages) {
    if (message.agentKind && message.agentKind !== session.agentKind) continue;
    for (const id of nativeMetadataIds(message.agentMeta)) ids.add(id);
    if (message.role === 'agent_switch') for (const id of nativeMetadataIds(message.content)) ids.add(id);
  }
  return [...ids];
}
function serialize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value instanceof Uint8Array ? { __xdtshareBlobB64: Buffer.from(value).toString('base64') } : typeof value === 'bigint' ? String(value) : value])));
}
async function codexState(source: CindySource, id: string): Promise<CodexThreadStateDump> {
  const account = path.join(source.origin.root, 'codex-accounts', createHash('sha256').update(source.origin.owner).digest('hex'));
  const roots = [account, path.join(source.origin.root, 'codex-home'), path.join(os.homedir(), '.codex')];
  let rollout: string | null = null;
  let home: string | null = null;
  const location = path.join(account, 'thread-index', 'locations', id + '.json');
  const locationStat = await fs.lstat(location).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (locationStat) {
    if (locationStat.size > 65536) throw importError('unsafePath');
    const record = JSON.parse(await fs.readFile(await source.stage(account, location), 'utf8'));
    if (record.threadId !== id || typeof record.path !== 'string' || !localPath(record.path)) throw importError('unsafePath');
    rollout = record.path;
    home = typeof record.sqliteHome === 'string' ? record.sqliteHome : null;
    if (!roots.some((root) => inside(root, rollout!)) || (home && !roots.some((root) => inside(root, home!)))) throw importError('unsafePath');
    if (!home) {
      for (let dir = path.dirname(rollout!); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
        if (['sessions', 'archived_sessions'].includes(path.basename(dir))) { home = path.dirname(dir); break; }
      }
    }
  } else {
    // Exact thread identity only; never select a stale fallback when an index record exists.
    for (const root of roots.slice(1)) {
      const files = [...await walkFiles(path.join(root, 'sessions'), (name) => name.endsWith('-' + id + '.jsonl')),
        ...await walkFiles(path.join(root, 'archived_sessions'), (name) => name.endsWith('-' + id + '.jsonl'))];
      if (files.length > 1) throw importError('sourceChanged');
      if (files[0]) { rollout = files[0]; home = root; break; }
    }
  }
  const empty: CodexThreadStateDump = { threads: [], threadDynamicTools: [], threadSpawnEdges: [], rolloutPath: rollout };
  if (!home) return empty;
  const states = (await fs.readdir(home)).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.split('_')[1].split('.')[0]) - Number(a.split('_')[1].split('.')[0]));
  if (!states[0]) return empty;
  const target = path.join(source.staging, randomUUID() + '.sqlite');
  const root = roots.find((r) => inside(r, home!));
  if (!root) throw importError('unsafePath');
  await source.observeDatabase(path.join(home, states[0]));
  await snapshotDatabase(root, path.join(home, states[0]), target);
  const reader = new SnapshotReader(target);
  try {
    const tables = new Set((await reader.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name));
    const rows = async (table: string, key: string) => tables.has(table)
      ? serialize(await reader.query<Record<string, unknown>>('SELECT * FROM ' + table + ' WHERE ' + key + ' = ?', [id])) : [];
    return { threads: await rows('threads', 'id'), threadDynamicTools: await rows('thread_dynamic_tools', 'thread_id'),
      threadSpawnEdges: await rows('thread_spawn_edges', 'parent_thread_id'), rolloutPath: rollout };
  } finally { await reader.close(); }
}

export async function collectNative(source: CindySource, session: SessionRow, messages: MessageRow[], prefix: string): Promise<SessionPhaseA> {
  const result: SessionPhaseA = { session, messages, zipPrefix: prefix, sdkSessionIds: [], activeSdkSessionId: null, candidates: [], refs: [], codexState: null };
  if (session.agentKind === 'omp') { source.issues.add('historyOnly'); return result; }
  const ids = idsFromMessages(session, messages);
  if ((!session.sdkSessionId && messages.length > 0) || messages.some((m) => m.agentKind && m.agentKind !== session.agentKind)) source.issues.add('nativeMissing');
  if (session.agentKind !== 'pi') { result.sdkSessionIds = ids; result.activeSdkSessionId = session.sdkSessionId; }
  for (const id of ids) {
    source.assertStillValid();
    let file: string | null = null;
    let roots: string[] = [];
    try {
      if (session.agentKind === 'cc') {
        if (!safeId(id)) throw importError('unsafePath');
        roots = [path.join(source.origin.root, 'claude-home', 'projects'), path.join(os.homedir(), '.claude', 'projects')];
        for (const root of roots) { file = await findClaudeSessionJsonl(id, session.workingDir ?? undefined, root); if (file) break; }
      } else if (session.agentKind === 'pi') {
        roots = [path.join(source.origin.root, 'pi-agent-home', 'sessions')];
        if (localPath(id) && id.endsWith('.jsonl')) file = id;
      } else {
        if (!safeId(id)) throw importError('unsafePath');
        // A bundle has one Codex state dump; older fork ids are reported explicitly.
        if (id !== session.sdkSessionId) throw importError('nativeMissing');
        const state = await codexState(source, id);
        result.codexState = state;
        if (!state.threads.length) source.issues.add('nativeMissing');
        file = state.rolloutPath;
        roots = [path.join(source.origin.root, 'codex-home'), path.join(source.origin.root, 'codex-accounts', createHash('sha256').update(source.origin.owner).digest('hex')), path.join(os.homedir(), '.codex')];
      }
      const root = file && roots.find((r) => inside(r, file!));
      if (!file || !root || !file.endsWith('.jsonl')) throw importError('nativeMissing');
      const staged = await source.stage(root, file);
      const bytes = (await fs.stat(staged)).size;
      if (!bytes) throw importError('nativeMissing');
      const zipPath = prefix + 'transcripts/' + (session.agentKind === 'cc' ? 'claude' : session.agentKind) + '/' + id + '.jsonl';
      result.candidates.push({ sdkSessionId: id, absPath: staged, bytes, zipPath: session.agentKind === 'pi' ? '' : zipPath });
      if (session.agentKind !== 'pi') result.refs.push({ sdkSessionId: id, path: zipPath });
    } catch (error) {
      if (!['nativeMissing', 'unsafePath', 'schemaUnsupported', 'sourceUnreadable', 'ENOENT', 'EACCES', 'EPERM'].includes((error as { code?: string }).code ?? '')) throw error;
      source.issues.add('nativeMissing'); source.missingFiles.add(session.agentKind === 'pi' ? path.basename(id) : id + '.jsonl');
      if (session.agentKind !== 'pi' && safeId(id)) result.refs.push({ sdkSessionId: id, path: null });
      if (!safeId(id) && session.agentKind !== 'pi') {
        result.sdkSessionIds = result.sdkSessionIds.filter((s) => s !== id);
        if (result.activeSdkSessionId === id) result.activeSdkSessionId = null;
      }
    }
  }
  return result;
}
