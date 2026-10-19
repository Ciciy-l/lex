import type { AgentNativeStopRequest, Session } from '@cindy/maker-core';

export interface NativeStopBindingDeps {
  isCurrent(session: Session): boolean;
  /** Same explicit Stop as GUI, including goals, recovery and pending interactions. */
  stop(session: Session, request: AgentNativeStopRequest, assertCurrent: () => void): Promise<void>;
}
export function bindNativeSessionStop(session: Session, deps: NativeStopBindingDeps): () => void {
  return session.onNativeStop(async request => {
    const assertCurrent = () => {
      if (request.signal.aborted || !deps.isCurrent(session) || session.sdkSessionId !== request.nativeSessionId) {
        throw new Error('Native stop no longer belongs to this task');
      }
    };
    assertCurrent();
    if (!request.nativeTurnId || session.getCurrentTurnId() !== request.nativeTurnId) throw new Error('Native stop turn changed');
    // Stop must not queue behind the send or approval it is supposed to cancel.
    await deps.stop(session, request, assertCurrent);
    assertCurrent();
  });
}
