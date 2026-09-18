/**
 * Restart-stable remote Pi proxy authentication.
 *
 * The HMAC key is owner-scoped and encrypted by Electron safeStorage. Only a
 * derived per-session token is passed to the remote Pi daemon; the host key
 * never leaves Desktop. Account-boundary secret clearing rotates the key and
 * invalidates the process cache so an old owner's daemon cannot authenticate.
 */
import { createHmac, randomBytes } from 'node:crypto';

import {
  addProviderSecretsClearedListener,
  readPiProxyDerivationKey,
  writePiProxyDerivationKey,
} from '../secrets/providerSecretStore.js';

const KEY_RE = /^[a-f0-9]{64}$/;
let cachedKey: string | null | undefined;
let unregisterClearListener: (() => void) | null = null;

function ensureClearListener(): void {
  if (unregisterClearListener) return;
  unregisterClearListener = addProviderSecretsClearedListener(() => {
    cachedKey = undefined;
  });
}

function getOrCreateDerivationKey(): string | null {
  ensureClearListener();
  if (cachedKey !== undefined) return cachedKey;
  const existing = readPiProxyDerivationKey();
  if (existing && KEY_RE.test(existing)) {
    cachedKey = existing;
    return existing;
  }
  const created = randomBytes(32).toString('hex');
  if (!writePiProxyDerivationKey(created)) return null;
  cachedKey = created;
  return created;
}

/** 共享导出密钥上的域分离派生;域前缀让同一 sessionId 的两个 agent 拿到不同 token。 */
function deriveProxySessionToken(domain: string, sessionId: string): string {
  const key = getOrCreateDerivationKey();
  if (!key) {
    throw new Error(
      '[PI_PROXY_DERIVATION_KEY_UNAVAILABLE] Cannot persist local agent proxy authentication; reconnect after secure storage becomes available.',
    );
  }
  return createHmac('sha256', key).update(`${domain}\n${sessionId}`).digest('base64url');
}

export function derivePiProxySessionToken(sessionId: string): string {
  return deriveProxySessionToken('pi', sessionId);
}

/**
 * OMP 的会话 token。
 *
 * 与 Pi 用同一条 owner-scoped 导出密钥,但域前缀不同 —— OMP 的请求经
 * `Authorization: Bearer <token>` 进同一个 loopback proxy(它对 models.yml 的
 * header 值不做环境变量插值,只能走 apiKey env 通道,见
 * `docs/omp-rpc-spike.md` §10),没有域分离的话一个 Pi token 就能认 OMP 的账。
 */
export function deriveOmpProxySessionToken(sessionId: string): string {
  return deriveProxySessionToken('omp', sessionId);
}

/** Test-only process restart simulation; does not delete the persisted key. */
export function resetPiProxyDerivationKeyCacheForTests(): void {
  cachedKey = undefined;
  unregisterClearListener?.();
  unregisterClearListener = null;
}
