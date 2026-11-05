import type { AgentInputProjection } from '../../shared/agentInputQueue.js';
import { resolveClearSessionBoundary } from './clearSessionBoundary.js';
import type {
  NativeHistoryClearDependencies,
  NativeHistoryClearState,
} from './nativeHistoryClear.js';
import type { NativeHistoryPending } from './nativeHistoryJournal.js';
import type { OrcaContextOwnerScope } from './orcaContextOwner.js';

/**
 * Shared Main clear transaction used by both INPUT_CLEAR_SESSION and the
 * Orca dispatch context policy. The caller owns renderer receipts; this service
 * owns the remote-input clear gate, native retirement/journal, durable boundary,
 * in-memory queue reset, handoff invalidation and goal cleanup in the same order
 * as the original /clear handler.
 */
export interface HostSessionClearDeps {
  beginRemoteInputClearGate(sessionId: string): void;
  endRemoteInputClearGate(sessionId: string): void;
  captureNativeHistoryClearDependencies(sessionId: string): NativeHistoryClearDependencies;
  readNativeHistoryForClear(root: string, sessionId: string): NativeHistoryPending | null;
  withNativeHistoryClear<T>(
    deps: NativeHistoryClearDependencies,
    at: number,
    commit: (guard?: { expected: NativeHistoryClearState; at: number }) => Promise<T>,
  ): Promise<T>;
  clearSessionContextInDb(
    sessionId: string,
    ts: number,
    expected?: NativeHistoryClearState,
  ): Promise<unknown>;
  clearInputProjection(sessionId: string, boundary: string | number): AgentInputProjection;
  discardWorkingDirectoryRecovery(sessionId: string): void;
  resetAutomaticRecoveryForExplicitStop(sessionId: string): void;
  invalidateAgentHandoff(sessionId: string): void;
  sealAgentHandoffClearBoundary(sessionId: string): void;
  notifyQueueEmptied(sessionId: string): void;
  clearGoal(sessionId: string): void;
  logError(message: string, fields: Record<string, unknown>): void;
}

export interface HostSessionClearOptions {
  clearedAt?: string;
  isRemoteInvoke: boolean;
  /**
   * Strict callers (Orca dispatch) must not treat a failed DB write as a
   * successful clear: a restart would otherwise resume the old native thread.
   * The ordinary /clear UI path keeps its existing best-effort persistence.
   */
  strictPersistence?: boolean;
  /** Called immediately before native history retirement begins. */
  onNative?(): void;
  /** Called after the durable clear boundary and projection are committed. */
  onCommitted?(result: { boundaryMs: number; native: boolean }): void;
  /** Host-captured owner for an Orca clear; projection must not cross an owner switch. */
  owner?: OrcaContextOwnerScope | null;
}

export interface HostSessionClearResult {
  projection: AgentInputProjection;
  boundaryMs: number;
  native: boolean;
}

export interface HostSessionClearService {
  clearSession(sessionId: string, options: HostSessionClearOptions): Promise<HostSessionClearResult>;
}

/**
 * A clear that committed durably but could not finish journal/projection
 * retirement. Callers must report the irreversible part truthfully instead of
 * treating the whole operation as "not cleared".
 */
export class HostSessionClearError extends Error {
  readonly applied: 'cleared' | undefined;
  readonly boundaryMs: number | undefined;
  constructor(message: string, applied: 'cleared' | undefined, boundaryMs?: number) {
    super(message);
    this.name = 'HostSessionClearError';
    this.applied = applied;
    this.boundaryMs = boundaryMs;
  }
}

export function createHostSessionClearService(deps: HostSessionClearDeps): HostSessionClearService {

  async function clearSession(
    sessionId: string,
    options: HostSessionClearOptions,
  ): Promise<HostSessionClearResult> {
    deps.beginRemoteInputClearGate(sessionId);
    try {
      const clearBoundary = resolveClearSessionBoundary({
        ...(options.clearedAt ? { clearedAt: options.clearedAt } : {}),
        isRemoteInvoke: options.isRemoteInvoke,
      });
      const nativeClear = deps.captureNativeHistoryClearDependencies(sessionId);
      const finishProjection = (boundaryMs: number): AgentInputProjection => {
        deps.discardWorkingDirectoryRecovery(sessionId);
        deps.resetAutomaticRecoveryForExplicitStop(sessionId);
        deps.notifyQueueEmptied(sessionId);
        deps.clearGoal(sessionId);
        return deps.clearInputProjection(sessionId, boundaryMs);
      };
      const commitClear = async (): Promise<{ projection: AgentInputProjection; boundaryMs: number; native: false }> => {
        nativeClear.assertCurrent();
        const clearBoundaryMs =
          typeof clearBoundary === 'number' ? clearBoundary : new Date(clearBoundary).getTime();
        if (options.strictPersistence) {
          // Strict callers must not publish a queue projection until the
          // durable generation boundary is proven committed. A retired/deleted
          // session or a CAS miss is a zero-row update, never success.
          try {
            await deps.clearSessionContextInDb(sessionId, clearBoundaryMs);
          } catch (err) {
            if (err instanceof HostSessionClearError) throw err;
            throw new HostSessionClearError(
              err instanceof Error ? err.message : 'strict clear persistence failed',
              undefined,
            );
          }
        }
        if (options.strictPersistence) {
          try {
            options.owner?.assertCurrent();
          } catch {
            throw new HostSessionClearError(
              'context committed but the owner changed before the queue projection',
              'cleared',
              clearBoundaryMs,
            );
          }
          let projection: AgentInputProjection;
          try {
            projection = deps.clearInputProjection(sessionId, clearBoundaryMs);
            deps.discardWorkingDirectoryRecovery(sessionId);
            deps.resetAutomaticRecoveryForExplicitStop(sessionId);
            deps.invalidateAgentHandoff(sessionId);
            deps.notifyQueueEmptied(sessionId);
            deps.clearGoal(sessionId);
          } catch {
            throw new HostSessionClearError(
              'clear committed but the input projection could not be reset',
              'cleared',
              clearBoundaryMs,
            );
          }
          options.onCommitted?.({ boundaryMs: clearBoundaryMs, native: false });
          return { projection, boundaryMs: clearBoundaryMs, native: false };
        }
        const projection = deps.clearInputProjection(sessionId, clearBoundary);
        deps.discardWorkingDirectoryRecovery(sessionId);
        deps.resetAutomaticRecoveryForExplicitStop(sessionId);
        deps.invalidateAgentHandoff(sessionId);
        deps.notifyQueueEmptied(sessionId);
        deps.clearGoal(sessionId);
        try {
          await deps.clearSessionContextInDb(sessionId, clearBoundaryMs);
        } catch (err) {
          // Keep the existing /clear semantics: the in-memory fence is authoritative
          // for this process even when persistence fails; surface it in logs and let
          // the next input/projection boundary retry the durable token.
          deps.logError('clear session context persist failed', {
            sessionId,
            remoteInvoke: options.isRemoteInvoke,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        options.onCommitted?.({ boundaryMs: clearBoundaryMs, native: false });
        return { projection, boundaryMs: clearBoundaryMs, native: false };
      };

      if (
        nativeClear.executor ||
        deps.readNativeHistoryForClear(nativeClear.root, sessionId)
      ) {
        const at =
          typeof clearBoundary === 'number' ? clearBoundary : new Date(clearBoundary).getTime();
        options.onNative?.();
        let committed: { boundaryMs: number } | undefined;
        try {
          return await deps.withNativeHistoryClear(nativeClear, at, async (guard) => {
            if (!guard) throw new Error('Native clear guard missing');
            deps.invalidateAgentHandoff(sessionId);
            await deps.clearSessionContextInDb(sessionId, guard.at, guard.expected);
            // Do NOT reset the renderer queue before the journal tombstone is
            // complete. A tombstone failure leaves the DB committed but the
            // clear contract failed; publishing a speculative empty projection
            // would silently discard accepted input.
            committed = { boundaryMs: guard.at };
            return { boundaryMs: guard.at };
          }).then(({ boundaryMs }) => {
            nativeClear.assertCurrent();
            return nativeClear.readState();
          }).then((state) => {
            const boundaryMs = state.clearedAt ?? committed?.boundaryMs ?? at;
            const projection = finishProjection(boundaryMs);
            options.onCommitted?.({ boundaryMs, native: true });
            return { projection, boundaryMs, native: true as const };
          });
        } catch (err) {
          if (committed) {
            throw new HostSessionClearError(
              'native clear committed the DB boundary but did not finish journal retirement',
              'cleared',
              committed.boundaryMs,
            );
          }
          throw err;
        }
      }

      return await commitClear();
    } finally {
      // 落库尝试结束后封边界:重立墓碑(清掉这段 await 里用 clear 前纪元挤进来的那份)
      // + 推进纪元(挡住后面才写回的那批)。顺序不可倒退。
      deps.sealAgentHandoffClearBoundary(sessionId);
      deps.endRemoteInputClearGate(sessionId);
    }
  }

  return { clearSession };
}
