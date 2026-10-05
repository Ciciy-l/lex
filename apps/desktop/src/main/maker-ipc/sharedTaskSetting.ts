import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * Structural view of the shared-task capture. Keeping this small avoids making
 * local runtime selection depend on the later shared-task module at build time.
 * The full host supplies these fields when a shared-task phase is enabled.
 */
type SharedTaskPeerCapture = {
  author: { sessionId: string };
  isCurrent(): boolean;
  authorize(operation: string): boolean;
};

/** One native setting transaction. Revocation fences admission, not its rollback. */
export function createSharedTaskSettingGuard(
  sharedTask: SharedTaskPeerCapture | undefined,
  sessionId: string,
  transaction: { admitted: boolean },
) {
  const assertCurrent = () => {
    if (!transaction.admitted && sharedTask && (sharedTask.author.sessionId !== sessionId ||
        !sharedTask.isCurrent() || !sharedTask.authorize('agent.configure'))) {
      throwIpcError('PERMISSION_DENIED', 'SharedTask task access denied');
    }
  };
  return Object.assign(assertCurrent, {
    admit() { assertCurrent(); transaction.admitted = true; },
  });
}
