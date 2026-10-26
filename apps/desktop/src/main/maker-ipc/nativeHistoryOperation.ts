import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

/** One owner-scoped task journal, including aliases of its physical directory.
 * Refuse an overlapping operation; never queue a second native mutation. */
export async function withNativeHistoryOperation<T>(root: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(root) || !sessionId) throw new Error('Invalid native history owner');
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, createHash('sha256').update(sessionId).digest('hex') + '.lock');
  return withCrossProcessLock(lockPath, { label: 'native-history', waitMs: 0 }, async lock => {
    if (!lock.held) throw new Error('Native history is busy in another operation');
    return operation();
  });
}
