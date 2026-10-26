import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RoutingDescriptor } from '@cindy/model-providers';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

export interface NativeHistoryIdentity {
  sessionId: string;
  nativeId: string;
  agentKind: string;
  workingDir: string;
  model: string;
  /** Stable route/configuration references only, never credentials or tokens. */
  configuration?: string;
}
export function nativeHistoryRouteReference(route: RoutingDescriptor | null): string {
  // An explicit allowlist: never serialize headers, keys or OAuth token values.
  // The credential reference identifies the existing secure-store slot only.
  return createHash('sha256').update(JSON.stringify(route ? [route.upstream, route.requestPath ?? null,
    route.wireProtocol ?? null, route.authStrategy, route.channelCredential?.channelId ?? null,
    route.channelCredential?.protocol ?? null, route.modelIdRewrite?.stripPrefix ?? null, route.disabled === true] : null)).digest('hex');
}
export function nativeHistoryConfiguration(value: { providerId?: string | null; effort?: string | null; permissionMode?: string | null; fastMode?: boolean; routeReference?: string }): string {
  return JSON.stringify([value.providerId ?? null, value.effort?.trim() || null, value.permissionMode ?? 'ask', value.fastMode === true, value.routeReference ?? null]);
}
export interface NativeHistoryPending extends NativeHistoryIdentity {
  version: 1;
  operationId: string;
  entryId: string;
  nativeDraft?: string;
  draftText?: string;
  cancelled?: boolean;
  replacing?: boolean;
  targetNativeId?: string;
  /** Written only after the exact executor has confirmed exit for explicit clear. */
  clear?: { at: number; previousClearedAt: number | null };
}

/** Owner-scoped, one small record per task. This is an operation journal, not a
 * preference or authority grant. Never consult the active owner after creation. */
export function createNativeHistoryJournal(root: string, identity: NativeHistoryIdentity) {
  if (!path.isAbsolute(root) || !identity.sessionId || !identity.nativeId) throw new Error('Invalid native history owner');
  const file = path.join(root, createHash('sha256').update(identity.sessionId).digest('hex') + '.json');
  const readForClear = (): NativeHistoryPending | null => {
    const raw = readAtomicFileSync(file);
    if (raw === null) return null;
    if (raw.length > 2_100_000) throw new Error('Native history recovery record is too large');
    const record = JSON.parse(raw) as NativeHistoryPending | null;
    if (record === null) return null;
    if (record.version !== 1 || typeof record.operationId !== 'string' || !record.operationId
      || typeof record.entryId !== 'string' || !record.entryId || record.entryId.length > 128
      || Object.entries(identity).some(([key, value]) => key === 'nativeId'
        ? record.nativeId !== value && record.targetNativeId !== value : record[key as keyof NativeHistoryIdentity] !== value)
      || [record.nativeDraft, record.draftText].some(value => value !== undefined && (typeof value !== 'string' || value.length > 1_000_000))
      || (record.cancelled !== undefined && typeof record.cancelled !== 'boolean')
      || (record.replacing !== undefined && typeof record.replacing !== 'boolean')
      || (record.clear !== undefined && (!record.clear || !Number.isSafeInteger(record.clear.at) || record.clear.at <= 0
        || (record.clear.previousClearedAt !== null && !Number.isSafeInteger(record.clear.previousClearedAt))))
      || (record.targetNativeId !== undefined && (typeof record.targetNativeId !== 'string' || !path.isAbsolute(record.targetNativeId)
        || record.targetNativeId.length > 32768 || path.dirname(record.targetNativeId) !== path.dirname(record.nativeId))))
      throw new Error('Native history recovery identity changed');
    return record;
  };
  const read = (): NativeHistoryPending | null => {
    const record = readForClear();
    if (record?.clear) throw new Error('Native history clear is pending; finish the explicit clear first');
    return record;
  };
  const write = (record: NativeHistoryPending) => {
    const old = read();
    if (old && old.operationId !== record.operationId) throw new Error('Another native history operation is pending');
    atomicWriteFileSync(file, JSON.stringify(record));
  };
  return {
    read,
    readForClear,
    markClearing(pending: NativeHistoryPending, at: number, previousClearedAt: number | null): NativeHistoryPending {
      const current = readForClear();
      if (!current || JSON.stringify(current) !== JSON.stringify(pending)) throw new Error('Native history clear operation changed');
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid native history clear boundary');
      const updated = { ...current, clear: current.clear ?? { at, previousClearedAt } };
      atomicWriteFileSync(file, JSON.stringify(updated));
      return updated;
    },
    completeClear(pending: NativeHistoryPending): void {
      const current = readForClear();
      if (!pending.clear || !current || JSON.stringify(current) !== JSON.stringify(pending))
        throw new Error('Native history clear operation changed');
      atomicWriteFileSync(file, 'null');
    },
    begin(entryId: string, nativeDraft?: string): NativeHistoryPending {
      const existing = read();
      if (existing) {
        if (existing.entryId !== entryId) throw new Error('Retry the unfinished native history operation first');
        return existing;
      }
      const record: NativeHistoryPending = { ...identity, version: 1, operationId: randomUUID(), entryId,
        ...(nativeDraft !== undefined ? { nativeDraft } : {}) };
      if (!entryId || entryId.length > 128 || (nativeDraft !== undefined && nativeDraft.length > 1_000_000))
        throw new Error('Invalid native history recovery data');
      write(record); return record;
    },
    recordResult(pending: NativeHistoryPending, result: { draftText?: string; cancelled?: boolean }): NativeHistoryPending {
      const current = read();
      if (!current || current.operationId !== pending.operationId) throw new Error('Native history recovery operation changed');
      const updated = { ...pending, cancelled: result.cancelled === true,
        draftText: result.cancelled ? undefined : result.draftText };
      if (updated.draftText && updated.draftText.length > 1_000_000) throw new Error('Native history draft is too large');
      write(updated); return updated;
    },
    replace(pending: NativeHistoryPending, targetNativeId?: string): NativeHistoryPending {
      const current = read();
      if (!current || current.operationId !== pending.operationId) throw new Error('Native history replacement changed');
      if (targetNativeId !== undefined && (!path.isAbsolute(targetNativeId) || targetNativeId.length > 32768
        || path.dirname(targetNativeId) !== path.dirname(current.nativeId)
        || (current.targetNativeId !== undefined && current.targetNativeId !== targetNativeId))) throw new Error('Invalid native history replacement target');
      const updated = { ...current, replacing: true, ...(targetNativeId ? { targetNativeId } : {}) };
      write(updated); return updated;
    },
    complete(pending: NativeHistoryPending): void {
      const current = read();
      if (!current || current.operationId !== pending.operationId) throw new Error('Native history recovery operation changed');
      // A durable tombstone also defeats stale .bak resurrection after failure.
      atomicWriteFileSync(file, 'null');
    },
  };
}

/** Explicit clear reads the old task record, never adopts its identity for a
 * new executor. Ordinary startup continues to require the exact native ID. */
export function readNativeHistoryForClear(root: string, sessionId: string): NativeHistoryPending | null {
  if (!path.isAbsolute(root) || !sessionId) throw new Error('Invalid native history owner');
  const file = path.join(root, createHash('sha256').update(sessionId).digest('hex') + '.json');
  const raw = readAtomicFileSync(file);
  if (raw === null) return null;
  if (raw.length > 2_100_000) throw new Error('Native history recovery record is too large');
  const value = JSON.parse(raw) as NativeHistoryPending | null;
  if (value === null) return null;
  if (value.sessionId !== sessionId || !['pi', 'omp'].includes(value.agentKind)
    || typeof value.nativeId !== 'string' || !path.isAbsolute(value.nativeId)
    || typeof value.workingDir !== 'string' || typeof value.model !== 'string')
    throw new Error('Native history recovery identity changed');
  return createNativeHistoryJournal(root, { sessionId, nativeId: value.nativeId, agentKind: value.agentKind,
    workingDir: value.workingDir, model: value.model,
    ...(value.configuration !== undefined ? { configuration: value.configuration } : {}) }).readForClear();
}

/** Before spawning anything: never reopen the source after an unknown fork. */
export function nativeHistoryStartupTarget(root: string, identity: NativeHistoryIdentity): { target: string; pending: boolean; source: string } {
  const pending = createNativeHistoryJournal(root, identity).read();
  if (pending?.replacing && !pending.targetNativeId) throw new Error('Native history replacement outcome is unknown; the source was not reopened');
  return { target: pending?.targetNativeId ?? identity.nativeId, pending: pending !== null, source: pending?.nativeId ?? identity.nativeId };
}
