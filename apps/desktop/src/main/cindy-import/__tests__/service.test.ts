import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DB_TRANSPORT_OUTCOME_UNKNOWN } from '../../localDb/client/DbTransport';

const state = vi.hoisted(() => ({ scope: 'owner-a:1', root: '', lex: '', outcomes: [] as unknown[], afterCommit: null as (() => void) | null, stopped: true }));
const dbClient = vi.hoisted(() => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null), drizzle: {} }));
const commit = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: (key: string) => key === 'userData' ? state.lex : state.root } }));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => state.scope, isAppSessionBoundaryPending: () => false }));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => dbClient, tryGetDbClient: () => dbClient }));
vi.mock('../../localDb/dialogueWorkspace', () => ({ buildDialogueWorkspaceDir: (id: string) => path.join(state.lex, 'dialogues', id) }));
vi.mock('../../cindy-media/refCompensationJournal', () => ({ captureMediaRefCompensationScope: () => ({ assertStillValid: () => undefined }) }));
vi.mock('../../session-share/sessionShareExport', () => ({
  resolveMediaFile: () => null,
  exportSessionShare: async (opts: { targetPath: string }) => {
    await fs.writeFile(opts.targetPath, 'synthetic bundle');
    return { status: 'ok', filePath: opts.targetPath, fidelity: 'full', mediaMissing: 0, mediaDropped: 0 };
  },
}));
vi.mock('../../session-share/sessionShareImport', () => ({ inspectShareFile: async () => ({ draftId: 'draft' }), cancelShareDraft: () => undefined, commitShareImport: commit }));
vi.mock('../discovery', async (original) => ({ ...await original<typeof import('../discovery')>(), assertSourceStopped: async () => { if (!state.stopped) throw Object.assign(new Error('sourceRunning'), { code: 'sourceRunning' }); } }));
import { CindyImportService } from '../service';
let service: CindyImportService;
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lex-cindy-service-test-')));
  state.root = root; state.lex = path.join(root, 'Lex'); state.scope = 'owner-a:1'; state.outcomes = []; state.afterCommit = null; state.stopped = true;
  await fs.mkdir(state.lex);
  const cindy = path.join(root, 'Cindy'); await fs.mkdir(cindy);
  const db = new Database(path.join(cindy, 'cindy-local-v1.db'));
  db.exec('CREATE TABLE sessions(id TEXT,title TEXT,source TEXT,status TEXT,agent_kind TEXT,working_dir TEXT,workspace_kind TEXT,created_at INTEGER,updated_at INTEGER,remote_host_id TEXT,cleared_at INTEGER,orca_role TEXT); CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,content TEXT,created_at INTEGER)');
  for (const id of ['one', 'two', 'three']) db.prepare("INSERT INTO sessions VALUES (?,?,'desktop','archived','cc',NULL,'dialogue',1,2,NULL,NULL,NULL)").run(id, id);
  db.close();
  dbClient.query.mockReset().mockResolvedValue([]); dbClient.queryOne.mockReset().mockResolvedValue(null);
  commit.mockReset().mockImplementation(async (_opts, scope) => {
    scope.assertStillValid(); await scope.localCopy.beforeCommit();
    const outcome = state.outcomes.shift(); if (outcome instanceof Error) throw outcome;
    state.afterCommit?.();
    return { sessionId: scope.localCopy.sessionId, fidelity: 'full' };
  });
  service = new CindyImportService();
});
afterEach(async () => { await service.cancel(); await fs.rm(root, { recursive: true, force: true }); });
async function prepare() {
  const sources = await service.run(() => service.discover());
  const scan = await service.run(() => service.scan(sources[0].id));
  return service.run(() => service.preview(scan.scanId, scan.candidates.map((c) => c.id)));
}
async function directories() { return fs.readdir(path.join(state.lex, 'dialogues')).catch(() => []); }
it('keeps earlier successes and cleans only a deterministically failed item in a batch', async () => {
  const preview = await prepare();
  state.outcomes = [null, new Error('failure'), null];
  const result = await service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }));
  expect(result.map((r) => r.status)).toEqual(['imported', 'failed', 'imported']);
  expect(await directories()).toHaveLength(2);
});
it('cancellation preserves the committed item, reports remaining items, and cannot consume the preview again', async () => {
  const preview = await prepare();
  state.afterCommit = () => { void service.cancel(); };
  const result = await service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }));
  expect(result.map((r) => r.status)).toEqual(['imported', 'canceled', 'canceled']); expect(await directories()).toHaveLength(1);
  await expect(service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }))).rejects.toMatchObject({ code: 'canceled' });
});
it('rejects an A → B → A owner generation change before any publish', async () => {
  const preview = await prepare(); state.scope = 'owner-a:3';
  await expect(service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }))).rejects.toMatchObject({ code: 'ownerChanged' });
  expect(commit).not.toHaveBeenCalled(); expect(await directories()).toHaveLength(0);
});
it('preserves files when the final DB transaction acknowledgement is unknown', async () => {
  const preview = await prepare(); state.outcomes = [Object.assign(new Error('lost ACK'), { code: DB_TRANSPORT_OUTCOME_UNKNOWN }), null, null];
  const result = await service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }));
  expect(result[0].status).toBe('failed'); expect(await directories()).toHaveLength(3);
});
it('refuses a source restarted after preview', async () => {
  const preview = await prepare(); state.stopped = false;
  await expect(service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }))).rejects.toMatchObject({ code: 'sourceRunning' });
  expect(commit).not.toHaveBeenCalled();
});
it('skips already imported tasks without creating filesystem copies', async () => {
  const preview = await prepare(); dbClient.queryOne.mockResolvedValue({ session_id: 'existing' } as never);
  const result = await service.run(() => service.commit({ previewId: preview.previewId, allowIncomplete: false, preferences: {} }));
  expect(result.every((r) => r.status === 'skipped')).toBe(true); expect(commit).not.toHaveBeenCalled(); expect(await directories()).toHaveLength(0);
});
