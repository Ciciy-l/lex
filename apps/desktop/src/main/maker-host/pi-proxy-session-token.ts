/**
 * Pi's domain wrapper around the engine-neutral local proxy token lifecycle.
 *
 * The persisted owner key retains its historical storage identity so existing Pi
 * sessions stay valid across this extraction. OMP uses a separate wrapper and
 * HMAC domain; neither engine imports the other's implementation.
 */
import {
  deriveAgentProxySessionToken,
  resetAgentProxyDerivationKeyCacheForTests,
} from './agent-proxy-session-token.js';

export function derivePiProxySessionToken(sessionId: string): string {
  return deriveAgentProxySessionToken('pi', sessionId);
}

/** Test-only process restart simulation; does not delete the persisted key. */
export function resetPiProxyDerivationKeyCacheForTests(): void {
  resetAgentProxyDerivationKeyCacheForTests();
}
