/**
 * Attachments on group chat messages (docs/product-rules/bot-group-chat.md §3.1,
 * docs/dev-rules/media-storage-and-protocols.md).
 *
 * - Images live in cindy-media with a `bot-group-attachment` reference on the group, dropped
 *   in the same transaction that deletes the group. Each member's Session adds its usual
 *   `session-attachment` reference when the turn is saved.
 * - A file picked on this computer stays where it is, exactly as in a task message.
 * - A phone's upload is fetched once; supported image/video/audio bytes enter cindy-media,
 *   while non-media files are kept in the group's folder (`bot-groups/<groupId>/attachments/`),
 *   which goes to the trash with the group.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentIntegrity } from '@cindy/device-link';

import * as blobStore from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import * as ledger from '../cindy-media/ledger.js';
import { getDbClient } from '../localDb/client/current.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { removeRemote } from '../device-link/mediaTransfer.js';
import {
  materializeRemoteAttachment,
  parseRemoteAttachmentRef,
  type RemoteAttachment,
} from '../device-link/remoteAttachment.js';
import type { MediaRefCompensationScope } from '../cindy-media/refCompensationJournal.js';
import { isDangerousAttachmentName } from '../../shared/attachmentSafety.js';
import {
  BOT_GROUP_ATTACHMENTS_MAX,
  type BotGroupAttachment,
  type BotGroupAttachmentCategory,
  type BotGroupFailure,
} from '../../shared/botGroupChat.js';
import type { BotGroupPreparedAttachments } from './botGroupChatService.js';
import type { BotGroupAttachmentUploadLease, BotGroupAttachmentUploadRegistry } from './botGroupAttachmentUploadRegistry.js';

const CATEGORIES: ReadonlySet<string> = new Set<BotGroupAttachmentCategory>(['image', 'pdf', 'text', 'office', 'file']);
const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 255;

interface AttachmentEntry {
  id: string;
  name: string;
  path: string;
  category: BotGroupAttachmentCategory;
  mimeType: string;
  size: number;
  sha256: string | null;
  url: string | null;
  uploadReceipt: string | null;
  uploadIntent: string | null;
  annotated: boolean;
}

function invalid(): BotGroupFailure {
  return { ok: false, errorCode: 'INVALID_PARAMS', message: '附件无效' };
}

function readEntry(value: unknown): AttachmentEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.originalName === 'string' && raw.originalName.trim() ? raw.originalName : raw.name;
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_CHARS) return null;
  if ((raw.path !== undefined && typeof raw.path !== 'string') || typeof raw.mimeType !== 'string') return null;
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category)) return null;
  if (raw.url !== undefined && typeof raw.url !== 'string') return null;
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_CHARS ? raw.id : randomUUID();
  return {
    id,
    name: name.trim(),
    path: typeof raw.path === 'string' ? raw.path : '',
    category: raw.category as BotGroupAttachmentCategory,
    mimeType: raw.mimeType,
    size: typeof raw.size === 'number' && Number.isSafeInteger(raw.size) ? raw.size : 0,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
    url: typeof raw.url === 'string' ? raw.url : null,
    uploadReceipt: typeof raw.uploadReceipt === 'string' ? raw.uploadReceipt : null,
    uploadIntent: typeof raw.uploadIntent === 'string' ? raw.uploadIntent : null,
    annotated: raw.annotated === true,
  };
}

/** A name that is safe as the last segment of a path on every platform. */
export function safeAttachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return (cleaned || 'attachment').slice(0, 120);
}

function integrityFor(ref: RemoteAttachment): AttachmentIntegrity | undefined {
  return ref.size !== undefined && ref.sha256 !== undefined
    ? { size: ref.size, sha256: ref.sha256 }
    : undefined;
}

async function isRegularFile(file: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return null;
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

interface DirectoryIdentity {
  lexicalPath: string;
  realPath: string;
  dev: string;
  ino: string;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readSafeDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const lexicalPath = path.resolve(directory);
  const lexical = await fs.lstat(lexicalPath);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error('FILE_PEER_UNSAFE_STORAGE');
  const realPath = await fs.realpath(lexicalPath);
  if (!samePath(realPath, lexicalPath)) throw new Error('FILE_PEER_UNSAFE_STORAGE');
  const physical = await fs.lstat(realPath);
  if (!physical.isDirectory() || physical.isSymbolicLink()) throw new Error('FILE_PEER_UNSAFE_STORAGE');
  return { lexicalPath, realPath, dev: String(physical.dev), ino: String(physical.ino) };
}

async function assertDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  const current = await readSafeDirectoryIdentity(identity.lexicalPath);
  if (!samePath(current.realPath, identity.realPath) || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('FILE_PEER_UNSAFE_STORAGE');
  }
}

function safePathSegment(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_CHARS &&
    value !== '.' && value !== '..' && !value.includes('\0') &&
    !value.includes('/') && !value.includes('\\');
}

async function ensureSafeDirectoryChain(
  root: DirectoryIdentity,
  segments: readonly string[],
  assertCurrent: () => Promise<void>,
): Promise<{ path: string; identity: DirectoryIdentity }> {
  let current = root.lexicalPath;
  for (const segment of segments) {
    if (!safePathSegment(segment)) throw new Error('FILE_PEER_UNSAFE_STORAGE');
    await assertCurrent();
    await assertDirectoryIdentity(root);
    const child = path.join(current, segment);
    try {
      const info = await fs.lstat(child);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('FILE_PEER_UNSAFE_STORAGE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      await fs.mkdir(child, { recursive: false });
      const created = await fs.lstat(child);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('FILE_PEER_UNSAFE_STORAGE');
    }
    current = child;
  }
  await assertCurrent();
  await assertDirectoryIdentity(root);
  return { path: current, identity: await readSafeDirectoryIdentity(current) };
}

export interface BotGroupAttachmentStore {
  prepare: (input: {
    groupId: string;
    attachments: readonly unknown[];
    controllerDeviceId?: string;
    operationGuard?: () => void;
    remoteContext?: { ownerToken: string; client?: unknown; linkEpoch?: number; groupRevision?: string };
  }) => Promise<BotGroupPreparedAttachments | BotGroupFailure>;
}

export interface RemoteAttachmentAuthorizationContext {
  groupId: string;
  controllerDeviceId: string;
  ownerRoot: string;
}

export function createBotGroupAttachmentStore(deps: {
  ownerRoot: () => string;
  attachmentUploads?: BotGroupAttachmentUploadRegistry;
  /** Verifies a server-issued upload capability; absent means fail closed. */
  verifyRemoteAttachment?: (
    ref: RemoteAttachment,
    context: RemoteAttachmentAuthorizationContext,
  ) => Promise<boolean>;
  captureCompensationScope?: () => MediaRefCompensationScope;
}): BotGroupAttachmentStore {
  const prepare: BotGroupAttachmentStore['prepare'] = async (input) => {
    if (input.attachments.length > BOT_GROUP_ATTACHMENTS_MAX) return invalid();
    // Capture one account/database for the whole batch. An owner switch while
    // fetching a phone upload must not write into or clean up the next account.
    const db = getDbClient().drizzle;
    const ownerRoot = path.resolve(deps.ownerRoot());
    if (!safePathSegment(input.groupId)) return invalid();
    let ownerIdentity: DirectoryIdentity;
    try {
      ownerIdentity = await readSafeDirectoryIdentity(ownerRoot);
    } catch {
      // Account/session setup owns the root. Receiving an attachment must not
      // silently create a replacement root for a missing or redirected disk.
      return invalid();
    }
    let compensationScope: MediaRefCompensationScope | undefined;
    if (input.operationGuard) {
      try {
        compensationScope = deps.captureCompensationScope?.();
      } catch {
        return invalid();
      }
    }
    const assertCurrent = async (): Promise<void> => {
      input.operationGuard?.();
      if (!samePath(path.resolve(deps.ownerRoot()), ownerRoot)) throw new Error('FILE_PEER_OWNER_CHANGED');
      await assertDirectoryIdentity(ownerIdentity);
      compensationScope?.assertStillValid();
    };
    const refIds: string[] = [];
    const folders: string[] = [];
    const uploads: string[] = [];
    const remoteLeases: BotGroupAttachmentUploadLease[] = [];
    const folderIdentities = new Map<string, DirectoryIdentity>();
    let discarded = false;
    let committed = false;
    const discard = async () => {
      if (discarded || committed) return;
      discarded = true;
      for (const refId of refIds.splice(0)) {
        try {
          await assertCurrent();
          await ledger.removeRefById(refId, db);
          await assertCurrent();
        } catch {
          // An owner/revocation change makes cleanup on this captured DB unsafe;
          // leave the exact ref for owner-scoped reconciliation.
        }
      }
      // Keep relay sources on failed or unknown sends; they are the only safe
      // retry source when append's transport outcome is not known.
      for (const folder of folders.splice(0)) {
        const identity = folderIdentities.get(folder);
        if (!identity) continue;
        try {
          await assertCurrent();
          const current = await readSafeDirectoryIdentity(folder);
          if (current.dev === identity.dev && current.ino === identity.ino) {
            await fs.rm(folder, { recursive: true, force: true });
          }
        } catch {
          // Never follow a replaced directory/junction during cleanup.
        }
      }
      // A failed or transport-unknown message must retain the host-issued
      // upload source for reconciliation/retry; only commit releases it.
      for (const lease of remoteLeases.splice(0)) await lease.rollback().catch(() => undefined);
    };

    /** The group's reference to an image already in the media store (once per group). */
    const referenceImage = async (hash: string) => {
      await assertCurrent();
      await ledger.pinBlob(hash, db);
      await assertCurrent();
      // Each prepare/send owns a distinct reference row even when the bytes are
      // shared with another message.  Discard can therefore release only this
      // batch; group deletion removes all rows by the stable group refId.
      const refId = await ledger.addRef({ hash, refKind: 'bot-group-attachment', refId: input.groupId, originKind: 'user' }, db);
      refIds.push(refId);
      await assertCurrent();
    };

    /** Picked on this computer: images are already in the media store, files stay in place. */
    const local = async (entry: AttachmentEntry): Promise<BotGroupAttachment | null> => {
      if (entry.category === 'image' && entry.url?.startsWith('cindy-media://')) {
        const blob = blobStore.parseBlobUrl(entry.url);
        if (!blob) return null;
        await assertCurrent();
        const size = await isRegularFile(blobStore.resolveSafe(entry.url).absPath);
        if (size === null) return null;
        await assertCurrent();
        await referenceImage(blob.hash);
        return { id: entry.id, name: entry.name, category: 'image', mimeType: entry.mimeType, size, url: entry.url, path: null, ...(entry.annotated ? { annotated: true } : {}) };
      }
      if (!path.isAbsolute(entry.path)) return null;
      await assertCurrent();
      const size = await isRegularFile(entry.path);
      if (size === null) return null;
      await assertCurrent();
      // An image the media store could not take goes to the members as a plain file.
      const category = entry.category === 'image' ? 'file' : entry.category;
      return { id: entry.id, name: entry.name, category, mimeType: entry.mimeType, size, url: null, path: entry.path };
    };

    /** Sent by a phone: only its own uploads are accepted, never a path on this computer. */
    const remote = async (entry: AttachmentEntry): Promise<BotGroupAttachment | null> => {
      let ref: RemoteAttachment;
      if (entry.uploadReceipt) {
        if (!input.controllerDeviceId || !deps.attachmentUploads || !input.remoteContext) {
          throw new Error('FILE_PEER_UNVERIFIED');
        }
        const lease = await deps.attachmentUploads.consume(entry.uploadReceipt, {
          controllerDeviceId: input.controllerDeviceId,
          groupId: input.groupId,
          intent: entry.uploadIntent ?? '',
          attachmentId: entry.id,
          size: entry.size,
          sha256: entry.sha256 ?? '',
          mimeType: entry.mimeType,
          ...input.remoteContext,
          assertCurrent: input.operationGuard,
        });
        remoteLeases.push(lease);
        ref = lease.ref;
      } else {
        // Legacy OSS references do not carry an authenticated issuing peer.
        // They remain accepted only for an explicitly supplied verifier (the
        // production group store does not install one), never by key prefix.
        const refText = entry.url ?? entry.path;
        const parsed = parseRemoteAttachmentRef(refText);
        if (!parsed || parsed.size === undefined || parsed.sha256 === undefined) return null;
        if (!input.controllerDeviceId || !deps.verifyRemoteAttachment) throw new Error('FILE_PEER_UNVERIFIED');
        const authorized = await deps.verifyRemoteAttachment(parsed, { groupId: input.groupId, controllerDeviceId: input.controllerDeviceId, ownerRoot });
        await assertCurrent();
        if (!authorized) throw new Error('FILE_PEER_DENIED');
        ref = parsed;
      }
      await assertCurrent();
      if (isDangerousAttachmentName(entry.name)) throw new Error('FILE_PEER_UNSAFE_NAME');
      const mimeType = ref.mimeType ?? entry.mimeType;
      const dirResult = await ensureSafeDirectoryChain(ownerIdentity, ['bot-groups', input.groupId, 'attachments'], assertCurrent);
      const dir = dirResult.path;
      // The owner-root check alone is not enough: a group attachment directory
      // can be replaced by a junction/symlink while the relay download is
      // awaiting the network.  Recheck the captured directory identity at every
      // asynchronous boundary before allowing bytes or refs to become durable.
      const assertAttachmentDirectory = async (): Promise<void> => {
        await assertCurrent();
        await assertDirectoryIdentity(dirResult.identity);
      };
      const incoming = path.join(dir, `.incoming-${randomUUID()}`);
      try {
        await assertAttachmentDirectory();
        await materializeRemoteAttachment(ref, incoming, integrityFor(ref));
        await assertAttachmentDirectory();
        if (await isRegularFile(incoming) === null) throw new Error('FILE_PEER_INVALID_FILE');
        await assertAttachmentDirectory();
        // A registry lease owns release/rollback of the host-issued object.
        // Keep the legacy list only for verifier-backed refs, otherwise commit
        // would release the same object once through `uploads` and once through
        // the lease state machine.
        if (!entry.uploadReceipt && ref.ossKey) uploads.push(ref.ossKey);
        const buffer = await fs.readFile(incoming);
        await assertAttachmentDirectory();
        const detectedMime = sniffMediaMime(buffer, mimeType);
        if (detectedMime && blobStore.supportedMime(detectedMime)) {
          await assertAttachmentDirectory();
          if (input.operationGuard && !compensationScope) throw new Error('FILE_PEER_OWNER_SCOPE_UNAVAILABLE');
          const written = await ingestMedia({
            buffer,
            mimeType: detectedMime,
            refs: [{ refKind: 'bot-group-attachment', refId: input.groupId, originKind: 'user' }],
            ...(input.operationGuard ? { assertStillValid: () => { input.operationGuard?.(); compensationScope?.assertStillValid(); } } : {}),
            ...(compensationScope ? { refCompensationScope: compensationScope } : {}),
          }, db);
          await assertAttachmentDirectory();
          refIds.push(...written.refIds);
          const size = await isRegularFile(blobStore.resolveSafe(written.url).absPath) ?? 0;
          await assertAttachmentDirectory();
          return { id: entry.id, name: entry.name, category: detectedMime.startsWith('image/') ? 'image' : 'file', mimeType: detectedMime, size, url: written.url, path: null, ...(entry.annotated ? { annotated: true } : {}) };
        }
        await assertAttachmentDirectory();
        const folderResult = await ensureSafeDirectoryChain(dirResult.identity, [randomUUID()], assertCurrent);
        const folder = folderResult.path;
        folders.push(folder);
        folderIdentities.set(folder, folderResult.identity);
        const file = path.join(folder, safeAttachmentFileName(entry.name));
        await assertAttachmentDirectory();
        await assertDirectoryIdentity(folderResult.identity);
        await fs.rename(incoming, file);
        await assertAttachmentDirectory();
        await assertDirectoryIdentity(folderResult.identity);
        const size = await isRegularFile(file) ?? 0;
        if (size <= 0) throw new Error('FILE_PEER_INVALID_FILE');
        const category = entry.category === 'image' ? 'file' : entry.category;
        return { id: entry.id, name: entry.name, category, mimeType, size, url: null, path: file };
      } finally {
        // The incoming path is a single file, so removing it never recursively
        // follows a replaced directory. The kept batch directory is removed only
        // by discard after its captured identity is rechecked.
        await fs.rm(incoming, { force: true }).catch(() => undefined);
      }
    };

    const attachments: BotGroupAttachment[] = [];
    try {
      for (const value of input.attachments) {
        const entry = readEntry(value);
        const attachment = entry ? await (input.controllerDeviceId ? remote(entry) : local(entry)) : null;
        if (!attachment) {
          await discard();
          return invalid();
        }
        attachments.push(attachment);
      }
    } catch (error) {
      await discard();
      // Transfer errors carry no host paths; anything else is reported generically.
      const message = error instanceof Error && /^FILE_PEER_|DEVICE_LINK_/.test(error.message) ? error.message : '附件无效';
      return { ok: false, errorCode: 'INVALID_PARAMS', message };
    }
    return {
      ok: true,
      attachments,
      commit: async () => {
        if (committed || discarded) return;
        committed = true;
        try {
          await assertCurrent();
        } catch {
          // The message is already durable; retain relay sources when owner or
          // storage identity changed so reconciliation can release them safely.
          return;
        }
        for (const key of uploads.splice(0)) await removeRemote(key).catch(() => undefined);
        for (const lease of remoteLeases.splice(0)) await lease.commit().catch(() => undefined);
      },
      discard,
    };
  };

  return { prepare };
}
