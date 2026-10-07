import { SHARED_TASK_CLOSE_MAX_TARGETS, type SharedTaskApi, type SharedTaskCloseResult, type SharedTaskHostState, type SharedTaskListItem, type SharedTaskOwnedItem } from '@cindy/device-link';
import type { SharedTaskHost } from './sharedTaskHost.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';

function command(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'SharedTask command is required');
  return raw as Record<string, unknown>;
}
function id(value: unknown): string {
  const text = requireString(value, 'identifier');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throwIpcError('INVALID_PARAMS', 'Invalid sharedTask identifier');
  return text;
}
function closeTargetIds(input: Record<string, unknown>): string[] {
  // A close confirmation always carries an explicit immutable batch. The old
  // `all` flag is intentionally rejected: resolving it here would turn a
  // confirmed snapshot into a new, potentially larger server-side list.
  if (input.all !== undefined) throwIpcError('INVALID_PARAMS', 'SharedTask close targets are required');
  const hasSingle = input.sharedTaskId !== undefined;
  const hasBatch = input.sharedTaskIds !== undefined;
  if (hasSingle === hasBatch) throwIpcError('INVALID_PARAMS', 'Exactly one sharedTask close target form is required');
  if (hasSingle) return [id(input.sharedTaskId)];
  if (!Array.isArray(input.sharedTaskIds) || input.sharedTaskIds.length === 0
      || input.sharedTaskIds.length > SHARED_TASK_CLOSE_MAX_TARGETS) {
    throwIpcError('INVALID_PARAMS', 'Invalid sharedTask close target list');
  }
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const value of input.sharedTaskIds) {
    const sharedTaskId = id(value);
    if (!seen.has(sharedTaskId)) { seen.add(sharedTaskId); targets.push(sharedTaskId); }
  }
  return targets;
}
/** Owner management is never exposed through guest task invoke permissions. */
export async function executeSharedTaskHostCommand(raw: unknown, deps: {
  available(): boolean; host(): SharedTaskHost;
}): Promise<unknown> {
  const input = command(raw);
  if (input.action === 'state') {
    const sessionId = id(input.sessionId);
    if (!deps.available()) return { available: false, detail: null } satisfies SharedTaskHostState;
    const host = deps.host();
    const sharedTaskId = host.activeSharedTaskIds().find((key) => host.detail(key)?.sessionId === sessionId);
    if (!sharedTaskId) return { available: true, detail: null } satisfies SharedTaskHostState;
    await host.refresh(sharedTaskId);
    const detail = host.detail(sharedTaskId);
    return { available: true, detail } satisfies SharedTaskHostState;
  }
  if (!deps.available()) throwIpcError('UNSUPPORTED_CAPABILITY', 'SharedTask mode requires updated clients and server');
  const host = deps.host();
  if (input.action === 'open') return { sharedTaskId: await host.open(id(input.sessionId)) };
  const sharedTaskId = id(input.sharedTaskId);
  if (input.action === 'invite') return host.invite(sharedTaskId);
  if (input.action === 'close') { await host.close(sharedTaskId); return { ok: true }; }
  if (input.action === 'remove') { await host.remove(sharedTaskId, id(input.memberId)); return { ok: true }; }
  throwIpcError('INVALID_PARAMS', 'Unknown sharedTask command');
}

/** Account API uses the caller's login, never the host's credentials. */
export async function executeSharedTaskAccountCommand(raw: unknown, api: SharedTaskApi, accountId?: string, deps?: {
  /** Shared tasks hosted by THIS profile; closable through the local host journal. */
  hostedIds?(): string[];
  closeHosted?(sharedTaskId: string): Promise<void>;
  /** Other devices use the ordinary same-account host connection. */
  closeRemoteHosted?(sharedTaskId: string, hostDeviceId: string): Promise<void>;
  /** Captured account/region generation; a changed scope stops the batch. */
  isCurrent?(): boolean;
}): Promise<unknown> {
  const input = command(raw);
  if (input.action === 'status') throwIpcError('INVALID_PARAMS', 'SharedTask status must be handled by the IPC boundary');
  if (input.action === 'list') return (await api.list()).filter((item) => item.ownerAccountId !== accountId);
  if (input.action === 'owned') {
    if (!accountId) return [] satisfies SharedTaskOwnedItem[];
    const hosted = deps?.hostedIds?.() ?? [];
    return (await api.list())
      .filter((item) => item.ownerAccountId === accountId)
      .map((item) => ({ ...item, local: hosted.includes(item.sharedTaskId) })) satisfies SharedTaskOwnedItem[];
  }
  if (input.action === 'close') {
    const result: SharedTaskCloseResult = { closed: [], failed: [] };
    const isCurrent = deps?.isCurrent ?? (() => true);
    if (!isCurrent()) return result;
    const targetIds = closeTargetIds(input);
    // One authoritative list is captured before any close starts. Renderer
    // targets and hostDeviceId are never trusted for ownership or routing.
    const snapshot = (await api.list()).map((item): SharedTaskListItem => Object.freeze({ ...item }));
    // The list itself crossed an async account boundary. Do not turn a late
    // response from the old account into a close batch for the new one.
    if (!isCurrent()) return result;
    const owned = new Map(snapshot
      .filter((item) => item.ownerAccountId === accountId)
      .map((item) => [item.sharedTaskId, item] as const));
    const targets = targetIds.map((sharedTaskId) => owned.get(sharedTaskId) ?? { sharedTaskId } as SharedTaskListItem);
    const locallyHosted = new Set(deps?.hostedIds?.() ?? []);
    for (const target of targets) {
      const sharedTaskId = target.sharedTaskId;
      if (!isCurrent()) break;
      if (!owned.has(sharedTaskId)) {
        result.failed.push({ sharedTaskId });
        continue;
      }
      try {
        // Locally hosted tasks must go through the host so the closure is
        // journaled and guests are revoked before the server answers.
        if (locallyHosted.has(sharedTaskId)) {
          if (!deps?.closeHosted) throw new Error('Local SharedTask host is unavailable');
          await deps.closeHosted(sharedTaskId);
        } else {
          if (!deps?.closeRemoteHosted) throw new Error('Remote SharedTask host is unavailable');
          await deps.closeRemoteHosted(sharedTaskId, target.hostDeviceId);
        }
        if (!isCurrent()) {
          result.failed.push({ sharedTaskId });
          break;
        }
        result.closed.push(sharedTaskId);
      } catch { result.failed.push({ sharedTaskId }); }
    }
    return result;
  }
  if (input.action === 'join') return api.join(requireString(input.invitation, 'invitation'), requireString(input.displayName, 'displayName'));
  const sharedTaskId = id(input.sharedTaskId);
  if (input.action === 'get') return api.get(sharedTaskId);
  if (input.action === 'leave') return api.leave(sharedTaskId);
  throwIpcError('INVALID_PARAMS', 'Unknown sharedTask account command');
}
