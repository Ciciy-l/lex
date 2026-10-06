import { randomBytes, randomUUID } from 'node:crypto';

import {
  presignPutForRemoteAttachment,
  removeRemote,
  type PresignPutResponse,
} from '../device-link/mediaTransfer.js';
import type { RemoteAttachment } from '../device-link/remoteAttachment.js';

/**
 * Host-issued capability for a controller's group attachment upload.  The raw
 * OSS key and signed PUT URL deliberately stay in this process; only the short
 * lived opaque receipt and URL needed by the issuing controller cross the
 * resource boundary.
 */
export interface BotGroupAttachmentUploadContext {
  controllerDeviceId: string;
  groupId: string;
  intent: string;
  attachmentId: string;
  size: number;
  sha256: string;
  mimeType: string;
  /** Stable owner token captured by the remote-resource lease. */
  ownerToken: string;
  linkEpoch?: number;
  groupRevision?: string;
  /** Transport object identity, when the caller is a real remote connection. */
  client?: unknown;
  assertCurrent?: () => void;
}

export interface BotGroupAttachmentUploadGrant {
  receipt: string;
  putUrl: string;
  expiresAt: string;
  attachmentId: string;
  intent: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export interface BotGroupAttachmentUploadLease {
  ref: RemoteAttachment;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

interface Entry {
  receipt: string;
  hostInstanceId: string;
  context: BotGroupAttachmentUploadContext;
  presigned: PresignPutResponse;
  extension: string;
  expiresAtMs: number;
  state: 'prepared' | 'in-flight' | 'expired' | 'committed';
  expired: boolean;
  timer: ReturnType<typeof setTimeout>;
  cleanupPromise?: Promise<void>;
  cleanupAttempts: number;
}

interface PendingCleanup {
  receipt: string;
  key: string;
  attempts: number;
  promise?: Promise<void>;
}

interface PendingPrepare {
  context: BotGroupAttachmentUploadContext;
  extension: string;
  promise: Promise<BotGroupAttachmentUploadGrant>;
}

const MAX_PER_PEER = 64;
const MAX_ENTRIES = 512;
const MAX_PENDING_CLEANUP = 512;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/;
const MIME = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function invalid(message: string): Error {
  return new Error(`BOT_GROUP_UPLOAD_${message}`);
}

function validContext(context: BotGroupAttachmentUploadContext): void {
  if (!TOKEN_TEXT.test(context.controllerDeviceId) || !TOKEN_TEXT.test(context.groupId)
    || !TOKEN_TEXT.test(context.intent) || !TOKEN_TEXT.test(context.attachmentId)
    || !TOKEN_TEXT.test(context.ownerToken)) throw invalid('INVALID_CONTEXT');
  if (!Number.isSafeInteger(context.size) || context.size <= 0 || context.size > MAX_BYTES) throw invalid('INVALID_SIZE');
  if (!SHA256.test(context.sha256)) throw invalid('INVALID_INTEGRITY');
  if (!MIME.test(context.mimeType)) throw invalid('INVALID_MIME');
}

function sameBinding(left: BotGroupAttachmentUploadContext, right: BotGroupAttachmentUploadContext): boolean {
  // `client` is the connection identity captured by Device Link.  A caller may
  // omit it only when the receipt itself was created without one; once a grant
  // carries a client, omitting it must not weaken the binding.
  return left.controllerDeviceId === right.controllerDeviceId
    && left.groupId === right.groupId
    && left.intent === right.intent
    && left.attachmentId === right.attachmentId
    && left.ownerToken === right.ownerToken
    && left.linkEpoch === right.linkEpoch
    && (left.client === undefined && right.client === undefined || left.client === right.client);
}

function sameContent(left: BotGroupAttachmentUploadContext, right: BotGroupAttachmentUploadContext): boolean {
  return left.size === right.size
    && left.sha256 === right.sha256
    && left.mimeType === right.mimeType;
}

function expiresAtMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createBotGroupAttachmentUploadRegistry(deps: {
  presignPut?: (size: number, ext: string, contentType: string) => Promise<PresignPutResponse>;
  removeRemote?: (key: string) => Promise<void>;
  now?: () => number;
  ttlMs?: number;
} = {}) {
  const entries = new Map<string, Entry>();
  // Cleanup failures must not turn an already durable group message into a
  // failed send. Keep only opaque receipt-indexed records in this bounded map;
  // raw relay keys never leave this process or appear in logs.
  const pendingCleanup = new Map<string, PendingCleanup>();
  // Keep a single presign request for one stable intent.  The prepare call can
  // be replayed after a lost ACK, and two concurrent replays must not create
  // two remote objects before either one reaches the registry.
  const pending: PendingPrepare[] = [];
  const hostInstanceId = randomUUID();
  const now = deps.now ?? Date.now;
  const presign = deps.presignPut ?? presignPutForRemoteAttachment;
  const release = deps.removeRemote ?? removeRemote;
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;

  const removeEntry = (entry: Entry): void => {
    clearTimeout(entry.timer);
    if (entries.get(entry.receipt) === entry) entries.delete(entry.receipt);
  };

  const attemptEntryCleanup = (entry: Entry): Promise<void> => {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    const cleanup = (async () => {
      try {
        await release(entry.presigned.key);
        if (entries.get(entry.receipt) === entry && entry.state === 'expired') removeEntry(entry);
      } catch (error) {
        entry.cleanupAttempts += 1;
        throw error;
      } finally {
        entry.cleanupPromise = undefined;
      }
    })();
    entry.cleanupPromise = cleanup;
    return cleanup;
  };

  const attemptPendingCleanup = (record: PendingCleanup): Promise<void> => {
    if (record.promise) return record.promise;
    const cleanup = (async () => {
      try {
        await release(record.key);
        if (pendingCleanup.get(record.receipt) === record) pendingCleanup.delete(record.receipt);
      } catch {
        // Best effort only: the durable message/ref is already committed. Keep
        // the bounded opaque record so a later registry operation can retry.
        record.attempts += 1;
      } finally {
        record.promise = undefined;
      }
    })();
    record.promise = cleanup;
    return cleanup;
  };

  const queuePendingCleanup = (receipt: string, key: string): void => {
    const existing = pendingCleanup.get(receipt);
    if (existing) {
      void attemptPendingCleanup(existing).catch(() => undefined);
      return;
    }
    // A relay object has its own server-side expiry. Never let local cleanup
    // bookkeeping grow without bound if the remote endpoint stays unavailable.
    if (pendingCleanup.size >= MAX_PENDING_CLEANUP) return;
    const record: PendingCleanup = { receipt, key, attempts: 0 };
    pendingCleanup.set(receipt, record);
    void attemptPendingCleanup(record).catch(() => undefined);
  };

  const expirePrepared = (entry: Entry): void => {
    if (entry.state === 'committed' || entry.state === 'in-flight') return;
    entry.expired = true;
    entry.state = 'expired';
    clearTimeout(entry.timer);
    // Timer/find cleanup is deliberately detached but always caught. A failed
    // delete leaves the expired entry available for an explicit retry.
    void attemptEntryCleanup(entry).catch(() => undefined);
  };

  const scheduleExpiry = (entry: Entry): void => {
    entry.timer = setTimeout(() => {
      if (entry.state === 'committed') {
        removeEntry(entry);
        return;
      }
      // An in-flight materialisation may have an unknown outcome.  Mark it
      // expired but do not delete its source while it could still commit.
      if (entry.state === 'in-flight') {
        entry.expired = true;
        return;
      }
      expirePrepared(entry);
    }, Math.max(1, Math.min(ttl, Math.max(1, entry.expiresAtMs - now()))));
  };

  const peerCount = (deviceId: string): number => {
    let count = 0;
    for (const entry of entries.values()) if (entry.context.controllerDeviceId === deviceId) count += 1;
    for (const item of pending) if (item.context.controllerDeviceId === deviceId) count += 1;
    return count;
  };

  const totalBytes = (): number => {
    let total = 0;
    for (const entry of entries.values()) total += entry.context.size;
    for (const item of pending) total += item.context.size;
    return total;
  };

  const retryPendingCleanup = async (): Promise<void> => {
    await Promise.all([...pendingCleanup.values()].map((record) => attemptPendingCleanup(record)));
  };

  const prepare = async (context: BotGroupAttachmentUploadContext, ext: string): Promise<BotGroupAttachmentUploadGrant> => {
    void retryPendingCleanup().catch(() => undefined);
    validContext(context);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(ext)) throw invalid('INVALID_EXT');
    context.assertCurrent?.();
    for (const entry of entries.values()) {
      if (entry.context.intent === context.intent && entry.context.attachmentId === context.attachmentId) {
        if (!sameBinding(entry.context, context) || !sameContent(entry.context, context)
          || entry.extension !== ext || entry.expired || entry.state === 'committed') throw invalid('INTENT_REUSED');
        context.assertCurrent?.();
        return {
          receipt: entry.receipt, putUrl: entry.presigned.putUrl, expiresAt: new Date(entry.expiresAtMs).toISOString(),
          attachmentId: entry.context.attachmentId, intent: entry.context.intent, size: entry.context.size,
          sha256: entry.context.sha256, mimeType: entry.context.mimeType,
        };
      }
    }
    const matchingPending = pending.find((item) =>
      item.context.intent === context.intent
      && item.context.attachmentId === context.attachmentId
      && sameBinding(item.context, context)
      && sameContent(item.context, context)
      && item.extension === ext);
    if (matchingPending) {
      const grant = await matchingPending.promise;
      context.assertCurrent?.();
      return grant;
    }
    if (pending.some((item) => item.context.intent === context.intent && item.context.attachmentId === context.attachmentId)) {
      throw invalid('INTENT_REUSED');
    }
    if (entries.size + pending.length >= MAX_ENTRIES || peerCount(context.controllerDeviceId) >= MAX_PER_PEER) throw invalid('QUOTA');
    if (totalBytes() + context.size > MAX_BYTES) throw invalid('QUOTA');

    const pendingItem: PendingPrepare = {
      context: { ...context },
      extension: ext,
      promise: Promise.resolve(undefined as unknown as BotGroupAttachmentUploadGrant),
    };
    pendingItem.promise = (async () => {
      const response = await presign(context.size, ext, context.mimeType);
      let entry: Entry | undefined;
      try {
        // This is the second authorization check: a revoke/account switch while
        // the server was issuing the URL must not leave a usable registry entry.
        context.assertCurrent?.();
        if (!response || typeof response.putUrl !== 'string' || response.putUrl.length === 0 || response.putUrl.length > 16_384
          || typeof response.key !== 'string' || response.key.length === 0 || response.key.length > 4_096
          || typeof response.expiresAt !== 'string') {
          throw invalid('PRESIGN_INVALID');
        }
        const responseExpiry = expiresAtMs(response.expiresAt);
        const current = now();
        if (responseExpiry === null || responseExpiry <= current) throw invalid('PRESIGN_EXPIRED');
        const expires = Math.min(responseExpiry, current + ttl);
        entry = {
          receipt: randomBytes(32).toString('base64url'),
          hostInstanceId, context: { ...context }, extension: ext, presigned: response, expiresAtMs: expires,
          state: 'prepared', expired: false, cleanupAttempts: 0, timer: setTimeout(() => undefined, 1),
        };
        entries.set(entry.receipt, entry);
        scheduleExpiry(entry);
        const grant = {
          receipt: entry.receipt, putUrl: response.putUrl, expiresAt: new Date(expires).toISOString(),
          attachmentId: context.attachmentId, intent: context.intent, size: context.size,
          sha256: context.sha256, mimeType: context.mimeType,
        };
        // The server key/URL stays process-local after this check; only the
        // opaque receipt and PUT URL are returned to the issuing peer.
        context.assertCurrent?.();
        return grant;
      } catch (error) {
        if (entry) removeEntry(entry);
        if (response && typeof response.key === 'string' && response.key.length > 0 && response.key.length <= 4_096) {
          await release(response.key).catch(() => undefined);
        }
        throw error;
      }
    })();
    pending.push(pendingItem);
    try {
      return await pendingItem.promise;
    } finally {
      const index = pending.indexOf(pendingItem);
      if (index >= 0) pending.splice(index, 1);
    }
  };

  const find = (receipt: string, context: BotGroupAttachmentUploadContext, allowExpiredCleanup = false): Entry => {
    if (!receipt || receipt.length > 256) throw invalid('INVALID_RECEIPT');
    const entry = entries.get(receipt);
    if (!entry || entry.hostInstanceId !== hostInstanceId) throw invalid('RECEIPT_EXPIRED');
    // Binding must be checked before expiry cleanup so a wrong peer/owner can
    // never trigger deletion of another controller's relay object.
    if (!sameBinding(entry.context, context) || !sameContent(entry.context, context)) throw invalid('RECEIPT_BINDING');
    context.assertCurrent?.();
    if (now() >= entry.expiresAtMs) {
      if (entry.state === 'in-flight') entry.expired = true;
      else expirePrepared(entry);
      if (!allowExpiredCleanup) throw invalid('RECEIPT_EXPIRED');
    }
    if (entry.expired || entry.state === 'expired' || entry.state === 'committed') {
      if (allowExpiredCleanup && entry.state === 'expired') return entry;
      throw invalid('RECEIPT_EXPIRED');
    }
    return entry;
  };

  const consume = async (receipt: string, context: BotGroupAttachmentUploadContext): Promise<BotGroupAttachmentUploadLease> => {
    const entry = find(receipt, context);
    if (entry.state === 'in-flight') throw invalid('IN_FLIGHT');
    entry.state = 'in-flight';
    const ref: RemoteAttachment = {
      ossKey: entry.presigned.key, mimeType: entry.context.mimeType, originalName: entry.context.attachmentId,
      size: entry.context.size, sha256: entry.context.sha256,
    };
    let settled = false;
    return {
      ref,
      commit: async () => {
        if (settled) return;
        settled = true;
        entry.state = 'committed';
        removeEntry(entry);
        // Message/refs are already durable at this point. Relay deletion is
        // best-effort and retained for a bounded retry; it cannot reject the
        // caller or trigger a resend.
        queuePendingCleanup(entry.receipt, entry.presigned.key);
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        if (entries.get(entry.receipt) !== entry) return;
        if (entry.expired || now() >= entry.expiresAtMs) {
          entry.expired = true;
          entry.state = 'expired';
          clearTimeout(entry.timer);
          void attemptEntryCleanup(entry).catch(() => undefined);
          return;
        }
        entry.state = 'prepared';
        entry.expired = false;
        scheduleExpiry(entry);
      },
    };
  };

  const cancel = async (receipt: string, context: BotGroupAttachmentUploadContext): Promise<void> => {
    const entry = find(receipt, context, true);
    if (entry.state === 'expired') {
      // A failed remote delete leaves this same-bound receipt as a retryable
      // cleanup record, never as a reusable upload authorization.
      await attemptEntryCleanup(entry);
      return;
    }
    if (entry.state !== 'prepared') throw invalid('NOT_CANCELABLE');
    expirePrepared(entry);
    await attemptEntryCleanup(entry);
  };

  return {
    hostInstanceId, prepare, consume, cancel, size: () => entries.size,
    pendingCleanupSize: () => pendingCleanup.size, retryPendingCleanup,
  };
}

export type BotGroupAttachmentUploadRegistry = ReturnType<typeof createBotGroupAttachmentUploadRegistry>;
