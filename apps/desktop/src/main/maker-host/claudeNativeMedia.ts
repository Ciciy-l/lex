import { createHash } from 'node:crypto';
import type { AgentNativeMediaResolver } from '@cindy/maker-core';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { resolveSafe } from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { hasRef, withSessionMediaRefLock } from '../cindy-media/ledger.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Capture one task and account, never a renderer path or the next active account. */
export function createClaudeNativeMediaImporter(context: {
  sessionId: string;
  nativeSessionId: string;
  isCurrent(): boolean;
}): AgentNativeMediaResolver {
  const owner = { ...getActiveAppSession() };
  const { sessionId, nativeSessionId, isCurrent } = context;
  const client = getCurrentDbClientSnapshot();
  if (!client || !sessionId || !nativeSessionId || !isCurrent() || isAppSessionBoundaryPending()) {
    throw new Error('Native media task is unavailable');
  }
  const db = client.client.drizzle;
  const compensation = captureMediaRefCompensationScope();
  return async input => {
    const assertCurrent = () => {
      const current = getActiveAppSession();
      if (input.signal.aborted || input.sessionId !== nativeSessionId || !input.messageId
        || !isCurrent() || isAppSessionBoundaryPending() || client !== getCurrentDbClientSnapshot()
        || current.dataOwnerId !== owner.dataOwnerId || current.generation !== owner.generation) {
        throw new Error('Native media task changed');
      }
    };
    assertCurrent();
    const raw = input.block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null;
    const source = raw?.source;
    // The native composer already resolved its own source. Import only supplied
    // image bytes; never fetch a URL or read a native/SSH path on the desktop.
    if (raw?.type !== 'image' || source?.type !== 'base64' || typeof source.data !== 'string'
      || source.data.length === 0 || source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || source.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(source.data)) {
      throw new Error('Native attachment requires supported image bytes');
    }
    const buffer = Buffer.from(source.data, 'base64');
    const mimeType = sniffMediaMime(buffer);
    if (!mimeType || !IMAGE_TYPES.has(mimeType) || source.media_type !== mimeType
      || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== source.data) {
      throw new Error('Native image content does not match its type');
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    const reference = { refKind: 'session-attachment' as const, refId: sessionId };
    return withSessionMediaRefLock(db, sessionId, async () => {
      assertCurrent();
      const exists = await hasRef({ hash, ...reference }, db);
      assertCurrent();
      // Pin supplied bytes before admission/history can await other work. Keep
      // them for the task lifetime even if that input is subsequently refused.
      // This avoids an unreferenced draft window during media reclamation.
      const stored = await ingestMedia({ buffer, mimeType, isCache: false,
        refs: exists ? [] : [{ ...reference, originSessionId: sessionId, originKind: 'user' }],
        assertStillValid: assertCurrent, refCompensationScope: compensation,
      }, db);
      assertCurrent();
      const resolved = resolveSafe(stored.url);
      return { type: 'image', path: resolved.absPath, managedUrl: stored.url, mimeType, pathOrigin: 'desktop-host' };
    });
  };
}
