/**
 * Independent host fence for an explicit Orca clear/compact operation.
 *
 * It is deliberately NOT the ordinary per-session send lock: that lock can bail
 * after its bounded wait, and a clear/compact may legitimately wait on native
 * retirement or a DB transaction for longer. While an operation is active:
 *   - ordinary Orca dispatch/queue/direct-send entries are rejected before
 *     accepted/queued, so nobody receives a queued receipt that clear would
 *     silently discard;
 *   - local/remote content-bearing input is rejected at the existing clear
 *     gate;
 *   - only the operation's own token may dispatch the task that follows.
 *
 * State is anchored on globalThis so the production dispatcher and the
 * register prepare function share one fence even when tests extract the
 * prepare function and evaluate it with an injected dependency scope.
 */
export const ORCA_CONTEXT_OPERATION_FENCE_KEY = Symbol.for(
  'cindy.orcaContextOperationFence.v1',
);

export interface OrcaContextOperationFenceEntry {
  token: symbol;
  sessionId: string;
  policy: 'clear' | 'compact';
  /** Captured owner/generation guard; replayed messages must re-check it. */
  assertCurrent?: () => void | Promise<void>;
}

type FenceMap = Map<string, OrcaContextOperationFenceEntry>;

function fenceMap(): FenceMap {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[ORCA_CONTEXT_OPERATION_FENCE_KEY];
  if (existing instanceof Map) return existing as FenceMap;
  const next: FenceMap = new Map();
  globalRecord[ORCA_CONTEXT_OPERATION_FENCE_KEY] = next;
  return next;
}

export function beginOrcaContextOperation(
  sessionId: string,
  policy: 'clear' | 'compact',
  assertCurrent?: () => void | Promise<void>,
): symbol {
  const fences = fenceMap();
  const existing = fences.get(sessionId);
  if (existing) {
    const error = new Error(
      `Orca context operation (${existing.policy}) is already active; admission refused`,
    );
    (error as { code?: string }).code = 'SESSION_RUNNING';
    throw error;
  }
  const token = Symbol(`orca-context-operation:${policy}`);
  fences.set(sessionId, { token, sessionId, policy, ...(assertCurrent ? { assertCurrent } : {}) });
  return token;
}

/** Release only if this exact token still owns the session. */
export function releaseOrcaContextOperation(token: symbol | undefined): boolean {
  if (!token) return false;
  const fences = fenceMap();
  for (const [sessionId, entry] of fences) {
    if (entry.token !== token) continue;
    fences.delete(sessionId);
    return true;
  }
  return false;
}

export function activeOrcaContextOperation(
  sessionId: string,
): OrcaContextOperationFenceEntry | undefined {
  return fenceMap().get(sessionId);
}

export function assertOrcaContextOperationAllowed(
  sessionId: string,
  permittedToken?: symbol,
): void {
  const entry = fenceMap().get(sessionId);
  if (!entry) return;
  if (permittedToken !== undefined && entry.token === permittedToken) return;
  const error = new Error(
    `Orca context operation (${entry.policy}) is in progress; retry after it completes`,
  );
  (error as { code?: string }).code = 'SESSION_RUNNING';
  throw error;
}

/** Test/reset helper; production callers should release their exact token. */
export function __resetOrcaContextOperationFenceForTest(): void {
  fenceMap().clear();
}
