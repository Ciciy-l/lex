/** Local composer content is durable in Main, never in Renderer web storage. */
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  COMPOSER_DRAFT_LOAD, COMPOSER_DRAFT_SAVE,
  type ComposerDraftEntry, type ComposerDraftSnapshot, type ComposerDraftWrite,
} from '../shared/composerDraft.js';
import {
  COMPOSER_DRAFT_FILE_MAX_BYTES, composerDraftContentSchema, composerDraftEntriesSchema,
  composerDraftKeySchema, getComposerDraftContentUrls,
} from '../shared/composerDraftValidation.js';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import { isIpcError } from '../shared/ipc-errors.js';
import {
  activeOwnerScopeKey, getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending, ownerScopedUserDataPath,
} from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';

const log = createLogger('ComposerDrafts');
const fileSchema = z.object({ entries: composerDraftEntriesSchema });
type DraftFile = z.infer<typeof fileSchema>;
const stores = new Map<string, ReturnType<typeof createStore>>();
const writes = new Map<string, Promise<void>>();
const pending = new Map<string, Map<string, ComposerDraftWrite>>();
// Keep every accepted operation until it settles, including an older save that
// a later save/clear has superseded in the Renderer overlay or after an owner switch.
const pendingMedia = new Set<ComposerDraftWrite>();

function requireOwner(stamp: unknown): asserts stamp is DataOwnerPushStamp {
  const current = getActiveDataOwnerPushStamp();
  if (!isDataOwnerPushStamp(stamp) || !current.dataOwnerId || isAppSessionBoundaryPending() ||
      stamp.dataOwnerId !== current.dataOwnerId || stamp.ownerGeneration !== current.ownerGeneration) {
    throwIpcError('PRECONDITION_FAILED', 'composer draft owner changed');
  }
}

function createStore(file: string) {
  let unreadable = false;
  const store = createOverrideSettingsFile<DraftFile>({
    filePath: () => file, defaults: { entries: [] },
    normalize: raw => fileSchema.parse(raw),
    log: {
      info: () => { unreadable = false; },
      warn: () => {
        unreadable = true;
        log.warn('Composer draft file could not be read; preserving the original');
      },
    },
    label: 'composer draft', scopeKey: activeOwnerScopeKey,
    maxBytes: COMPOSER_DRAFT_FILE_MAX_BYTES, preserveUnreadableFile: true,
    logLoadedValue: false, logReadErrorDetails: false,
  });
  return { store, isUnreadable: () => unreadable && fs.existsSync(file) };
}

function currentStore() {
  const file = ownerScopedUserDataPath('composer-drafts.json');
  let result = stores.get(file);
  if (!result) { result = createStore(file); stores.set(file, result); }
  return { ...result, file };
}

function readEntries(includePending = true): ComposerDraftEntry[] {
  const { store, isUnreadable, file } = currentStore();
  store.invalidateIfChanged();
  const { entries } = store.read();
  if (isUnreadable()) throwIpcError('PRECONDITION_FAILED', 'composer draft storage is unavailable');
  const merged = new Map(entries.map(entry => [entry.key, entry.content]));
  // A reload may arrive while the last keystroke is waiting for the file lock.
  // Reflect accepted writes without waiting in a synchronous IPC handler.
  for (const request of includePending ? pending.get(file)?.values() ?? [] : []) {
    const stamp = getActiveDataOwnerPushStamp();
    if (stamp.dataOwnerId !== request.dataOwnerId || stamp.ownerGeneration !== request.ownerGeneration) continue;
    if (request.content) merged.set(request.key, request.content);
    else merged.delete(request.key);
  }
  return Array.from(merged, ([key, content]) => ({ key, content }));
}

export function loadComposerDraftSnapshot(stamp: unknown): ComposerDraftSnapshot | null {
  try {
    requireOwner(stamp);
    return { ...getActiveDataOwnerPushStamp(), entries: readEntries() };
  } catch { return null; }
}

export function saveComposerDraft(raw: unknown): Promise<void> {
  requireOwner(raw);
  if (!raw || typeof raw !== 'object' || !('key' in raw) || !('content' in raw)) {
    throwIpcError('INVALID_PARAMS', 'invalid composer draft');
  }
  const key = composerDraftKeySchema.safeParse(raw.key);
  const content = composerDraftContentSchema.nullable().safeParse(raw.content);
  if (!key.success || !content.success) throwIpcError('INVALID_PARAMS', 'invalid composer draft');
  const request: ComposerDraftWrite = {
    dataOwnerId: raw.dataOwnerId, ownerGeneration: raw.ownerGeneration,
    key: key.data, content: content.data,
  };
  const { store, file } = currentStore();
  const overlay = pending.get(file) ?? new Map<string, ComposerDraftWrite>();
  pending.set(file, overlay);
  overlay.set(request.key, request);
  pendingMedia.add(request);
  const operation: Promise<void> = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    requireOwner(request);
    await store.updateAtomic(({ value }) => {
      requireOwner(request);
      const entries = value.entries.filter(entry => entry.key !== request.key);
      if (request.content) entries.push({ key: request.key, content: request.content });
      return { entries };
    }, { preserveDefaults: true });
  }).catch((error: unknown) => {
    // Never include editor content, attachment paths, or parser input in logs/errors.
    if (isIpcError(error)) throw error;
    log.warn('Composer draft write did not complete');
    throwIpcError('INTERNAL', 'composer draft could not be saved');
  }).finally(() => {
    pendingMedia.delete(request);
    if (overlay.get(request.key) === request) overlay.delete(request.key);
    if (overlay.size === 0 && pending.get(file) === overlay) pending.delete(file);
    if (writes.get(file) === operation) writes.delete(file);
  });
  writes.set(file, operation);
  return operation;
}

function optionalLstat(file: string): fs.BigIntStats | null {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function requireUnchangedDirectory(directory: string, before: fs.BigIntStats): void {
  const after = fs.lstatSync(directory, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev ||
      before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error('composer draft directory changed');
  }
}

/** Host-only retention census. Never use this cross-owner result as a Renderer snapshot. */
function readAllOwnerMediaUrls(): string[] {
  const root = path.join(app.getPath('userData'), 'owners');
  const rootStat = optionalLstat(root);
  if (!rootStat) return []; // No owner namespace yet, not a failed/partial directory listing.
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid owner namespace');
  const names = fs.readdirSync(root).sort();
  // Abort rather than truncate a census that cannot fit a bounded Main operation.
  if (names.length > 1000) throw new Error('composer draft owner census exceeds limit');
  const urls = new Set<string>();
  const ownerDirectories = new Map<string, fs.BigIntStats>();
  let bytes = 0;
  for (const name of names) {
    const directory = path.join(root, name);
    const ownerStat = fs.lstatSync(directory, { bigint: true });
    // dataOwnerStorageKey's existing 20-hex namespace. Ignore ordinary metadata
    // files, but never silently omit an unrecognizable directory or link.
    if (!/^[a-f0-9]{20}$/.test(name) && ownerStat.isFile()) continue;
    if (!/^[a-f0-9]{20}$/.test(name) || !ownerStat.isDirectory() || ownerStat.isSymbolicLink()) {
      throw new Error('invalid composer draft owner namespace');
    }
    const realDirectory = fs.realpathSync(directory);
    if (path.relative(fs.realpathSync(root), realDirectory) !== name) throw new Error('owner directory escaped');
    const file = path.join(directory, 'composer-drafts.json');
    // Another Host may be publishing a new reference. Missing draft files are
    // legitimate only in a stable namespace with no in-flight atomic writer.
    const requireNoWriter = () => {
      if (optionalLstat(`${file}.lock`) || optionalLstat(`${file}.tmp`)) throw new Error('composer draft write in progress');
    };
    requireNoWriter();
    const stat = optionalLstat(file);
    if (stat) {
      const buffer = readBoundedFileNoFollowSync(file, COMPOSER_DRAFT_FILE_MAX_BYTES, { containWithin: realDirectory });
      if (!buffer) throw new Error('composer draft file unavailable');
      bytes += buffer.length;
      if (bytes > 128 * 1024 * 1024) throw new Error('composer draft census exceeds limit');
      const parsed = fileSchema.parse(JSON.parse(buffer.toString('utf8')));
      for (const entry of parsed.entries) {
        for (const url of getComposerDraftContentUrls(entry.content)) urls.add(url);
      }
    }
    requireNoWriter();
    requireUnchangedDirectory(directory, ownerStat);
    ownerDirectories.set(directory, ownerStat);
  }
  // A partial/changed enumeration must not look like an empty or complete census.
  // An earlier owner's atomic write can finish while a later owner is scanned.
  for (const [directory, ownerStat] of ownerDirectories) requireUnchangedDirectory(directory, ownerStat);
  if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(root).sort())) throw new Error('owner census changed');
  requireUnchangedDirectory(root, rootStat);
  return [...urls];
}

/** All owners share blob bytes, so cleanup must retain even never-loaded owners' drafts. */
export function getPersistedComposerDraftUrls(): string[] {
  const stamp = getActiveDataOwnerPushStamp();
  requireOwner(stamp);
  try {
    const urls = new Set(readAllOwnerMediaUrls());
    // A pending clear never hides disk references; every accepted addition is
    // protected until its own write/failure settles, independently of the active owner.
    for (const request of pendingMedia) {
      if (request.content) for (const url of getComposerDraftContentUrls(request.content)) urls.add(url);
    }
    requireOwner(stamp);
    return [...urls];
  } catch {
    // Do not return a partial set or expose another owner's filename/content.
    throwIpcError('PRECONDITION_FAILED', 'composer draft media references are unavailable');
  }
}

export async function flushComposerDraftWrites(): Promise<void> {
  await Promise.allSettled(Array.from(writes.values()));
}

export function registerComposerDraftIpc(): void {
  ipcMain.on(COMPOSER_DRAFT_LOAD, (event, stamp: unknown) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = loadComposerDraftSnapshot(stamp);
  });
  ipcMain.handle(COMPOSER_DRAFT_SAVE, (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    return saveComposerDraft(request);
  });
}
