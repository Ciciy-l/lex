/**
 * Owner-scoped tokens for Desktop's local agent proxies.
 *
 * This is deliberately engine-neutral: a single encrypted owner key survives a
 * Desktop restart, while the HMAC domain keeps one agent's bearer unusable by
 * another agent for the same session. The persisted storage-key retains its
 * historical Pi spelling for backward compatibility; this module owns the
 * generic lifecycle and no engine imports another engine's implementation.
 */
import { createHmac, randomBytes } from 'node:crypto';

import {
  addProviderSecretsClearedListener,
  readAgentProxyDerivationKey,
  writeAgentProxyDerivationKey,
} from '../secrets/providerSecretStore.js';

const KEY_RE = /^[a-f0-9]{64}$/;
let cachedKey: string | null | undefined;
let unregisterClearListener: (() => void) | null = null;

export type AgentProxySessionTokenDomain = 'pi' | 'omp';

function ensureClearListener(): void {
  if (unregisterClearListener) return;
  unregisterClearListener = addProviderSecretsClearedListener(() => {
    cachedKey = undefined;
  });
}

function getOrCreateDerivationKey(): string | null {
  ensureClearListener();
  if (cachedKey !== undefined) return cachedKey;
  const existing = readAgentProxyDerivationKey();
  if (existing && KEY_RE.test(existing)) {
    cachedKey = existing;
    return existing;
  }
  const created = randomBytes(32).toString('hex');
  if (!writeAgentProxyDerivationKey(created)) return null;
  cachedKey = created;
  return created;
}

/**
 * Derive a restart-stable, owner-scoped bearer for a particular engine/session.
 * The domain is a closed union so a new engine must consciously allocate and
 * review a distinct HMAC namespace rather than silently sharing one.
 */
export function deriveAgentProxySessionToken(
  domain: AgentProxySessionTokenDomain,
  sessionId: string,
): string {
  const key = getOrCreateDerivationKey();
  if (!key) {
    throw new Error(
      '[AGENT_PROXY_DERIVATION_KEY_UNAVAILABLE] Cannot persist local agent proxy authentication; reconnect after secure storage becomes available.',
    );
  }
  return createHmac('sha256', key).update(`${domain}\n${sessionId}`).digest('base64url');
}

/** Test-only process-restart simulation; does not delete the persisted key. */
export function resetAgentProxyDerivationKeyCacheForTests(): void {
  cachedKey = undefined;
  unregisterClearListener?.();
  unregisterClearListener = null;
}
