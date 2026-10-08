import type { AgentInputCreateOpts, AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';
import {
  assertSharedTaskReferences, captureSharedTaskPeer, sharedTaskOwnedQueueReferences,
  sharedTaskScopedClientId,
} from '../device-link/sharedTaskDispatch.js';
import { sharedTaskGuestPeer } from '@cindy/device-link';

/** Build privileged input configuration from host truth, not guest queue snapshots. */
export function stampSharedTaskInput(
  item: AgentInputQueuedMessage, capture: SharedTaskPeerCapture | undefined,
  task: AgentInputCreateOpts | undefined,
): AgentInputQueuedMessage {
  const stamped = { ...item };
  delete stamped.sharedTaskAuthor;
  if (!capture) return stamped;
  if (!task || !capture.isCurrent() || !capture.authorize('input.send')) {
    throw new Error('[PERMISSION_DENIED] SharedTask task access denied');
  }
  assertSharedTaskReferences(item, capture.author.sessionId, 0, capture.author.sharedTaskId, sharedTaskOwnedQueueReferences(capture, item.clientId), {
    attachmentVerifier: capture.verifyAttachment,
    attachmentBinding: {
      sharedTaskId: capture.author.sharedTaskId,
      sessionId: capture.author.sessionId,
      memberId: capture.author.memberId,
      accountId: capture.author.accountId,
      deviceId: capture.author.deviceId,
    },
  });
  // Only content comes from the guest. The task owns runtime/bootstrap settings.
  stamped.createOpts = { ...task };
  // The wire clientId is a controller-local value. Keep the same value
  // idempotent for one member, but scope the host queue/message identity so
  // another guest choosing the same clientId cannot deduplicate or edit it.
  const wireClientId = item.clientId;
  const scopedClientId = sharedTaskScopedClientId(capture, wireClientId);
  stamped.sharedTaskWireClientId = wireClientId;
  stamped.clientId = scopedClientId;
  stamped.chatMessage = { ...stamped.chatMessage, clientId: scopedClientId };
  stamped.workingDir = task.workingDir;
  stamped.permissionMode = task.permissionMode ?? 'ask';
  stamped.model = task.model;
  stamped.effort = task.effort ?? '';
  // These values are host lifecycle/provenance controls, not guest input.
  // Leaving any of them on a queued item would let a controller manufacture
  // recovery/ack semantics after the host has admitted ordinary content.
  delete stamped.autoReviewUserText;
  // durableDelivery is an accepted host protocol request, not untrusted
  // provenance. requireQueuedMessage already normalizes it to the sole
  // supported literal true; preserve it so the durable queue receipt and
  // ACK-loss reconciliation remain active for shared tasks.
  delete stamped.originalSyntheticTrigger;
  delete stamped.fromMobileClient;
  delete stamped.fromDeviceLinkClient;
  delete stamped.supersedesUserClientId;
  delete stamped.vendorOptions;
  delete stamped.origin;
  delete stamped.autoResume;
  delete stamped.autoResumeInfo;
  delete stamped.recoveryCheckpoint;
  delete stamped.bypassGhostHooks;
  delete stamped.hostAcceptedAtMs;
  stamped.sharedTaskAuthor = { ...capture.author };
  stamped.userName = capture.author.displayName;
  return stamped;
}

/** Run inside the synchronous queue mutation, after all asynchronous preparation. */
export function assertSharedTaskQueueMutation(
  capture: SharedTaskPeerCapture | undefined, sessionId: string,
  operation: 'input.send' | 'input.edit' | 'input.withdraw' | 'agent.stop',
  item?: AgentInputQueuedMessage,
): void {
  if (!capture) return;
  const author = item?.sharedTaskAuthor;
  if (capture.author.sessionId !== sessionId || !capture.isCurrent() ||
      (operation === 'input.edit' || operation === 'input.withdraw') &&
      (!author || author.sharedTaskId !== capture.author.sharedTaskId || author.memberId !== capture.author.memberId) ||
      !capture.authorize(operation, item ? {
        sessionId, authorAccountId: author?.accountId ?? '', state: 'pending',
      } : undefined)) {
    throw new Error('[PERMISSION_DENIED] SharedTask task access denied');
  }
}

/**
 * Queue draining happens after the invoke AsyncLocalStorage scope has ended.
 * Reconstruct the host-authenticated scoped peer from the stamped item and
 * fence the final pre-vendor boundary so a revoked guest turn cannot execute
 * merely because it was admitted before revocation.
 */
export function assertSharedTaskQueuedInputCurrent(
  sessionId: string, item: AgentInputQueuedMessage,
): void {
  const author = item.sharedTaskAuthor;
  if (!author) return;
  if (author.sessionId !== sessionId || typeof author.deviceId !== 'string' ||
      author.deviceId.length === 0) {
    throw new Error('[PERMISSION_DENIED] SharedTask task access denied');
  }
  let peer: string;
  try {
    peer = sharedTaskGuestPeer(author.sharedTaskId, author.memberId, author.deviceId);
  } catch {
    throw new Error('[PERMISSION_DENIED] SharedTask task access denied');
  }
  const capture = captureSharedTaskPeer(peer);
  if (!capture || capture.author.sessionId !== sessionId ||
      capture.author.memberId !== author.memberId ||
      capture.author.accountId !== author.accountId ||
      !capture.isCurrent() || !capture.authorize('input.send')) {
    throw new Error('[PERMISSION_DENIED] SharedTask task access denied');
  }
}
