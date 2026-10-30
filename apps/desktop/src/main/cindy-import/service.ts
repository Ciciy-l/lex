import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { createLogger } from '../logger';
import type { CindyImportCandidate, CindyImportCommit, CindyImportPreview, CindyImportResult, CindyImportScan } from '../../shared/cindyImport';
import { getDbClient, tryGetDbClient } from '../localDb/client/current';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { buildDialogueWorkspaceDir } from '../localDb/dialogueWorkspace';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal';
import { isDbTransportOutcomeUnknown } from '../localDb/client/DbTransport';
import { cancelShareDraft, commitShareImport, inspectShareFile } from '../session-share/sessionShareImport';
import { exportSessionShare, type SessionRow } from '../session-share/sessionShareExport';
import { CindySource } from './source';
import { assertSourceStopped, databaseStamp, discoverSources, OFFICIAL_ROOTS, type Source } from './discovery';
import { copyStableFile, importError, inside, localPath, snapshotDatabase, SnapshotReader } from './snapshot';
import { copyTree, prepareAttachments, prepareWorkspace, rewriteAttachments, type AttachmentCopy, type WorkspaceCopy } from './files';

interface Prepared { view: CindyImportPreview; row: SessionRow; workspaces: WorkspaceCopy[]; attachments: AttachmentCopy[]; file?: string; directory?: string; external: Map<string, string> }
const log = createLogger('cindy-import');
/** One target-owner and renderer-scoped snapshot, preview and commit lifecycle. */
export class CindyImportService {
  readonly owner = activeOwnerScopeKey();
  readonly db = getDbClient();
  private sources = new Map<string, Source>();
  private candidates = new Map<string, SessionRow>();
  private source?: Source;
  private stamp = '';
  private reader?: SnapshotReader;
  private adapter?: CindySource;
  private temp?: string;
  private scanId = '';
  private previewId = '';
  private prepared: Prepared[] = [];
  private canceled = false;
  private busy = false;
  private expires = Date.now() + 30 * 60_000;
  private timer = setTimeout(() => { void this.cancel().catch(() => log.debug('temporary import cleanup deferred')); }, 30 * 60_000);

  assertCurrent = (): void => {
    if (this.owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending() || tryGetDbClient() !== this.db) throw importError('ownerChanged');
    if (this.canceled || Date.now() > this.expires) throw importError('canceled');
  };
  async run<T>(action: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    if (this.busy) throw importError('busy');
    this.busy = true;
    try {
      const result = await action();
      if (this.owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending() || tryGetDbClient() !== this.db) throw importError('ownerChanged');
      return result;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ownerChanged') await this.dispose();
      else if (!['confirmationRequired', 'unsafePath'].includes(code)) await this.clearSnapshot();
      throw error;
    } finally { this.busy = false; if (this.canceled) await this.dispose(); }
  }
  async discover(root?: string) {
    this.assertCurrent();
    const sources = await discoverSources(root ? [root] : OFFICIAL_ROOTS.map((name) => path.join(app.getPath('appData'), name)), app.getPath('userData'));
    this.assertCurrent();
    for (const source of sources) this.sources.set(source.id, source);
    return sources.map(({ id, label, location, accountIndex }) => ({ id, label, location, accountIndex }));
  }
  private async checkSource(): Promise<void> {
    this.assertCurrent();
    if (!this.source) throw importError('sourceMissing');
    await assertSourceStopped(this.source.root);
    if (this.stamp && await databaseStamp(this.source.file) !== this.stamp) throw importError('sourceChanged');
    await this.adapter?.assertFilesUnchanged();
    this.assertCurrent();
  }
  private async existing(sourceSessionId: string): Promise<boolean> {
    const row = await this.db.queryOne('SELECT o.session_id FROM session_import_origins o JOIN sessions s ON s.id = o.session_id WHERE o.source_key = ? AND o.source_session_id = ? AND s.status != ?', [this.source!.key, sourceSessionId, 'deleted']);
    this.assertCurrent();
    return !!row;
  }
  async scan(sourceId: string): Promise<CindyImportScan> {
    const source = this.sources.get(sourceId);
    if (!source) throw importError('sourceMissing');
    await this.clearSnapshot();
    this.source = source;
    await this.checkSource();
    this.stamp = await databaseStamp(source.file);
    this.temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-cindy-import-'));
    await fs.chmod(this.temp, 0o700);
    const copy = path.join(this.temp, 'source.db');
    await snapshotDatabase(source.root, source.file, copy);
    await this.checkSource();
    this.reader = new SnapshotReader(copy);
    this.adapter = new CindySource(source, this.reader, this.temp, this.assertCurrent);
    this.adapter.reserveStaging(await directoryBytes(this.temp));
    const { rows, excluded } = await this.adapter.init();
    const existing = new Set((await this.db.query<{ sourceSessionId: string }>('SELECT o.source_session_id AS sourceSessionId FROM session_import_origins o JOIN sessions s ON s.id = o.session_id WHERE o.source_key = ? AND s.status != ?', [source.key, 'deleted'])).map((r) => r.sourceSessionId));
    const candidates: CindyImportCandidate[] = [];
    for (const row of rows) {
      const id = randomUUID(); this.candidates.set(id, row);
      candidates.push({ id, title: row.title, agentKind: row.agentKind as CindyImportCandidate['agentKind'], workingDir: row.workingDir,
        workspaceKind: row.workspaceKind === 'dialogue' ? 'dialogue' : 'project', archived: row.status === 'archived', updatedAt: row.updatedAt, imported: existing.has(row.id) });
    }
    this.scanId = randomUUID();
    await this.checkSource();
    return { scanId: this.scanId, candidates, excluded };
  }
  async preview(scanId: string, ids: string[]) {
    if (scanId !== this.scanId || !this.adapter || !Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw importError('invalidSelection');
    await this.checkSource();
    this.prepared = []; this.previewId = '';
    for (const id of ids) {
      this.assertCurrent();
      const row = this.candidates.get(id);
      if (!row) throw importError('invalidSelection');
      const source = this.adapter;
      source.issues.clear(); source.missingFiles.clear();
      const item: Prepared = { view: { id, title: row.title, issues: [], missingFiles: [], historyIncomplete: false, needsDirectory: false, workingDir: row.workingDir }, row, workspaces: [], attachments: [], external: new Map() };
      this.prepared.push(item);
      try {
        if (await this.existing(row.id)) { item.view.error = 'alreadyImported'; continue; }
        const workers = row.orcaRole === 'lead' ? await source.readWorkers(row.id) : null;
        const members = [row, ...(workers?.workers.map((w) => w.session) ?? [])];
        for (const member of members) item.workspaces.push(await prepareWorkspace(source, member));
        item.attachments = await prepareAttachments(source, members);
        item.view.needsDirectory = item.workspaces.some((w) => w.needsDirectory);
        const dir = path.join(this.temp!, randomUUID());
        item.directory = dir;
        await fs.mkdir(dir, { mode: 0o700 });
        const outcome = await exportSessionShare({ sessionId: row.id, targetPath: path.join(dir, 'task.cshare'), source, migration: true, externalTranscripts: { dir, minBytes: 0 } });
        if (outcome.status !== 'ok') throw importError('tooLarge');
        source.reserveStaging(await directoryBytes(dir));
        item.file = outcome.filePath;
        item.external = new Map(outcome.externalTranscripts?.map((t) => [t.path, path.join(dir, t.file)]));
        if (outcome.mediaMissing || outcome.mediaDropped) source.issues.add('mediaMissing');
        if (outcome.fidelity !== 'full' && (await source.readMessages(row.id, row.clearedAt)).length) source.issues.add('nativeMissing');
        item.view.historyIncomplete = source.issues.has('nativeMissing') || source.issues.has('historyOnly');
        item.view.issues = [...source.issues]; item.view.missingFiles = [...source.missingFiles];
        item.view.workingDir = item.workspaces[0].project;
      } catch (error) {
        if (item.directory) await fs.rm(item.directory, { recursive: true, force: true }).catch(() => undefined);
        item.file = undefined;
        if (['ownerChanged', 'canceled', 'sourceChanged'].includes(errorCode(error))) throw error;
        item.view.error = errorCode(error);
      }
    }
    await this.checkSource();
    this.previewId = randomUUID();
    return { previewId: this.previewId, items: this.prepared.map((p) => p.view) };
  }
  async chooseProject(previewId: string, id: string, directory: string) {
    this.assertCurrent();
    if (previewId !== this.previewId) throw importError('invalidSelection');
    const item = this.prepared.find((p) => p.view.id === id);
    if (!item || !this.source || !localPath(directory) || inside(this.source.root, directory) || inside(app.getPath('userData'), directory)) throw importError('unsafePath');
    const canonical = await fs.realpath(directory);
    const targetRoot = await fs.realpath(app.getPath('userData'));
    if (!localPath(canonical) || inside(this.source.root, canonical) || inside(targetRoot, canonical) || !(await fs.stat(canonical)).isDirectory()) throw importError('unsafePath');
    this.assertCurrent();
    for (const workspace of item.workspaces) {
      if (workspace.needsDirectory || (!workspace.staged && workspace.session.id === item.row.id)) { workspace.project = canonical; workspace.needsDirectory = false; }
    }
    item.view.workingDir = canonical; item.view.needsDirectory = false;
    return canonical;
  }
  async commit(input: CindyImportCommit): Promise<CindyImportResult[]> {
    if (input.previewId !== this.previewId || !this.prepared.length) throw importError('invalidSelection');
    await this.checkSource();
    if (this.prepared.some((p) => !p.view.error && (p.view.needsDirectory || (p.view.issues.length > 0 && input.allowIncomplete !== true)))) throw importError('confirmationRequired');
    const results: CindyImportResult[] = [];
    // Consume once. Retry requires a fresh snapshot and live deduplication check.
    this.previewId = '';
    for (const item of this.prepared) {
      if (item.view.error) { results.push({ id: item.view.id, status: item.view.error === 'alreadyImported' ? 'skipped' : 'failed', code: item.view.error }); continue; }
      if (this.canceled) { results.push({ id: item.view.id, status: 'canceled' }); continue; }
      const created: string[] = [];
      let published = false;
      let draftId: string | undefined;
      try {
        await this.checkSource();
        if (await this.existing(item.row.id)) { results.push({ id: item.view.id, status: 'skipped' }); continue; }
        const newId = randomUUID();
        const now = Date.now();
        const attachmentRoot = buildDialogueWorkspaceDir(newId, now);
        const members: Array<{ sourceSessionId: string; sessionId: string; workingDir: string }> = [];
        for (const [index, workspace] of item.workspaces.entries()) {
          this.assertCurrent();
          const sessionId = index === 0 ? newId : randomUUID();
          const ownedDir = buildDialogueWorkspaceDir(sessionId, now);
          const workingDir = workspace.project ?? ownedDir;
          if (!workspace.project) {
            await fs.mkdir(ownedDir, { recursive: true, mode: 0o700 }); created.push(ownedDir);
            if (workspace.staged) await copyTree(workspace.staged, ownedDir, this.assertCurrent, () => { throw importError('sourceChanged'); });
          }
          members.push({ sourceSessionId: workspace.session.id, sessionId, workingDir });
        }
        const paths = new Map<string, string>();
        if (item.attachments.some((a) => a.staged)) {
          if (!created.includes(attachmentRoot)) { await fs.mkdir(attachmentRoot, { recursive: true, mode: 0o700 }); created.push(attachmentRoot); }
        }
        for (const attachment of item.attachments) {
          const extension = path.extname(attachment.name);
          const target = path.join(attachmentRoot, '.imported-files', randomUUID() + (/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : '.bin'));
          if (attachment.staged) { await copyStableFile(this.temp!, attachment.staged, target); paths.set(attachment.original, target); }
          else paths.set(attachment.original, '');
        }
        const draft = await inspectShareFile(item.file!); draftId = draft.draftId;
        this.assertCurrent();
        const refCompensationScope = captureMediaRefCompensationScope(this.owner);
        const preferences = sanitizePreferences(input.preferences);
        const result = await commitShareImport({ draftId, draftPrefs: preferences[item.row.agentKind as keyof typeof preferences] }, {
          dbClient: this.db, assertStillValid: this.assertCurrent, refCompensationScope,
          localCopy: { sessionId: newId, workingDir: members[0].workingDir,
            ...(item.row.orcaRole === 'lead' && (await this.adapter!.readWorkers(item.row.id)) ? { workers: members.slice(1) } : {}),
            agentPrefs: preferences, externalTranscripts: item.external, historyOnly: item.view.historyIncomplete,
            receipt: { sourceKey: this.source!.key, sourceSessionId: item.row.id, fidelity: item.view.historyIncomplete ? 'db-only' : 'full' },
            beforeCommit: () => this.checkSource(),
            rewriteContent: (content) => rewriteAttachments(content, paths) },
        });
        published = true;
        results.push({ id: item.view.id, status: 'imported', sessionId: result.sessionId });
      } catch (error) {
        // A lost commit ACK is not proof of rollback. Preserve files for the possibly committed row.
        if (!published && !isDbTransportOutcomeUnknown(error)) for (const dir of created) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        const code = errorCode(error);
        if (code === 'ownerChanged') throw error;
        results.push({ id: item.view.id, status: code === 'canceled' ? 'canceled' : code === 'ALREADY_EXISTS' ? 'skipped' : 'failed', code });
      } finally { if (draftId) cancelShareDraft(draftId); }
    }
    await this.clearSnapshot();
    return results;
  }
  async cancel(): Promise<void> { this.canceled = true; if (!this.busy) await this.dispose(); }
  private async clearSnapshot(): Promise<void> {
    await this.reader?.close(); this.reader = undefined; this.adapter = undefined;
    if (this.temp) await fs.rm(this.temp, { recursive: true, force: true });
    this.temp = undefined; this.stamp = ''; this.candidates.clear(); this.prepared = []; this.scanId = ''; this.previewId = '';
  }
  private async dispose(): Promise<void> { clearTimeout(this.timer); await this.clearSnapshot(); this.sources.clear(); }
}
async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw importError('unsafePath');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) total += (await fs.stat(file)).size;
      else throw importError('unsafePath');
    }
  };
  await visit(root);
  return total;
}
function sanitizePreferences(value: CindyImportCommit['preferences']) {
  const output: CindyImportCommit['preferences'] = {};
  for (const engine of ['cc', 'codex', 'pi', 'omp'] as const) {
    const prefs = value?.[engine];
    output[engine] = { model: typeof prefs?.model === 'string' ? prefs.model.slice(0, 256) : undefined,
      providerId: typeof prefs?.providerId === 'string' ? prefs.providerId.slice(0, 256) : null,
      effort: typeof prefs?.effort === 'string' ? prefs.effort.slice(0, 64) : undefined,
      planMode: prefs?.planMode === true, fastMode: prefs?.fastMode === true };
  }
  return output;
}
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Za-z_]{1,64}$/.test(code) ? code : 'importFailed';
}
