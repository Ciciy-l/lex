import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseBlobUrl } from '../cindy-media/blobStore.js';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import * as currentDb from '../localDb/client/current.js';
import { getDbClient } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import type { SharedTaskPeerCapture } from './sharedTaskDispatch.js';

export interface SharedTaskMediaCaptureContext {
  /** The exact profile-bound client used by every history/ledger/fs query. */
  readonly db: DbClient;
  readonly userId: string;
  readonly clientEpoch: number;
  readonly localRoot?: string;
  readonly localPath?: string;
  readonly sshOrigin?: { remoteHostId: string; workdir: string };
}
function deny(): never { throw new Error('[PERMISSION_DENIED] Media does not belong to this shared task'); }

function readDbSnapshot(): ReturnType<typeof currentDb.getCurrentDbClientSnapshot> | null {
  try {
    return currentDb.getCurrentDbClientSnapshot?.() ?? null;
  } catch {
    // Older isolated fixtures mock only getDbClient; production exports the
    // snapshot helper and therefore takes the strict identity path.
    return null;
  }
}

function captureDb(): SharedTaskMediaCaptureContext {
  const snapshot = readDbSnapshot();
  // Test-only/legacy callers can run before the profile snapshot helper is
  // available. Production always has a snapshot, and only that path gets the
  // strict owner/epoch comparison below.
  const db = snapshot?.client ?? getDbClient();
  return {
    db,
    userId: snapshot?.userId ?? '',
    clientEpoch: snapshot?.clientEpoch ?? -1,
  };
}

function assertCaptureCurrent(capture: SharedTaskPeerCapture, context: SharedTaskMediaCaptureContext): void {
  if (!capture.isCurrent() || !capture.authorize('attachment.read')) deny();
  if (context.clientEpoch < 0) return;
  const now = readDbSnapshot();
  if (!now || now.client !== context.db || now.userId !== context.userId || now.clientEpoch !== context.clientEpoch) deny();
}

/** Run before any local read/SSH transfer, and recheck membership after awaits. */
export async function assertSharedTaskMedia(
  url: string,
  capture: SharedTaskPeerCapture,
  existingContext?: SharedTaskMediaCaptureContext,
): Promise<SharedTaskMediaCaptureContext> {
  const context = existingContext ?? captureDb();
  assertCaptureCurrent(capture, context);
  const sessionId = capture.author.sessionId;
  const blob = parseBlobUrl(url);
  if (blob) {
    const readable = context.db.drizzle
      ? await sessionCanRead(blob.hash, sessionId, context.db.drizzle)
      : await sessionCanRead(blob.hash, sessionId);
    assertCaptureCurrent(capture, context);
    if (!readable) deny();
    return context;
  }
  const parsed = new URL(url);
  // Frozen legacy per-task cache, still resolved by the existing safe resolver.
  if (parsed.protocol === 'xdt-image:' && decodeURIComponent(parsed.hostname) === sessionId) return context;
  if (parsed.protocol === 'xdt-video:' || parsed.protocol === 'xdt-image:') {
    // Older generated caches predate the media ledger and use global hosts.
    // Only a complete URL already emitted into this task's host-authored history
    // grants access; guest/user text is not evidence of cache ownership.
    const rows = await context.db.query<{ content: string }>(
      "SELECT content FROM messages WHERE session_id = ? AND role IN ('assistant', 'tool_use', 'tool_result') AND instr(content, ?) > 0",
      [sessionId, url],
    );
    assertCaptureCurrent(capture, context);
    const present = rows.some((row) => {
      const index = row.content.indexOf(url);
      if (index < 0) return false;
      const next = row.content[index + url.length];
      return next === undefined || [... ' \\t\\r\\n\"\'<> {}()[]\\\\'].includes(next);
    });
    if (!present) deny();
    return context;
  }
  if (!['xdt-file:', 'xdt-audio:'].includes(parsed.protocol)) deny();

  const snapshot = await getSessionFsSnapshot(sessionId, context.db);
  assertCaptureCurrent(capture, context);
  if (!snapshot?.workingDir) deny();
  if (snapshot.remoteHostId) {
    if (parsed.searchParams.get('sessionId') !== sessionId ||
        parsed.searchParams.get('remoteHostId') !== snapshot.remoteHostId ||
        parsed.searchParams.get('workdir') !== snapshot.workingDir) deny();
    return {
      ...context,
      sshOrigin: { remoteHostId: snapshot.remoteHostId, workdir: snapshot.workingDir },
    };
  }
  if (parsed.searchParams.has('remoteHostId')) deny();
  const requested = parsed.searchParams.get('path');
  if (!requested || !path.isAbsolute(requested)) deny();
  const [file, root] = await Promise.all([realpath(requested), realpath(snapshot.workingDir)]);
  assertCaptureCurrent(capture, context);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) deny();
  if (existingContext?.localPath && existingContext.localPath !== file) deny();
  return { ...context, localRoot: root, localPath: file };
}
