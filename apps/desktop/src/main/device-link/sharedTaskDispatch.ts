import { createHash } from 'node:crypto';
import { isSharedTaskPeer, parseSharedTaskPeer, isSharedTaskAttachment, type InvokePayload, type InvokeResultPayload, type SharedTaskQueueItem } from '@cindy/device-link';
import type { SharedTaskHost } from './sharedTaskHost.js';

export type SharedTaskPeerCapture = NonNullable<ReturnType<SharedTaskHost['capturePeer']>>;
export interface SharedTaskInteractionCapture {
  sessionId: string;
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  toolName?: string;
  suggestions?: unknown[];
}

/**
 * A parser result is only a shape check. A raw OSS attachment becomes usable
 * by a shared-task guest only when the host has a verifier for the
 * authenticated server binding that issued it. The binding is explicit so a
 * future server adapter cannot verify only the OSS key/prefix or a renderer
 * supplied member id.
 */
export interface SharedTaskAttachmentBinding {
  sharedTaskId: string;
  sessionId: string;
  memberId: string;
  accountId: string;
  deviceId: string;
}
export type SharedTaskAttachmentVerifier = (
  value: string,
  binding: SharedTaskAttachmentBinding,
) => boolean;
let host: SharedTaskHost | null = null;
let readQueueItem: ((sessionId: string, clientId: string) => (SharedTaskQueueItem & { attachments?: unknown }) | undefined) | null = null;
let readInteractionSession: ((requestId: string) => SharedTaskInteractionCapture | undefined) | null = null;
export function setSharedTaskQueueReader(value: typeof readQueueItem): void { readQueueItem = value; }
export function setSharedTaskInteractionReader(value: typeof readInteractionSession): void { readInteractionSession = value; }
export function setSharedTaskDispatchHost(value: SharedTaskHost | null): void { host = value; }
export function captureSharedTaskPeer(source: string): SharedTaskPeerCapture | null {
  return host?.capturePeer(source) ?? null;
}

/**
 * Claim a pending interaction at the host's one-shot consumption boundary.
 * The caller performs its capture/decision checks immediately before calling
 * this helper; deleting from the authoritative map is synchronous, so two
 * guests racing the same card cannot both consume it. A failed claim is not a
 * retry signal and must not invoke the agent resolver a second time.
 */
export function claimSharedTaskInteraction<T>(pending: Map<string, T>, requestId: string): T | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  pending.delete(requestId);
  return entry;
}

/** Only confirmed membership loss may evict a guest's shared task on the client. */
export function sharedTaskAccessFailure(source: string, capture?: SharedTaskPeerCapture | null): InvokeResultPayload {
  const status = host?.peerStatus(source) ?? 'unavailable';
  if (status === 'revoked') return { ok: false, error: { code: 'ACCESS_REVOKED', message: 'Shared task access revoked' } };
  if (status === 'unavailable' || !capture?.isCurrent()) {
    return { ok: false, error: { code: 'NOT_CONNECTED', message: 'Shared task authority changed or is temporarily unavailable' } };
  }
  return { ok: false, error: { code: 'IPC_ERROR', message: '[PERMISSION_DENIED] Shared task request denied' } };
}

// These existing list events also carry single-task state. Shared peers receive
// only this explicit subset through their task subscription, never `sessions`.
const sessionMetadataChannels = new Set([
  'local-db:sessions:created', 'local-db:sessions:patched', 'local-db:sessions:activity',
  'local-db:session:error-persisted', 'usage:session-spend-changed', 'usage:session-tokens-changed',
]);
export function sharedTaskMetadataTopic(channel: string, payload: unknown): `session:${string}` | null {
  const sessionId = record(payload)?.sessionId;
  return sessionMetadataChannels.has(channel) && typeof sessionId === 'string' && sessionId.length > 0
    ? `session:${sessionId}` : null;
}

/** A newly invited device can arrive before the periodic authority refresh. */
export async function refreshSharedTaskPeer(source: string): Promise<void> {
  const peer = parseSharedTaskPeer(source);
  const capturedHost = host;
  if (!peer || peer.role !== 'guest' || !capturedHost) throw new Error('Shared task host unavailable');
  await capturedHost.refresh(peer.sharedTaskId);
  if (host !== capturedHost) throw new Error('Shared task host changed');
}

// Deliberately separate from the same-account allowlist: adding a full-device
// channel must never implicitly grant that capability to sharedTask guests.
const sessionReads = new Set([
  'local-db:sessions:get', 'local-db:messages:list', 'local-db:messages:view',
  'local-db:messages:view-intent', 'local-db:messages:work-details',
  'local-db:messages:around', 'local-db:messages:around-client-id',
  'local-db:messages:estimatedSessionValue', 'maker:input:get-projection',
  'maker:session-in-turn', 'maker:session-background-activity',
  'maker:session-background-tasks:list', 'maker:background-task:output-tail', 'maker:get-context-usage',
  'maker:get-pending-interactions', 'maker:get-session-agent-switch-intent',
]);
const inputEdits = new Set([
  'maker:input:update-text',
  'maker:input:update-content',
  'maker:input:move',
  'maker:input:set-edit-lock',
]);
const inputSends = new Set([
  'maker:input:enqueue',
  'maker:input:steer',
  'maker:input:resume',
  'maker:input:retry-last-error',
  'maker:input:set-expanded',
]);
const agentSettings = new Set(['maker:set-model', 'maker:set-effort', 'maker:set-fast-mode', 'maker:set-thinking-enabled', 'maker:switch-session-agent']);
const interactionDecisionKinds = new Set(['permission', 'ask_user_question', 'plan_review']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function deny(): never { throw new Error('[PERMISSION_DENIED] SharedTask task access denied'); }

function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function isSafeSessionPermissionUpdate(value: unknown, toolName: string): boolean {
  const update = record(value);
  if (!update || update.destination !== 'session') return false;
  if (update.type === 'codexSessionApproval') {
    return Object.keys(update).every((key) => key === 'type' || key === 'destination');
  }
  if (update.type !== 'addRules' || update.behavior !== 'allow' ||
      Object.keys(update).some((key) => !['type', 'behavior', 'destination', 'rules'].includes(key)) ||
      !Array.isArray(update.rules) || update.rules.length === 0) return false;
  return update.rules.every((rawRule) => {
    const rule = record(rawRule);
    return !!rule && typeof rule.toolName === 'string' && rule.toolName === toolName &&
      Object.keys(rule).every((key) => key === 'toolName' || key === 'ruleContent') &&
      (rule.ruleContent === undefined || typeof rule.ruleContent === 'string');
  });
}

function assertSharedTaskPermissionUpdates(
  decision: Record<string, unknown>, interaction: SharedTaskInteractionCapture,
): void {
  if (decision.permissionUpdates === undefined) return;
  if (interaction.kind !== 'permission' || !interaction.toolName ||
      !Array.isArray(decision.permissionUpdates) || decision.permissionUpdates.length === 0 ||
      !Array.isArray(interaction.suggestions)) deny();
  for (const update of decision.permissionUpdates) {
    if (!isSafeSessionPermissionUpdate(update, interaction.toolName) ||
        !interaction.suggestions.some((suggestion) => sameJson(update, suggestion))) deny();
  }
}

/** Shared-task guests may answer the generic Agent interaction cards. Host-only
 * confirmations (plugin setup, issue review, grants, and rename prompts) never
 * enter this branch and remain protected by the normal origin gate. */
function assertSharedTaskInteractionResolve(
  capture: SharedTaskPeerCapture, args: unknown[], sessionId: string,
  phase: 'invoke' | 'result',
): void {
  if (args.length !== 2 || typeof args[0] !== 'string' || !args[0]) deny();
  const interaction = phase === 'invoke' ? readInteractionSession?.(args[0]) : undefined;
  if (phase === 'invoke' && (!interaction || interaction.sessionId !== sessionId)) deny();
  const decision = record(args[1]);
  if (!decision || typeof decision.kind !== 'string' || !interactionDecisionKinds.has(decision.kind)) deny();
  // Guests approve the host-displayed input, never substitute executable input.
  if (decision.updatedInput !== undefined) deny();
  if (phase === 'invoke' && interaction?.kind !== decision.kind) deny();
  if (decision.kind === 'permission' || decision.kind === 'plan_review') {
    if (decision.behavior !== 'allow' && decision.behavior !== 'deny') deny();
  } else if (!record(decision.answers)) {
    deny();
  }
  if (phase === 'invoke' && interaction) assertSharedTaskPermissionUpdates(decision, interaction);
  if (!capture.authorize('approval.resolve')) deny();
}

/** Re-run the shared-task gate immediately before a pending decision is consumed. */
export function assertSharedTaskInteractionResolveCurrent(
  capture: SharedTaskPeerCapture, args: unknown[],
): void {
  assertSharedTaskInteractionResolve(capture, args, capture.author.sessionId, 'invoke');
}

/** Existing attachments can survive a text edit without being re-uploaded. The
 * set comes exclusively from this member's current host-owned pending row. */
export function sharedTaskOwnedQueueReferences(capture: SharedTaskPeerCapture, clientId: unknown): ReadonlySet<string> {
  const result = new Set<string>();
  const ids = typeof clientId === 'string'
    ? [sharedTaskScopedClientId(capture, clientId), clientId]
    : [];
  const item = ids.map((id) => readQueueItem?.(capture.author.sessionId, id)).find(Boolean);
  if (!item || !capture.authorize('input.edit', item)) return result;
  if (Array.isArray(item.attachments)) for (const file of item.attachments) {
    const row = record(file);
    for (const key of ['path', 'url']) if (typeof row?.[key] === 'string') result.add(row[key] as string);
  }
  return result;
}

/** Resolve the host-owned pending row for either the wire id or its scoped id. */
function sharedTaskQueueItem(capture: SharedTaskPeerCapture, clientId: unknown): SharedTaskQueueItem | undefined {
  if (typeof clientId !== 'string') return undefined;
  const scoped = sharedTaskScopedClientId(capture, clientId);
  return readQueueItem?.(capture.author.sessionId, scoped)
    ?? (scoped === clientId ? undefined : readQueueItem?.(capture.author.sessionId, clientId));
}

/** Queue/durable-delivery identity is local to the task member. */
export function sharedTaskScopedClientId(capture: SharedTaskPeerCapture, clientId: string): string {
  if (/^shared-task:[0-9a-f]{64}$/.test(clientId)) return clientId;
  const scope = [
    capture.author.sharedTaskId,
    capture.author.sessionId,
    capture.author.memberId,
    capture.author.accountId,
    clientId,
  ].join(String.fromCharCode(0));
  const digest = createHash('sha256').update(scope).digest('hex');
  return 'shared-task:' + digest;
}

/**
 * A controller keeps its stable raw clientId.  The host queue uses a scoped
 * receipt instead, so two guests may intentionally choose the same raw id.
 * Normalize only the local IPC arguments; request fingerprints and wire ACKs
 * continue to use the raw payload and therefore retain normal retry semantics.
 */
export function normalizeSharedTaskInvokeArgs(
  capture: SharedTaskPeerCapture,
  channel: string,
  args: readonly unknown[],
): unknown[] {
  if (args[0] !== capture.author.sessionId) return [...args];
  const next = [...args];
  const mapId = (value: unknown): unknown =>
    typeof value === 'string' ? sharedTaskScopedClientId(capture, value) : value;
  const mapItem = (value: unknown): unknown => {
    const item = record(value);
    if (!item || typeof item.clientId !== 'string') return value;
    const clientId = sharedTaskScopedClientId(capture, item.clientId);
    const chatMessage = record(item.chatMessage);
    return {
      ...item,
      clientId,
      sharedTaskWireClientId: item.sharedTaskWireClientId ?? (clientId === item.clientId ? undefined : item.clientId),
      ...(chatMessage ? { chatMessage: { ...chatMessage, clientId } } : {}),
    };
  };
  if (channel === 'maker:input:update-content') {
    next[1] = mapId(next[1]);
    next[2] = mapItem(next[2]);
  } else if (
    channel === 'maker:input:update-text' ||
    channel === 'maker:input:move' ||
    channel === 'maker:input:set-edit-lock' ||
    channel === 'maker:input:remove'
  ) {
    next[1] = mapId(next[1]);
  } else if (channel === 'maker:input:get-projection') {
    const options = record(next[1]);
    const deliveryClientIds = options?.deliveryClientIds;
    if (Array.isArray(deliveryClientIds)) {
      next[1] = {
        ...options,
        deliveryClientIds: deliveryClientIds.map(mapId),
      };
    }
  }
  return next;
}

/**
 * Restore only controller-facing delivery ids after a shared-task IPC handler
 * has operated on scoped ids.  The host queue/database never receives the raw
 * id, while the wire ACK/reconcile contract remains stable across retries.
 */
export function restoreSharedTaskProjectionResult(
  channel: string,
  result: unknown,
  wireArgs: readonly unknown[],
  localArgs: readonly unknown[],
  capture?: SharedTaskPeerCapture,
): unknown {
  const projectionChannels = new Set([
    'maker:input:get-projection', 'maker:input:enqueue', 'maker:input:steer',
    'maker:input:stop', 'maker:input:resume', 'maker:input:retry-last-error',
    'maker:input:remove', 'maker:input:update-text', 'maker:input:update-content',
    'maker:input:move', 'maker:input:set-expanded', 'maker:input:set-edit-lock',
  ]);
  if (!projectionChannels.has(channel) || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const wireOptions = record(wireArgs[1]);
  const localOptions = record(localArgs[1]);
  let wireIds = Array.isArray(wireOptions?.deliveryClientIds)
    ? wireOptions.deliveryClientIds.filter((id): id is string => typeof id === 'string')
    : [];
  let localIds = Array.isArray(localOptions?.deliveryClientIds)
    ? localOptions.deliveryClientIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (wireIds.length === 0 && localIds.length === 0 && capture &&
      (channel === 'maker:input:enqueue' || channel === 'maker:input:steer')) {
    const rawItem = record(wireArgs[1]);
    if (typeof rawItem?.clientId === 'string') {
      wireIds = [rawItem.clientId];
      localIds = [sharedTaskScopedClientId(capture, rawItem.clientId)];
    }
  }
  const projection = result as Record<string, unknown>;
  if (!Array.isArray(projection.deliveryReceipts) || wireIds.length !== localIds.length) return result;
  const byLocalId = new Map(localIds.map((id, index) => [id, wireIds[index]]));
  const receipts = projection.deliveryReceipts.map((receipt: unknown) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return receipt;
    const row = receipt as Record<string, unknown>;
    const wireId = typeof row.clientId === 'string' ? byLocalId.get(row.clientId) : undefined;
    return wireId ? { ...row, clientId: wireId } : row;
  });
  return { ...projection, deliveryReceipts: receipts };
}

interface SharedTaskReferenceOptions {
  attachmentVerifier?: SharedTaskAttachmentVerifier;
  attachmentBinding?: SharedTaskAttachmentBinding;
}

/** Input reference metadata is consumed before Agent execution, under host authority. */
export function assertSharedTaskReferences(
  value: unknown,
  sessionId: string,
  depth = 0,
  sharedTaskId?: string,
  existing: ReadonlySet<string> = new Set(),
  options?: SharedTaskReferenceOptions,
): void {
  if (depth > 32) deny();
  if (Array.isArray(value)) {
    for (const child of value) assertSharedTaskReferences(child, sessionId, depth + 1, sharedTaskId, existing, options);
    return;
  }
  const row = record(value);
  if (!row) return;
  for (const [key, child] of Object.entries(row)) {
    if (['sessionId', 'parentSessionId', 'sourceSessionId', 'targetSessionId'].includes(key) && child !== sessionId) deny();
    if (key === 'botId' || key === 'hostSnapshot') deny();
    // Native Agent tools retain normal task permissions; client references are
    // direct host reads and must come from this task's authorized upload area.
    if ((key === 'path' || key === 'url') && child !== undefined && child !== null && child !== '' &&
        !(typeof child === 'string' && existing.has(child))) {
      const isBoundSharedAttachment = typeof child === 'string' &&
        !!sharedTaskId && isSharedTaskAttachment(child, sharedTaskId) &&
        (!options?.attachmentVerifier || !!options.attachmentBinding &&
          options.attachmentVerifier(child, options.attachmentBinding));
      // Task-namespace admission, not proof of uploader/device identity.
      // Current membership is checked above; materialization must still obtain
      // an authenticated server presign-get before reading any object bytes.
      // SharedTask v2 shares uploads within a task (upstream contract).
      if (!isBoundSharedAttachment) deny();
    }
    // Persisted reference chips are another input to host-side hydration.
    if (key === 'persistedContent' && typeof child === 'string') {
      let parsed: unknown;
      try { parsed = JSON.parse(child); } catch { continue; }
      assertSharedTaskReferences(parsed, sessionId, depth + 1, sharedTaskId, existing, options);
    } else if (child && typeof child === 'object') assertSharedTaskReferences(child, sessionId, depth + 1, sharedTaskId, existing, options);
  }
}

/** Validate the actual channel shape; unknown channels fail closed. */
export function assertSharedTaskInvoke(
  capture: SharedTaskPeerCapture, payload: InvokePayload, queueItem?: SharedTaskQueueItem,
  phase: 'invoke' | 'result' = 'invoke',
): void {
  if (!capture.isCurrent()) deny();
  const { channel } = payload;
  const args = payload.args ?? [];
  if (!Array.isArray(args)) deny();
  const sessionId = capture.author.sessionId;
  if (['local-db:subagent-runs:list', 'local-db:subagent-runs:detail', 'local-db:subagent-runs:transcript'].includes(channel)) {
    const request = record(args[0]);
    if (args.length !== 1 || !request || request.sessionId !== sessionId ||
        Object.keys(request).some((key) => !['sessionId', 'provider', 'runIdOrAlias', 'cursor', 'limit'].includes(key)) ||
        !capture.authorize('history.read')) deny();
    assertSharedTaskReferences(request, sessionId);
    return;
  }
  if (channel === 'device-link:media:fetch') {
    const request = record(args[0]);
    if (args.length !== 1 || !request || typeof request.url !== 'string' ||
          Object.keys(request).some((key) => !['url', 'skipCache', 'thumbnail', 'prepareOnly'].includes(key)) ||
        !capture.authorize('attachment.read')) deny();
    // The media handler validates ledger/workdir ownership before reading bytes.
    return;
  }
  // Display-only catalogs used by the existing remote composer. The provider
  // response goes through dispatch's normal credential-free projection.
  if (channel === 'maker:get-capabilities' || channel === 'maker:provider:list') {
    if (args.length > 1 || !capture.authorize('history.read')) deny();
    if (channel === 'maker:get-capabilities' && !['claude-code', 'codex', 'pi', 'omp'].includes(String(args[0]))) deny();
    if (channel === 'maker:provider:list' && args[0] !== undefined) {
      const options = record(args[0]);
      if (!options || Object.keys(options).some((key) => key !== 'capabilities') ||
          !Array.isArray(options.capabilities) || options.capabilities.some((item) => typeof item !== 'string')) deny();
    }
    return;
  }
  if (channel === 'device-link:subscribe' || channel === 'device-link:unsubscribe') {
    const topics = record(args[0])?.topics;
    if (!Array.isArray(topics) || topics.length > 1 || topics.some((topic) => topic !== `session:${sessionId}`)) deny();
    if (!capture.authorize('events.subscribe')) deny();
    return;
  }
  if (channel === 'maker:resolve-interaction') {
    assertSharedTaskInteractionResolve(capture, args, sessionId, phase);
    return;
  }
  if (args[0] !== sessionId) deny();
  const operation = sessionReads.has(channel) ? 'history.read'
    : inputSends.has(channel) ? 'input.send'
    : channel === 'maker:input:stop' ? 'agent.stop'
    : channel === 'maker:input:remove' ? 'input.withdraw'
    : inputEdits.has(channel) ? 'input.edit'
    : agentSettings.has(channel) ? 'agent.configure' : null;
  if (!operation) deny();
  if (phase === 'result') {
    if (!capture.authorize('history.read')) deny();
  } else {
    if (!capture.authorize(operation, queueItem ?? sharedTaskQueueItem(capture, typeof args[1] === 'string'
      ? args[1] : record(args[1])?.clientId))) deny();
    const existing = sharedTaskOwnedQueueReferences(capture, typeof args[1] === 'string' ? args[1] : record(args[1])?.clientId);
    assertSharedTaskReferences(args.slice(1), sessionId, 0, capture.author.sharedTaskId, existing, {
      attachmentVerifier: capture.verifyAttachment,
      attachmentBinding: {
        sharedTaskId: capture.author.sharedTaskId,
        sessionId: capture.author.sessionId,
        memberId: capture.author.memberId,
        accountId: capture.author.accountId,
        deviceId: capture.author.deviceId,
      },
    });
  }
}

/** Synchronous last-mile gate, including batches, delayed pushes and offline replay. */
export function captureSharedTaskPush(source: string, channel: string, payload: unknown): (() => boolean) | null {
  if (!isSharedTaskPeer(source)) return () => true;
  // Turn-change reads/actions are same-account only; do not expose an unusable guest card.
  if (channel === 'maker:turn-change-set:updated') return null;
  const capture = captureSharedTaskPeer(source);
  if (!capture || !capture.authorize('events.subscribe')) return null;
  const sessionId = capture.author.sessionId;
  const row = record(payload);
  if (row?.sessionId !== sessionId) return null;
  // Never forward a device/account projection just because it has a sessionId.
  if (!(channel.startsWith('maker:') || channel.startsWith('local-db:messages:') ||
      sharedTaskMetadataTopic(channel, payload) !== null ||
      channel.startsWith('usage:message-') || channel === 'usage:session-spend-changed' || channel === 'usage:session-tokens-changed')) return null;
  if (channel === 'maker:event:batch' && (!Array.isArray(row.events) || row.events.some((event) => record(event)?.sessionId !== sessionId))) return null;
  return () => capture.isCurrent();
}
