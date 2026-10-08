import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseBlobUrl } from '../cindy-media/blobStore.js';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
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

/**
 * Legacy generated-media URLs are authorized only as complete host-authored
 * tokens.  SQL's instr() is only a cheap candidate filter; these checks must
 * reject a URL used as the prefix of a longer URL and must not mistake the
 * letters t/r/n from an escaped whitespace literal for delimiters.
 */
function containsExactLegacyMediaUrl(content: string, url: string): boolean {
  const punctuationBoundaries = new Set(['\"', "'", '<', '>', '(', ')', '[', ']', '{', '}']);
  const isUrlContinuation = (char: string | undefined): boolean =>
    char !== undefined && /[A-Za-z0-9._~:/?#[\]@!$&'*+=%-]/u.test(char);
  const isTokenBoundary = (char: string | undefined): boolean =>
    char === undefined || /\s/u.test(char) || punctuationBoundaries.has(char) || char === '\\';
  let offset = 0;
  while (offset <= content.length - url.length) {
    const index = content.indexOf(url, offset);
    if (index < 0) return false;
    const previous = index > 0 ? content[index - 1] : undefined;
    const next = content[index + url.length];
    if (!isUrlContinuation(previous) && !isUrlContinuation(next) &&
        isTokenBoundary(previous) && isTokenBoundary(next)) return true;
    offset = index + Math.max(1, url.length);
  }
  return false;
}

function readDbSnapshot(): ReturnType<typeof getCurrentDbClientSnapshot> {
  return getCurrentDbClientSnapshot();
}

function captureDb(): SharedTaskMediaCaptureContext {
  const snapshot = readDbSnapshot();
  if (!snapshot) deny();
  return {
    db: snapshot.client,
    userId: snapshot.userId,
    clientEpoch: snapshot.clientEpoch,
  };
}

function assertCaptureCurrent(capture: SharedTaskPeerCapture, context: SharedTaskMediaCaptureContext): void {
  if (!capture.isCurrent() || !capture.authorize('attachment.read')) deny();
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
    const readable = await sessionCanRead(blob.hash, sessionId, context.db.drizzle);
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
    const present = rows.some((row) => containsExactLegacyMediaUrl(row.content, url));
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
