import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotReader, copyStableFile, snapshotDatabase } from '../snapshot';
import { discoverSources, recognizedCindyProcess, type Source } from '../discovery';
import { CindySource } from '../source';
import { prepareAttachments, prepareWorkspace, rewriteAttachments } from '../files';

const paths = vi.hoisted(() => ({ userData: '' }));
const resolveMedia = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));
vi.mock('../../session-share/sessionShareExport', () => ({ resolveMediaFile: resolveMedia }));
let root: string, temp: string, source: Source, reader: SnapshotReader | undefined, db: Database.Database;
async function adapter() {
  const file = path.join(temp, 'snapshot-' + Math.random() + '.db');
  await snapshotDatabase(root, source.file, file);
  reader = new SnapshotReader(file);
  const instance = new CindySource(source, reader, temp, () => undefined);
  const rows = await instance.init();
  return { instance, ...rows };
}
function session(id: string, extras: Record<string, unknown> = {}) {
  const value = { id, title: '测试 ' + id, source: 'desktop', status: 'active', agent_kind: 'cc', working_dir: null, workspace_kind: 'dialogue', created_at: 1, updated_at: 10, ...extras };
  db.prepare('INSERT INTO sessions (' + Object.keys(value).join(',') + ') VALUES (' + Object.keys(value).map(() => '?').join(',') + ')').run(...Object.values(value));
}
function message(id: string, sessionId: string, content: string, at = 3, extra: Record<string, unknown> = {}) {
  const value = { id, session_id: sessionId, role: 'user', content, created_at: at, ...extra };
  db.prepare('INSERT INTO messages (' + Object.keys(value).join(',') + ') VALUES (' + Object.keys(value).map(() => '?').join(',') + ')').run(...Object.values(value));
}
beforeEach(async () => {
  resolveMedia.mockReset().mockReturnValue(null);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lex-cindy-source-test-')));
  temp = path.join(root, 'staged'); await fs.mkdir(temp);
  paths.userData = path.join(root, 'Lex'); await fs.mkdir(paths.userData);
  source = { id: 'source', label: 'Cindy', location: root, accountIndex: 1, root, file: path.join(root, 'cindy-test-owner.db'), owner: 'test-owner', key: 'source-key' };
  db = new Database(source.file);
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,source TEXT,status TEXT,agent_kind TEXT,working_dir TEXT,workspace_kind TEXT,created_at INTEGER,updated_at INTEGER,remote_host_id TEXT,cleared_at INTEGER,orca_role TEXT,sdk_session_id TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER, rewind_at INTEGER, agent_meta TEXT, agent_kind TEXT)');
});
afterEach(async () => { await reader?.close(); reader = undefined; db.close(); await fs.rm(root, { recursive: true, force: true }); });

describe('Cindy read-only source', () => {
  it('copies committed WAL rows without opening/checkpointing the source', async () => {
    db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
    session('wal'); message('m', 'wal', 'only in WAL');
    const names = [source.file, source.file + '-wal', source.file + '-shm'];
    const before = await Promise.all(names.map((file) => fs.readFile(file)));
    const { instance, rows } = await adapter();
    expect(rows.map((r) => r.id)).toEqual(['wal']);
    expect((await instance.readMessages('wal', null))[0].content).toBe('only in WAL');
    expect(await Promise.all(names.map((file) => fs.readFile(file)))).toEqual(before);
  });
  it('filters all retired ownership branches, deleted/remote sessions and standalone Workers', async () => {
    db.exec('CREATE TABLE bot_session_links(session_id TEXT); CREATE TABLE bot_profiles(canonical_session_id TEXT); CREATE TABLE bot_delegations(child_session_id TEXT)');
    session('bot', { source: 'bot' }); session('link'); session('profile'); session('delegation');
    db.exec("INSERT INTO bot_session_links VALUES ('link'); INSERT INTO bot_profiles VALUES ('profile'); INSERT INTO bot_delegations VALUES ('delegation')");
    session('deleted', { status: 'deleted' }); session('remote', { remote_host_id: 'ssh' }); session('worker', { orca_role: 'worker' }); session('unsupported', { agent_kind: 'unknown' }); session('archived', { status: 'archived' });
    const { rows, excluded } = await adapter();
    expect(rows.map((r) => r.id)).toEqual(['archived']); expect(excluded).toBe(8);
  });
  it('preserves clear/rewind boundaries and supplies stable client IDs for older schemas', async () => {
    session('clear', { cleared_at: 5 }); message('before', 'clear', 'hidden', 4); message('after', 'clear', 'kept', 6, { rewind_at: 9 });
    const { instance } = await adapter();
    expect(await instance.readMessages('clear', 5)).toMatchObject([{ id: 'after', clientId: 'after', rewindAt: 9 }]);
  });
  it('rejects unknown schemas rather than guessing ownership or clear boundaries', async () => {
    db.exec('ALTER TABLE sessions DROP COLUMN cleared_at');
    await expect(adapter()).rejects.toMatchObject({ code: 'schemaUnsupported' });
  });
  it('chooses the latest active team without mutating old teams and retains archived Workers', async () => {
    db.exec('CREATE TABLE orca_teams(id TEXT,lead_session_id TEXT,status TEXT,updated_at INTEGER,created_at INTEGER); CREATE TABLE orca_workers(id TEXT,team_id TEXT,session_id TEXT,status TEXT,label TEXT,role TEXT,focused INTEGER,created_at INTEGER)');
    session('lead', { orca_role: 'lead' }); session('worker', { orca_role: 'worker', status: 'archived' });
    db.exec("INSERT INTO orca_teams VALUES ('old','lead','active',1,1),('new','lead','active',2,2); INSERT INTO orca_workers VALUES ('w','new','worker','idle','测试','developer',1,3)");
    const { instance } = await adapter();
    expect((await instance.readWorkers('lead'))?.workers[0].session.status).toBe('archived');
    expect(db.prepare("SELECT count(*) AS n FROM orca_teams WHERE status='active'").get()).toEqual({ n: 2 });
  });
  it('rejects symlink escapes, including an ancestor directory swapped for a symlink', async () => {
    const outside = path.join(temp, 'outside.txt'); await fs.writeFile(outside, 'private');
    const allowed = path.join(root, 'allowed'); await fs.mkdir(allowed);
    await fs.symlink(outside, path.join(allowed, 'escape'));
    await expect(copyStableFile(allowed, path.join(allowed, 'escape'), path.join(temp, 'copy'))).rejects.toMatchObject({ code: 'unsafePath' });
    await fs.symlink(temp, path.join(allowed, 'dir'));
    await expect(copyStableFile(allowed, path.join(allowed, 'dir', 'outside.txt'), path.join(temp, 'copy2'))).rejects.toMatchObject({ code: 'unsafePath' });
  });
  it('discovers account databases only, excludes Lex, backups and linked databases, and distinguishes roots', async () => {
    await fs.writeFile(path.join(root, 'cindy-test-owner.backup.db'), '');
    await fs.symlink(source.file, path.join(root, 'cindy-linked.db'));
    await fs.writeFile(path.join(paths.userData, 'cindy-test-owner.db'), '');
    const other = path.join(root, 'CindyGlobal'); await fs.mkdir(other); await fs.copyFile(source.file, path.join(other, path.basename(source.file)));
    const found = await discoverSources([root, paths.userData, other], paths.userData);
    expect(found).toHaveLength(2); expect(found[0].key).not.toBe(found[1].key);
  });
  it('recognizes Cindy executable names without inspecting command-line arguments', async () => {
    expect(recognizedCindyProcess('/Applications/Cindy.app/Contents/MacOS/Cindy')).toBe(true);
    expect(recognizedCindyProcess('CindyGlobal')).toBe(true);
    expect(recognizedCindyProcess('xdt-maker.exe')).toBe(true);
    expect(recognizedCindyProcess('/usr/bin/node --user-data-dir=/Cindy --token=secret')).toBe(false);
    expect.assertions(4);
  });
  it('copies only structured attachments and creates a private copy of managed workspaces', async () => {
    const cwd = path.join(root, 'dialogues', '中文'); await fs.mkdir(cwd, { recursive: true });
    const file = path.join(cwd, '报告.pdf'); await fs.writeFile(file, 'PDF bytes');
    session('s', { working_dir: cwd });
    message('m', 's', JSON.stringify({ text: path.join(root, 'auth.json'), files: [{ name: '报告.pdf', path: file }, { name: 'auth.json', path: path.join(root, 'auth.json') }] }));
    await fs.writeFile(path.join(root, 'auth.json'), 'never copy');
    const { instance, rows } = await adapter();
    const attachments = await prepareAttachments(instance, rows);
    expect(await fs.readFile(attachments[0].staged!, 'utf8')).toBe('PDF bytes'); expect(attachments[1].staged).toBeNull();
    expect(instance.issues.has('attachmentMissing')).toBe(true);
    const workspace = await prepareWorkspace(instance, rows[0]);
    expect(await fs.readFile(path.join(workspace.staged!, '报告.pdf'), 'utf8')).toBe('PDF bytes');
    const rewritten = JSON.parse(rewriteAttachments((await instance.readMessages('s', null))[0].content, new Map([[file, '/new/file'], [path.join(root, 'auth.json'), '']])));
    expect(rewritten.text).toBe(path.join(root, 'auth.json')); expect(rewritten.files[1].path).toBe('');
  });
  it('stages Pi history independently and rejects arbitrary absolute session files', async () => {
    const piDir = path.join(root, 'pi-agent-home', 'sessions'); await fs.mkdir(piDir, { recursive: true });
    const file = path.join(piDir, 'history.jsonl'); await fs.writeFile(file, '{"type":"session","id":"p"}\n');
    session('pi', { agent_kind: 'pi', sdk_session_id: file });
    const { instance, rows } = await adapter();
    const phase = await instance.collectNative(rows[0], [], '');
    expect(phase.candidates[0].sdkSessionId).toBe(file); expect(phase.candidates[0].absPath).not.toBe(file);
    const bad = await instance.collectNative({ ...rows[0], sdkSessionId: source.file }, [], '');
    expect(bad.candidates).toEqual([]); expect(instance.issues.has('nativeMissing')).toBe(true);
  });
  it('reads Codex account locations and copied SQLite state, preserving blobs', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const account = path.join(root, 'codex-accounts', createHash('sha256').update(source.owner).digest('hex'));
    const home = path.join(account, 'provider'); const history = path.join(home, 'sessions'); const index = path.join(account, 'thread-index', 'locations');
    await fs.mkdir(history, { recursive: true }); await fs.mkdir(index, { recursive: true });
    const rollout = path.join(history, 'rollout-' + id + '.jsonl'); await fs.writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
    await fs.writeFile(path.join(index, id + '.json'), JSON.stringify({ threadId: id, path: rollout, sqliteHome: home }));
    const state = new Database(path.join(home, 'state_5.sqlite')); state.exec('CREATE TABLE threads(id TEXT, payload BLOB)'); state.prepare('INSERT INTO threads VALUES (?,?)').run(id, Buffer.from('state')); state.close();
    session('codex', { agent_kind: 'codex', sdk_session_id: id });
    const { instance, rows } = await adapter();
    const phase = await instance.collectNative(rows[0], [], '');
    expect(phase.codexState?.threads[0]).toEqual({ id, payload: { __xdtshareBlobB64: Buffer.from('state').toString('base64') } });
    expect(phase.candidates).toHaveLength(1); expect(instance.issues.size).toBe(0);
  });
  it('detects source transcript changes after staging', async () => {
    const file = path.join(root, 'history.jsonl'); await fs.writeFile(file, 'one');
    const { instance } = await adapter(); await instance.stage(root, file); await fs.writeFile(file, 'changed');
    await expect(instance.assertFilesUnchanged()).rejects.toMatchObject({ code: 'sourceChanged' });
  });
  it('resolves managed media from Cindy rather than a same-named Lex file', async () => {
    const parts = ['cc-agent', 'feishu-media', 'images', 'shared.png'];
    const original = path.join(root, ...parts);
    const lexFile = path.join(paths.userData, ...parts);
    await fs.mkdir(path.dirname(original), { recursive: true }); await fs.writeFile(original, 'Cindy bytes');
    await fs.mkdir(path.dirname(lexFile), { recursive: true }); await fs.writeFile(lexFile, 'Lex bytes');
    const url = 'xdt-image://feishu-media-images/shared.png';
    resolveMedia.mockReturnValue({ entry: { url, scheme: 'xdt-image', kind: 'image', zipPath: null, imageHost: 'feishu-media-images', filename: 'shared.png' }, absPath: lexFile, folder: 'images' });
    const { instance } = await adapter();
    const media = await instance.resolveMedia('xdt-image', url);
    expect(await fs.readFile(media!.absPath!, 'utf8')).toBe('Cindy bytes');
    await fs.rm(original);
    const missing = await instance.resolveMedia('xdt-image', url);
    expect(missing?.absPath).toBeNull(); expect(instance.issues.has('mediaMissing')).toBe(true);
    expect(await fs.readFile(lexFile, 'utf8')).toBe('Lex bytes');
  });
  it('detects changes to copied workspace files after preview', async () => {
    const cwd = path.join(root, 'dialogues', 'owned'); await fs.mkdir(cwd, { recursive: true });
    const file = path.join(cwd, 'result.txt'); await fs.writeFile(file, 'before');
    session('workspace', { working_dir: cwd });
    const { instance, rows } = await adapter();
    await prepareWorkspace(instance, rows[0]);
    await fs.writeFile(file, 'after preview');
    await expect(instance.assertFilesUnchanged()).rejects.toMatchObject({ code: 'sourceChanged' });
  });
  it('includes managed workspaces in the aggregate staging budget', async () => {
    const cwd = path.join(root, 'dialogues', 'owned'); await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, 'result.txt'), 'bytes'); session('workspace', { working_dir: cwd });
    const { instance, rows } = await adapter();
    instance.reserveStaging(8 * 1024 ** 3);
    await expect(prepareWorkspace(instance, rows[0])).rejects.toMatchObject({ code: 'tooLarge' });
  });
  it('requires a new project directory when an external alias points into source data', async () => {
    const alias = root + '-alias';
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      session('project', { working_dir: alias, workspace_kind: 'project' });
      const { instance, rows } = await adapter();
      expect(await prepareWorkspace(instance, rows[0])).toMatchObject({ project: null, needsDirectory: true });
    } finally { await fs.rm(alias, { force: true }); }
  });
  it('detects newly created WAL state after observing a native database', async () => {
    const { instance } = await adapter();
    await instance.observeDatabase(source.file);
    await fs.writeFile(source.file + '-wal', 'synthetic changed sidecar');
    await expect(instance.assertFilesUnchanged()).rejects.toMatchObject({ code: 'sourceChanged' });
    await fs.rm(source.file + '-wal', { force: true });
  });
  it('fails pending and subsequent queries when the snapshot worker closes', async () => {
    await adapter(); await reader!.close();
    await expect(reader!.query('SELECT 1')).rejects.toMatchObject({ code: 'sourceUnreadable' });
  });
});
