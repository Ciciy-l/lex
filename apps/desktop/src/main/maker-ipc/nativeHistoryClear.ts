import { createNativeHistoryJournal, readNativeHistoryForClear, type NativeHistoryPending } from './nativeHistoryJournal.js';
import { withNativeHistoryOperation } from './nativeHistoryOperation.js';

export interface NativeHistoryClearState { nativeId: string | null; clearedAt: number | null }
export interface NativeHistoryClearDependencies {
  root: string;
  sessionId: string;
  assertCurrent(): void;
  readState(): Promise<NativeHistoryClearState>;
  /** Captured exact executor, never a later task instance looked up by ID. */
  executor?: { nativeId: string; agentKind: string; workingDir: string; close(): Promise<void> };
}

function journalFor(root: string, record: NativeHistoryPending) {
  return createNativeHistoryJournal(root, { sessionId: record.sessionId, nativeId: record.nativeId,
    agentKind: record.agentKind, workingDir: record.workingDir, model: record.model,
    ...(record.configuration !== undefined ? { configuration: record.configuration } : {}) });
}
function assertStoredIdentity(record: NativeHistoryPending, state: NativeHistoryClearState) {
  if (state.nativeId !== record.nativeId && state.nativeId !== record.targetNativeId)
    throw new Error('Native history clear identity changed');
}

/** Main's explicit clear transaction. The same cross-process lock excludes
 * navigation; the durable clear intent is written only after confirmed exit.
 * A failed commit/tombstone can finish later without another native mutation. */
export async function withNativeHistoryClear<T>(deps: NativeHistoryClearDependencies, at: number,
  commit: (guard?: { expected: NativeHistoryClearState; at: number }) => Promise<T>): Promise<T> {
  return withNativeHistoryOperation(deps.root, deps.sessionId, async () => {
    deps.assertCurrent();
    let pending = readNativeHistoryForClear(deps.root, deps.sessionId);
    const state = await deps.readState();
    deps.assertCurrent();
    if (pending?.clear && deps.executor)
      throw new Error('A native executor appeared after history clear retirement');
    if (pending && !pending.clear) {
      assertStoredIdentity(pending, state);
      const executor = deps.executor;
      if (!executor || (executor.nativeId !== pending.nativeId && executor.nativeId !== pending.targetNativeId)
        || executor.agentKind !== pending.agentKind || executor.workingDir !== pending.workingDir)
        throw new Error('Resume the original native task before clearing its unfinished history');
    }
    if (deps.executor) {
      await deps.executor.close();
      deps.assertCurrent();
    }
    if (pending && !pending.clear) {
      pending = journalFor(deps.root, pending).markClearing(pending, at, state.clearedAt);
    }
    if (pending?.clear) {
      const intent = pending.clear;
      const committed = state.nativeId === null && state.clearedAt !== null && state.clearedAt >= intent.at;
      if (!committed) {
        assertStoredIdentity(pending, state);
        if (state.clearedAt !== intent.previousClearedAt) throw new Error('Native history clear boundary changed');
      }
      // The existing clear body owns queue and context cleanup, even on retry.
      const effectiveAt = Math.max(at, intent.at, state.clearedAt ?? 0);
      const result = await commit({ expected: state, at: effectiveAt });
      deps.assertCurrent();
      const after = await deps.readState();
      deps.assertCurrent();
      if (after.nativeId !== null || after.clearedAt === null || after.clearedAt < effectiveAt)
        throw new Error('Native history clear has not committed');
      journalFor(deps.root, pending).completeClear(pending);
      return result;
    }
    return commit({ expected: state, at });
  });
}

/** Startup may only finish a proven committed clear, not infer one from a new
 * native ID. An uncommitted intent requires the explicit clear action again. */
export async function finishCommittedNativeHistoryClear(deps: NativeHistoryClearDependencies): Promise<boolean> {
  deps.assertCurrent();
  if (!readNativeHistoryForClear(deps.root, deps.sessionId)?.clear) return false;
  return withNativeHistoryOperation(deps.root, deps.sessionId, async () => {
    deps.assertCurrent();
    const pending = readNativeHistoryForClear(deps.root, deps.sessionId);
    if (!pending?.clear) return false;
    const state = await deps.readState();
    deps.assertCurrent();
    if (state.nativeId !== null || state.clearedAt === null || state.clearedAt < pending.clear.at)
      throw new Error('Native history clear has not committed; retry the explicit clear');
    journalFor(deps.root, pending).completeClear(pending);
    return true;
  });
}
