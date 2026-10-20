/** Local composer content is durable in Main, never in Renderer web storage. */
import { ipcMain } from 'electron';
import fs from 'node:fs';
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

const log = createLogger('ComposerDrafts');
const fileSchema = z.object({ entries: composerDraftEntriesSchema });
type DraftFile = z.infer<typeof fileSchema>;
const stores = new Map<string, ReturnType<typeof createStore>>();
const writes = new Map<string, Promise<void>>();
const pending = new Map<string, Map<string, ComposerDraftWrite>>();

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
    if (overlay.get(request.key) === request) overlay.delete(request.key);
    if (overlay.size === 0 && pending.get(file) === overlay) pending.delete(file);
    if (writes.get(file) === operation) writes.delete(file);
  });
  writes.set(file, operation);
  return operation;
}

/** Include disk-only drafts in the existing media recycler's live references. */
export function getPersistedComposerDraftUrls(): string[] {
  const stamp = getActiveDataOwnerPushStamp();
  requireOwner(stamp);
  // Pending deletion must not release disk references before the atomic clear
  // succeeds. Pending additions must be protected before their write settles.
  const entries = readEntries(false);
  const { file } = currentStore();
  const urls = entries.flatMap(entry => getComposerDraftContentUrls(entry.content));
  for (const request of pending.get(file)?.values() ?? []) {
    if (request.content) urls.push(...getComposerDraftContentUrls(request.content));
  }
  return urls;
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
