import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  persistedKey: null as string | null,
  clearListeners: [] as Array<() => void>,
  failWrites: 0,
  writes: 0,
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readAgentProxyDerivationKey: vi.fn(() => h.persistedKey),
  writeAgentProxyDerivationKey: vi.fn((value: string) => {
    if (h.failWrites > 0) {
      h.failWrites -= 1;
      return false;
    }
    h.persistedKey = value;
    h.writes += 1;
    return true;
  }),
  addProviderSecretsClearedListener: vi.fn((listener: () => void) => {
    h.clearListeners.push(listener);
    return () => undefined;
  }),
}));

import {
  derivePiProxySessionToken,
  resetPiProxyDerivationKeyCacheForTests,
} from '../pi-proxy-session-token.js';
import { deriveOmpProxySessionToken } from '../omp-proxy-session-token.js';

describe('agent proxy session token derivation', () => {
  beforeEach(() => {
    h.persistedKey = null;
    h.clearListeners.length = 0;
    h.failWrites = 0;
    h.writes = 0;
    resetPiProxyDerivationKeyCacheForTests();
  });

  it('keeps tokens across a Desktop restart while isolating sessions and engines', () => {
    const firstPi = derivePiProxySessionToken('session-a');
    const firstOmp = deriveOmpProxySessionToken('session-a');
    expect(firstPi).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(firstOmp).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(firstOmp).not.toBe(firstPi);
    expect(h.writes).toBe(1);

    resetPiProxyDerivationKeyCacheForTests();
    const piAfterRestart = derivePiProxySessionToken('session-a');
    const ompAfterRestart = deriveOmpProxySessionToken('session-a');
    const otherSession = derivePiProxySessionToken('session-b');

    expect(piAfterRestart).toBe(firstPi);
    expect(ompAfterRestart).toBe(firstOmp);
    expect(otherSession).not.toBe(firstPi);
    expect(h.writes).toBe(1);
  });

  it('rotates every engine domain after the owner secret boundary is cleared', () => {
    const firstPi = derivePiProxySessionToken('session-a');
    const firstOmp = deriveOmpProxySessionToken('session-a');
    h.persistedKey = null;
    for (const listener of h.clearListeners) listener();

    const nextPi = derivePiProxySessionToken('session-a');
    const nextOmp = deriveOmpProxySessionToken('session-a');
    expect(nextPi).not.toBe(firstPi);
    expect(nextOmp).not.toBe(firstOmp);
    expect(nextPi).not.toBe(nextOmp);
    expect(h.writes).toBe(2);
  });

  it('retries secure persistence after a transient write failure', () => {
    h.failWrites = 1;

    expect(() => derivePiProxySessionToken('session-a')).toThrow(
      'AGENT_PROXY_DERIVATION_KEY_UNAVAILABLE',
    );
    expect(derivePiProxySessionToken('session-a')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(h.writes).toBe(1);
  });
});
