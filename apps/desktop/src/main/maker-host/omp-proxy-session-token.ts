/** OMP's own domain wrapper around the engine-neutral local proxy token lifecycle. */
import { deriveAgentProxySessionToken } from './agent-proxy-session-token.js';

export function deriveOmpProxySessionToken(sessionId: string): string {
  return deriveAgentProxySessionToken('omp', sessionId);
}
