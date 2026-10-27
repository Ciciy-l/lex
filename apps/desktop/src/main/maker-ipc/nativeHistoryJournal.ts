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
  /** Codex full-history replacement keeps the task's existing clear boundary. */
  clearedAt?: number | null;
}
const codexThreadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validReplacementTarget(identity: NativeHistoryIdentity, target: string): boolean {
  return identity.agentKind === 'codex' ? codexThreadId.test(identity.nativeId) && codexThreadId.test(target)
    : path.isAbsolute(target) && target.length <= 32768 && path.dirname(target) === path.dirname(identity.nativeId);
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
  /** Codex's captured executor confirmed physical exit; never inferred by ID. */
  executorRetired?: boolean;
  /** Captured local native child. Existence is never ownership or exit proof. */
  executorPid?: number;
  /** Written only after the exact executor has confirmed exit for explicit clear. */
  clear?: { at: number; previousClearedAt: number | null };
}

/** Only negative process existence proves a crashed writer has gone. A live or
 * reused PID and permission/probe errors remain protected; never signal it. */
export function nativeHistoryExecutorHasExited(record: NativeHistoryPending): boolean {
  if (record.executorRetired === true) return true;
  if (record.agentKind !== 'codex' || !record.executorPid) return false;
  try { process.kill(record.executorPid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
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
      || (record.executorRetired !== undefined && (record.agentKind !== 'codex' || typeof record.executorRetired !== 'boolean'))
      || (record.executorPid !== undefined && (record.agentKind !== 'codex' || !Number.isSafeInteger(record.executorPid) || record.executorPid <= 0))
      || (record.clear !== undefined && (!record.clear || !Number.isSafeInteger(record.clear.at) || record.clear.at <= 0
        || (record.clear.previousClearedAt !== null && !Number.isSafeInteger(record.clear.previousClearedAt))))
      || (record.clearedAt !== undefined && record.clearedAt !== null && !Number.isSafeInteger(record.clearedAt))
      || (record.targetNativeId !== undefined && (typeof record.targetNativeId !== 'string' || !validReplacementTarget(record, record.targetNativeId))))
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
    executorRetired(pending: NativeHistoryPending, retired: boolean, executorPid?: number): NativeHistoryPending {
      const current = read();
      if (current?.agentKind !== 'codex' || current.operationId !== pending.operationId)
        throw new Error('Native history executor changed');
      if (executorPid !== undefined && (!Number.isSafeInteger(executorPid) || executorPid <= 0)) throw new Error('Invalid native history writer');
      const updated = { ...current, executorRetired: retired, ...(executorPid !== undefined ? { executorPid } : {}) };
      write(updated); return updated;
    },
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
      if (targetNativeId !== undefined && (!validReplacementTarget(current, targetNativeId)
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
  if (value.sessionId !== sessionId || !['pi', 'omp', 'codex'].includes(value.agentKind)
    || typeof value.nativeId !== 'string' || (value.agentKind === 'codex' ? !codexThreadId.test(value.nativeId) : !path.isAbsolute(value.nativeId))
    || typeof value.workingDir !== 'string' || typeof value.model !== 'string')
    throw new Error('Native history recovery identity changed');
  return createNativeHistoryJournal(root, { sessionId, nativeId: value.nativeId, agentKind: value.agentKind,
    workingDir: value.workingDir, model: value.model,
    ...(value.configuration !== undefined ? { configuration: value.configuration } : {}),
    ...(value.clearedAt !== undefined ? { clearedAt: value.clearedAt } : {}) }).readForClear();
}

/** Before spawning anything: never reopen the source after an unknown fork. */
export function nativeHistoryStartupTarget(root: string, identity: NativeHistoryIdentity): { target: string; pending: boolean; source: string } {
  const pending = createNativeHistoryJournal(root, identity).read();
  if (pending?.replacing && !pending.targetNativeId) throw new Error('Native history replacement outcome is unknown; the source was not reopened');
  return { target: pending?.targetNativeId ?? identity.nativeId, pending: pending !== null, source: pending?.nativeId ?? identity.nativeId };
}
