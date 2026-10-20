import type { AgentNativeRuntimeRequest, Session } from '@cindy/maker-core';

export interface NativeRuntimeBindingDeps {
  isCurrent(session: Session): boolean;
  assertAllowed(sessionId: string): Promise<void>;
  /** Includes the permission queue, then refuses a contended send lock. */
  withChangeLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  /** Uses Main's normal task setting transaction and durable projections. */
  apply(session: Session, request: AgentNativeRuntimeRequest, assertCurrent: () => void): Promise<void>;
}

/** Host-only callback; changing a view never installs a second setting owner. */
export function bindNativeSessionRuntime(session: Session, deps: NativeRuntimeBindingDeps): () => void {
  return session.onNativeRuntimeSelection(async request => {
    const assertCurrent = () => {
      if (request.signal.aborted || !deps.isCurrent(session) || !request.nativeSessionId
        || session.sdkSessionId !== request.nativeSessionId) throw new Error('Native settings no longer belong to this task');
    };
    assertCurrent();
    await deps.withChangeLock(session.id, async () => {
      assertCurrent();
      await deps.assertAllowed(session.id);
      assertCurrent();
      await deps.apply(session, request, assertCurrent);
      assertCurrent();
    });
  });
}
