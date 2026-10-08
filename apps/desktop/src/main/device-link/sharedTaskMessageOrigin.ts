import { queueItemVisibleText } from '@cindy/maker-shared/queue';
import type { SharedTaskAuthor } from '@cindy/maker-shared';

export interface SharedTaskProjectionScope {
  sharedTaskId: string;
  sessionId: string;
  memberId: string;
  accountId: string;
  deviceId?: string;
}

function isOwnedBySharedTaskGuest(
  author: unknown,
  scope: SharedTaskProjectionScope,
): author is SharedTaskAuthor {
  // Local owner rows have no shared-task author. They remain visible as task
  // queue state, but never carry a guest durable receipt. Guest-authored rows
  // must match the complete host stamp before they can cross this boundary.
  if (author === undefined) return true;
  if (!author || typeof author !== 'object' || Array.isArray(author)) return false;
  const value = author as Partial<SharedTaskAuthor>;
  return value.sharedTaskId === scope.sharedTaskId
    && value.sessionId === scope.sessionId
    && value.memberId === scope.memberId
    && value.accountId === scope.accountId
    && (value.deviceId === undefined || value.deviceId === scope.deviceId);
}

function projectSharedTaskClientId(
  value: unknown,
  wireClientId: unknown,
): unknown {
  return typeof wireClientId === 'string' && wireClientId.length > 0 ? wireClientId : value;
}

/**
 * 共享任务访客只能直接访问被共享的这一个任务（docs/product-rules/shared-task-mode.md）。
 * 消息来源（agentMeta.origin）里指向房主其它任务或伙伴的身份——来源任务 id、标题、
 * 伙伴 id / 名字、Orca 发送方任务——都不属于访客可见范围，投递给访客前一律剥掉。
 * 任务来源降级为不带身份的 `{ kind: 'session' }`，访客端显示不可点击的「由其他任务发送」。
 *
 * `agentFacingWireContent` 是主机内部的 Agent 原文副本（只用于上下文溢出后重放），
 * 可能带「[来自 X 的补充]」这类来源前缀；访客端从不使用，一律不下发。
 */
export function redactMessageOriginForSharedGuest(agentMeta: unknown): unknown {
  if (!agentMeta || typeof agentMeta !== 'object' || Array.isArray(agentMeta)) return agentMeta;
  const meta = agentMeta as Record<string, unknown>;
  const { agentFacingWireContent: _wire, ...rest } = meta;
  const hadWire = 'agentFacingWireContent' in meta;
  const origin = meta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    return hadWire ? rest : agentMeta;
  }
  const kind = (origin as { kind?: unknown }).kind;
  if (kind === 'session') return { ...rest, origin: { kind: 'session' } };
  if (kind === 'orca' && 'senderSessionId' in origin) {
    const { senderSessionId: _, ...orcaRest } = origin as Record<string, unknown>;
    return { ...rest, origin: orcaRest };
  }
  return hadWire ? rest : agentMeta;
}
/** 对单条消息行套用 {@link redactMessageOriginForSharedGuest}；无需改动时返回原引用。 */
export function redactMessageRowForSharedGuest<T>(message: T): T {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  const agentMeta = redactMessageOriginForSharedGuest(record.agentMeta);
  return agentMeta === record.agentMeta ? message : ({ ...record, agentMeta } as T);
}

/**
 * 排队条目的访客视图。任务来源条目里，发给 Agent 的 `text` 与 `origin.displayText`
 * 可能带来源身份（如伙伴补充的「[来自 X 的补充]」前缀），访客只能拿到落库可见正文
 * （`persistedContent`，带附件时是 `{text, images, files}` 信封里的 text）；来源降级为
 * 不带 id / 标题 / 伙伴的任务来源。Orca 来源去掉发送方任务 id。无需改动时返回原引用。
 */
export function redactQueueItemForSharedGuest<T>(
  item: T,
  scope?: SharedTaskProjectionScope,
): T | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const entry = item as Record<string, unknown>;
  if (scope && !isOwnedBySharedTaskGuest(entry.sharedTaskAuthor, scope)) return null;
  const wireClientId = entry.sharedTaskWireClientId;
  const projectedClientId = projectSharedTaskClientId(entry.clientId, wireClientId);
  const origin = entry.origin;
  const withoutPrivateIdentity = { ...entry, clientId: projectedClientId } as Record<string, unknown>;
  delete withoutPrivateIdentity.sharedTaskWireClientId;
  const chatMessage = entry.chatMessage;
  if (chatMessage && typeof chatMessage === 'object' && !Array.isArray(chatMessage)) {
    withoutPrivateIdentity.chatMessage = {
      ...(chatMessage as Record<string, unknown>),
      clientId: projectSharedTaskClientId(
        (chatMessage as Record<string, unknown>).clientId,
        wireClientId,
      ),
    };
  }
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    return withoutPrivateIdentity as T;
  }
  const typed = origin as Record<string, unknown>;
  if (typed.kind === 'session') {
    const visible = queueItemVisibleText(entry);
    return {
      ...withoutPrivateIdentity,
      text: visible,
      origin: { kind: 'session', senderSessionId: '', displayText: visible },
    } as T;
  }
  if (typed.kind === 'orca' && 'senderSessionId' in typed) {
    const { senderSessionId: _, ...rest } = typed;
    return { ...withoutPrivateIdentity, origin: rest } as T;
  }
  return withoutPrivateIdentity as T;
}

/**
 * 排队快照（maker:input:projection 推送 / maker:input:get-projection 读取）的访客视图：
 * 待发送队列与失败恢复项（`recovery.item`）里的每个条目都经
 * {@link redactQueueItemForSharedGuest}。无需改动时返回原引用。
 */
export function redactInputProjectionForSharedGuest<T>(
  projection: T,
  scope?: SharedTaskProjectionScope,
  requestedWireClientIds?: readonly string[],
): T {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return projection;
  const record = projection as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  const clientIdMap = new Map<string, string>();
  const ownedHostIds = new Set<string>();
  if (scope && Array.isArray(record.pendingQueue)) {
    for (const rawItem of record.pendingQueue) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const row = rawItem as Record<string, unknown>;
      // Build the host→wire map only after ownership has been established.
      // A different guest can intentionally choose the same raw clientId;
      // retaining that row's mapping here would leak its receipt through
      // steering/continuation metadata even though the queue item is filtered.
      if (typeof row.clientId !== 'string' || redactQueueItemForSharedGuest(rawItem, scope) === null) continue;
      ownedHostIds.add(row.clientId);
      if (typeof row.sharedTaskWireClientId === 'string') {
        clientIdMap.set(row.clientId, row.sharedTaskWireClientId);
      }
    }
  }
  if (Array.isArray(record.pendingQueue)) {
    const pendingQueue = record.pendingQueue
      .map((item: unknown) => redactQueueItemForSharedGuest(item, scope))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (pendingQueue.length !== record.pendingQueue.length ||
        pendingQueue.some((item, index) => item !== (record.pendingQueue as unknown[])[index])) {
      next.pendingQueue = pendingQueue;
      changed = true;
    }
  }
  const recovery = record.recovery;
  if (recovery && typeof recovery === 'object' && !Array.isArray(recovery) && 'item' in recovery) {
    const item = (recovery as { item: unknown }).item;
    const redacted = redactQueueItemForSharedGuest(item, scope);
    if (redacted === null) {
      next.recovery = null;
      changed = true;
    } else if (redacted !== item) {
      next.recovery = { ...(recovery as Record<string, unknown>), item: redacted };
      changed = true;
    }
  }
  if (scope && Array.isArray(record.steeringQueueClientIds)) {
    const ownItems = (next.pendingQueue as unknown[] | undefined) ?? [];
    const ownIds = new Set([...ownedHostIds, ...clientIdMap.values(), ...ownItems.flatMap((item) => {
      const row = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown> : null;
      return typeof row?.clientId === 'string' ? [row.clientId] : [];
    })]);
    const steering = record.steeringQueueClientIds.filter(
      (id): id is string => typeof id === 'string' && ownIds.has(id),
    );
    if (steering.length !== record.steeringQueueClientIds.length) {
      next.steeringQueueClientIds = steering;
      changed = true;
    }
    for (const key of ['continuationInFlightClientId', 'continuationTurnClientId']) {
      if (next[key] !== null && next[key] !== undefined && !ownIds.has(next[key] as string)) {
        next[key] = null;
        changed = true;
      } else if (typeof next[key] === 'string' && clientIdMap.has(next[key] as string)) {
        next[key] = clientIdMap.get(next[key] as string);
        changed = true;
      }
    }
    for (const key of ['steeringQueueClientIds', 'queueInteractionLocks', 'queueEditLocks']) {
      const ids = next[key];
      if (!Array.isArray(ids)) continue;
      const projected = ids
        .filter((id): id is string => typeof id === 'string' && ownIds.has(id))
        .map((id) => clientIdMap.get(id) ?? id);
      if (projected.length !== ids.length || projected.some((id, index) => id !== ids[index])) {
        next[key] = projected;
        changed = true;
      }
    }
    const credentialWait = next.credentialSwitchWait;
    if (credentialWait && typeof credentialWait === 'object' && !Array.isArray(credentialWait)) {
      const wait = credentialWait as Record<string, unknown>;
      if (typeof wait.clientId === 'string' && !ownIds.has(wait.clientId)) {
        next.credentialSwitchWait = { ...wait, clientId: undefined };
        changed = true;
      } else if (typeof wait.clientId === 'string' && clientIdMap.has(wait.clientId)) {
        next.credentialSwitchWait = { ...wait, clientId: clientIdMap.get(wait.clientId) };
        changed = true;
      }
    }
    if (typeof next.errorRetryText === 'string') {
      let retry = next.errorRetryText;
      for (const [scoped, wire] of clientIdMap) retry = retry.replace(scoped, wire);
      if (retry !== next.errorRetryText) {
        next.errorRetryText = retry;
        changed = true;
      }
    }
  }
  if (scope && Array.isArray(record.deliveryReceipts)) {
    const visibleWireIds = new Set(clientIdMap.values());
    const requestedIds = new Set(requestedWireClientIds ?? []);
    const receipts = record.deliveryReceipts.filter((receipt: unknown) => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
      const clientId = (receipt as Record<string, unknown>).clientId;
      return typeof clientId === 'string' && clientId.length > 0 &&
        (ownedHostIds.has(clientId) || clientIdMap.has(clientId) || visibleWireIds.has(clientId) ||
          requestedIds.has(clientId));
    }).map((receipt: unknown) => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return receipt;
      const row = receipt as Record<string, unknown>;
      const wireClientId = typeof row.clientId === 'string' ? clientIdMap.get(row.clientId) : undefined;
      return wireClientId ? { ...row, clientId: wireClientId } : row;
    });
    if (receipts.length !== record.deliveryReceipts.length) {
      next.deliveryReceipts = receipts;
      changed = true;
    }
  }
  return changed ? (next as T) : projection;
}

/** 推往共享任务访客的单帧 payload：按 channel 套用对应的来源脱敏。 */
export function redactSharedGuestPush(
  channel: string,
  payload: unknown,
  scope?: SharedTaskProjectionScope,
): unknown {
  if (channel === 'maker:input:projection') return redactInputProjectionForSharedGuest(payload, scope);
  if (
    channel !== 'local-db:messages:created' ||
    !payload ||
    typeof payload !== 'object' ||
    !('message' in payload)
  ) {
    return payload;
  }
  const message = (payload as { message: unknown }).message;
  const redacted = redactMessageRowForSharedGuest(message);
  return redacted === message
    ? payload
    : { ...(payload as Record<string, unknown>), message: redacted };
}
