/** Native fixtures must fail on every Host operation outside their declared flow. */
const unavailable = (): never => { throw new Error('Unexpected native fixture Host operation'); };
export const unsupportedOrcaService = {
  resumeWorkerSession: unavailable, markWorkerIdleIfStatus: unavailable, restoreWorkerDoneIfIdle: unavailable,
  cancelWorkerSessionOperations: unavailable, closeWorkerSession: unavailable, closeWorkerSessionIfIdle: unavailable,
  withSessionSendLock: unavailable, archiveWorkerSession: unavailable, getSessionQueueSnapshot: unavailable,
  ensureWorkerQueueRestored: unavailable, removeQueuedMessage: unavailable, replaceQueuedMessage: unavailable,
  steerStoredQueuedMessage: unavailable, moveQueuedMessage: unavailable, mergeQueuedMessages: unavailable,
};
