import { describe, expect, it, vi } from 'vitest';

import { createManagedModelsService } from '../service.js';
import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../../shared/lexServerManagedModels.js';

const ORIGIN = 'http://127.0.0.1:3101';
const BASE = `${ORIGIN}/v1`;

function catalogPayload(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    budgetEnforced: true,
    models: [
      {
        modelKey: 'm1',
        channelId: '11111111-1111-4111-8111-111111111111',
        name: 'Managed One',
        protocol: 'openai-chat',
        revision: '1',
        contextTokens: 128_000,
        outputTokens: 8_192,
        budgetEnforced: true,
        baseUrl: BASE,
      },
    ],
    ...overrides,
  };
}

function credentialPayload(overrides: Record<string, unknown> = {}) {
  return {
    credential: 'cred-1',
    expiresAt: 1_700_000_900_000,
    baseUrl: BASE,
    budgetEnforced: true,
    ...overrides,
  };
}

function harness(overrides: {
  catalog?: () => Promise<unknown>;
  credential?: () => Promise<unknown>;
  allowLoopbackHttp?: boolean;
  requestTimeoutMs?: number;
} = {}) {
  let now = 1_700_000_000_000;
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let timerId = 0;
  const fetchCatalog = vi.fn(overrides.catalog ?? (async () => catalogPayload()));
  const fetchCredential = vi.fn(overrides.credential ?? (async () => credentialPayload()));
  const publishProvider = vi.fn();
  const service = createManagedModelsService({
    now: () => now,
    fetchCatalog,
    fetchCredential,
    publishProvider,
    allowLoopbackHttp: overrides.allowLoopbackHttp ?? true,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 20_000,
    refreshAheadMs: 5 * 60_000,
    minRefreshIntervalMs: 30_000,
    catalogTtlMs: 60_000,
    retryCooldownMs: 30_000,
    setTimer: (fn, ms) => {
      const id = ++timerId;
      timers.push({ id, fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      const index = timers.findIndex((entry) => entry.id === (timer as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    service,
    fetchCatalog,
    fetchCredential,
    publishProvider,
    advance: (ms: number) => {
      now += ms;
    },
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) timer.fn();
    },
    timers,
  };
}

const lease = (ownerKey = 'owner-a') => ({ origin: ORIGIN, ownerKey });

async function settle(service: ReturnType<typeof harness>['service']): Promise<void> {
  await service.refresh({ forceCatalog: true });
  // Allow the lease-initiated background refresh to finish too.
  await Promise.resolve();
  await Promise.resolve();
}

describe('createManagedModelsService', () => {
  it('publishes a non-routable loading row first, then a routable provider after catalog + credential', async () => {
    const h = harness();
    h.service.setLease(lease());
    await settle(h.service);
    const states = h.publishProvider.mock.calls.map(
      ([provider]) => (provider as { managed?: { state?: string } } | null)?.managed?.state ?? null,
    );
    expect(states[0]).toBe('loading');
    expect(states).toContain('ready');
    const provider = h.service.getProvider();
    expect(provider?.agents).toEqual(['claude-code', 'codex', 'pi']);
    expect(provider?.models.codex?.[0]?.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
    expect(h.service.readCredential('other-provider')).toBeNull();
  });

  it('stays non-routable when the server reports no managed models', async () => {
    const h = harness({ catalog: async () => ({ enabled: false, models: [] }) });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.getProvider()?.agents).toEqual([]);
    expect(h.service.getProvider()?.managed?.state).toBe('not-entitled');
    expect(h.fetchCredential).not.toHaveBeenCalled();
  });

  it('never requests a credential for an empty catalog, and recovers on refresh', async () => {
    let payload: unknown = { enabled: false, models: [] };
    const h = harness({ catalog: async () => payload });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.getProvider()?.managed?.state).toBe('not-entitled');
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    await Promise.resolve();
    expect(h.fetchCredential).not.toHaveBeenCalled();

    payload = catalogPayload();
    await h.service.refresh(); // no explicit force: non-ready must still re-fetch
    expect(h.service.getProvider()?.managed?.state).toBe('ready');
    expect(h.fetchCredential).toHaveBeenCalledOnce();

    h.service.setLease(null);
    expect(h.service.getProvider()).toBeNull();
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
  });

  it('does not amplify a failing credential endpoint from the routing hot path', async () => {
    const fetchCredential = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(Object.assign(new Error('upstream 503'), { code: 'MODEL_UNAVAILABLE', statusCode: 503 }))
      .mockResolvedValue(credentialPayload());
    const h = harness({ credential: fetchCredential });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.fetchCredential).toHaveBeenCalledOnce();
    expect(h.service.getProvider()?.managed?.state).toBe('unavailable');
    for (let i = 0; i < 5; i += 1) {
      expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    }
    await Promise.resolve();
    expect(h.fetchCredential).toHaveBeenCalledOnce();

    h.advance(30_001);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.fetchCredential).toHaveBeenCalledTimes(2);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
  });

  it('does not amplify a credential 403 from the routing hot path', async () => {
    const fetchCredential = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(Object.assign(new Error('forbidden'), {
        code: 'MODEL_DENIED',
        statusCode: 403,
      }));
    const h = harness({ credential: fetchCredential });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.getProvider()?.managed?.state).toBe('not-entitled');
    expect(fetchCredential).toHaveBeenCalledOnce();

    for (let i = 0; i < 5; i += 1) {
      expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCredential).toHaveBeenCalledOnce();

    h.advance(30_001);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCredential).toHaveBeenCalledTimes(2);
  });

  it('lets a real 401 refresh immediately during a credential 403 cooldown', async () => {
    const fetchCredential = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(credentialPayload({ credential: 'cred-1' }))
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), {
        code: 'MODEL_DENIED',
        statusCode: 403,
      }))
      .mockResolvedValueOnce(credentialPayload({ credential: 'cred-2' }));
    const h = harness({ credential: fetchCredential });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');

    await expect(h.service.forceRefreshCredential('cred-1')).resolves.toBeNull();
    expect(fetchCredential).toHaveBeenCalledTimes(2);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCredential).toHaveBeenCalledTimes(2);

    // A real 401 still goes through forceRefreshCredential and bypasses the
    // credential-failure cooldown.
    await expect(h.service.forceRefreshCredential('cred-1')).resolves.toBe('cred-2');
    expect(fetchCredential).toHaveBeenCalledTimes(3);
  });

  it('resets the credential failure cooldown when the account lease changes', async () => {
    const fetchCredential = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), {
        code: 'MODEL_DENIED',
        statusCode: 403,
      }))
      .mockResolvedValueOnce(credentialPayload({ credential: 'cred-1' }));
    const h = harness({ credential: fetchCredential });
    h.service.setLease(lease('owner-a'));
    await settle(h.service);
    expect(h.service.getProvider()?.managed?.state).toBe('not-entitled');
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCredential).toHaveBeenCalledOnce();

    h.service.setLease(lease('owner-b'));
    await settle(h.service);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
    expect(fetchCredential).toHaveBeenCalledTimes(2);
  });

  it('keeps credential 429 mapped to rate-limited', async () => {
    const h = harness({
      credential: async () => {
        throw Object.assign(new Error('slow down'), {
          code: 'RATE_LIMITED',
          statusCode: 429,
        });
      },
    });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.getProvider()?.managed?.state).toBe('rate-limited');
    expect(h.service.getProvider()?.managed?.errorCode).toBe('RATE_LIMITED');
  });

  it('settles a never-resolving catalog request via timeout and stays retryable', async () => {
    const deferred: { resolve?: (value: unknown) => void } = {};
    const fetchCatalog = vi.fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        deferred.resolve = resolve;
      }))
      .mockResolvedValue(catalogPayload());
    const h = harness({ catalog: fetchCatalog, requestTimeoutMs: 20 });
    h.service.setLease(lease());
    const pending = h.service.refresh({ forceCatalog: true });
    await Promise.resolve();
    h.runTimers();
    await expect(pending).resolves.toBeUndefined();
    expect(h.service.getProvider()?.managed?.state).toBe('unavailable');
    expect(h.service.getProvider()?.managed?.errorCode).toBe('MANAGED_REQUEST_TIMEOUT');
    // The retry timer may still hold the timed-out promise; resolve it late and
    // verify a fresh refresh recovers.
    deferred.resolve?.(catalogPayload());
    await h.service.refresh();
    expect(h.service.getProvider()?.managed?.state).toBe('ready');
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
  });

  it('maps 403 / 429 / network failures to localized state buckets', async () => {
    for (const [status, expected] of [
      [403, 'not-entitled'],
      [429, 'rate-limited'],
      [500, 'unavailable'],
    ] as const) {
      const h = harness({
        catalog: async () => {
          throw Object.assign(new Error('denied'), { code: `CODE_${status}`, statusCode: status });
        },
      });
      h.service.setLease(lease());
      await settle(h.service);
      expect(h.service.getProvider()?.managed?.state).toBe(expected);
      expect(h.service.getProvider()?.managed?.errorCode).toBe(`CODE_${status}`);
    }
  });

  it('rejects loopback HTTP credentials in packaged mode (allowLoopbackHttp=false)', async () => {
    const h = harness({ allowLoopbackHttp: false });
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.getProvider()?.agents).toEqual([]);
    expect(h.service.getProvider()?.managed?.state).toBe('unavailable');
  });

  it('drops a late catalog response after the owner/generation lease changed', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const fetchCatalog = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(catalogPayload());
    const h = harness({ catalog: fetchCatalog });
    h.service.setLease(lease('owner-a'));
    await Promise.resolve();
    h.service.setLease(lease('owner-b'));
    await settle(h.service);
    resolveFirst(catalogPayload());
    await Promise.resolve();
    await Promise.resolve();
    // The replacement owner is ready; the old response never overwrites it.
    expect(h.service.getProvider()?.managed?.state).toBe('ready');
    expect(h.service.getProvider()?.managed?.host).toBe('127.0.0.1:3101');
  });

  it('clears the provider and credential on logout / service switch', async () => {
    const h = harness();
    h.service.setLease(lease());
    await settle(h.service);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
    h.service.setLease(null);
    expect(h.service.getProvider()).toBeNull();
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBeNull();
    const last = h.publishProvider.mock.calls.at(-1)?.[0];
    expect(last).toBeNull();
  });

  it('binds stale 401 recovery to the current lease and reuses a newer credential', async () => {
    const h = harness({
      credential: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(credentialPayload({ credential: 'cred-1' }))
        .mockResolvedValueOnce(credentialPayload({ credential: 'cred-2' }))
        .mockResolvedValueOnce(credentialPayload({ credential: 'cred-3' })),
    });
    h.service.setLease(lease());
    await settle(h.service);
    // Unknown stale value within the same lease fails closed.
    await expect(h.service.forceRefreshCredential('never-issued')).resolves.toBeNull();
    // A1 rotates to A2 once; a late A1 401 reuses A2 without another fetch.
    await expect(h.service.forceRefreshCredential('cred-1')).resolves.toBe('cred-2');
    await expect(h.service.forceRefreshCredential('cred-1')).resolves.toBe('cred-2');
    expect(h.fetchCredential).toHaveBeenCalledTimes(2);
    // Empty stale keeps the current-lease refresh path.
    await expect(h.service.forceRefreshCredential(null)).resolves.toBe('cred-3');
    expect(h.fetchCredential).toHaveBeenCalledTimes(3);
  });

  it('does not hand a replacement account credential to a late 401 from the old lease', async () => {
    const h = harness({
      credential: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(credentialPayload({ credential: 'cred-1' }))
        .mockResolvedValueOnce(credentialPayload({ credential: 'cred-2' })),
    });
    h.service.setLease(lease('owner-a'));
    await settle(h.service);
    h.service.setLease(lease('owner-b'));
    await settle(h.service);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-2');
    await expect(h.service.forceRefreshCredential('cred-1')).resolves.toBeNull();
    expect(h.fetchCredential).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent credential refreshes and rotates on force', async () => {
    let release: (value: unknown) => void = () => {};
    const deferred = new Promise((resolve) => {
      release = resolve;
    });
    const h = harness({
      credential: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(credentialPayload())
        .mockImplementationOnce(() => deferred),
    });
    h.service.setLease(lease());
    await settle(h.service);
    const first = h.service.forceRefreshCredential('cred-1');
    const second = h.service.forceRefreshCredential('cred-1');
    await Promise.resolve();
    expect(h.fetchCredential).toHaveBeenCalledTimes(2); // initial + one forced
    release(credentialPayload({ credential: 'cred-2', expiresAt: 1_700_000_900_000 }));
    await expect(Promise.all([first, second])).resolves.toEqual(['cred-2', 'cred-2']);
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-2');
  });

  it('refreshes proactively inside the five-minute window via the sync reader', async () => {
    const h = harness({
      credential: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(credentialPayload({ expiresAt: 1_700_000_200_000 }))
        .mockResolvedValueOnce(credentialPayload({ credential: 'cred-2', expiresAt: 1_700_000_900_000 })),
    });
    h.service.setLease(lease());
    await settle(h.service);
    // now 1_700_000_000_000; expiry +200s => inside the 5-minute refresh window.
    expect(h.service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.fetchCredential).toHaveBeenCalledTimes(2);
  });
});
