import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers/registry';
import { MOBILE_AGENT_KINDS } from '@/device-link/mobileMakerTransport';

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const catalog = (id: string) => ({ providers: [{ id } as ProviderView] });
const flush = async () => { await vi.advanceTimersByTimeAsync(50); };

describe('catalog invalidation under a slow device link', () => {
  it.each(['cancel', 'clear', 'dispose'] as const)('does not revive blocked work after %s', async (action) => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    let available = false;
    const readProviders = vi.fn(async () => catalog('new'));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null,
      connectionEpoch: () => 1, canRead: () => available });
    refresh.notify('a');
    await flush();
    if (action === 'cancel') refresh.cancel('a');
    else refresh[action]();
    available = true;
    refresh.wake('a');
    refresh.wake();
    await vi.advanceTimersByTimeAsync(30000);
    expect(readProviders).not.toHaveBeenCalled();
    refresh.dispose();
  });
  it('invalidates but does not send background catalog reads to an unavailable peer', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    let available = false;
    const readProviders = vi.fn(async (_id: string) => catalog('new'));
    const readCapabilities = vi.fn(async (_id: string, _agent: string) => null);
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities,
      connectionEpoch: () => 1, canRead: (id) => id !== 'a' || available });
    refresh.notify('a');
    refresh.notify('b');
    await flush();
    expect(readProviders).toHaveBeenCalledExactlyOnceWith('b');
    expect(readCapabilities.mock.calls.every(([id]) => id === 'b')).toBe(true);
    available = true;
    // Recovery needs no second provider notification or picker remount.
    await vi.advanceTimersByTimeAsync(2000);
    expect(readProviders).toHaveBeenCalledWith('a');
    refresh.dispose();
  });
  it.each(['peer', 'connection'] as const)('wakes pending work after long backoff on %s recovery without invalidating completed reads', async (scope) => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    const cache = await import('@/device-link/deviceProvidersCache');
    let available = false;
    const readProviders = vi.fn(async (id: string) => catalog(id));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null,
      connectionEpoch: () => 1, canRead: (id) => id === 'healthy' || available });
    refresh.notify('pending');
    refresh.notify('healthy');
    await vi.advanceTimersByTimeAsync(60000);
    refresh.wake(); // Still unreadable: no RPC and no changed cache generation.
    expect(readProviders).toHaveBeenCalledExactlyOnceWith('healthy');
    const generation = cache.getDeviceProvidersGen('healthy');
    available = true;
    refresh.wake(scope === 'peer' ? 'pending' : undefined);
    await flush();
    expect(readProviders).toHaveBeenCalledTimes(2);
    expect(cache.getCachedDeviceProviders('pending')).toEqual(catalog('pending'));
    refresh.wake();
    await vi.advanceTimersByTimeAsync(30000);
    expect(readProviders).toHaveBeenCalledTimes(2);
    expect(cache.getDeviceProvidersGen('healthy')).toBe(generation);
    refresh.dispose();
  });
  it('does not miss recovery racing the blocked attempt settlement', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    let available = false;
    const readProviders = vi.fn(async () => catalog('new'));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null,
      connectionEpoch: () => 1, canRead: () => available });
    refresh.notify('a');
    vi.advanceTimersByTime(50); // Start gated runner without settling its promise.
    available = true;
    refresh.wake('a');
    await flush();
    expect(readProviders).toHaveBeenCalledExactlyOnceWith('a');
    refresh.dispose();
  });
  it('coalesces four notifications and serializes a burst during a read without committing stale results', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    const cache = await import('@/device-link/deviceProvidersCache');
    const caps = await import('@/session/agentCapabilitiesCache');
    const first = deferred<ReturnType<typeof catalog>>();
    const last = deferred<ReturnType<typeof catalog>>();
    const firstCaps = deferred<unknown>();
    const readProviders = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const ompStale = { availableModels: [{ id: 'omp-stale' }] };
    const ompFresh = { availableModels: [{ id: 'omp-fresh' }] };
    let freshCapabilities = false;
    const readCapabilities = vi.fn((_id: string, agent: string) => freshCapabilities
      ? Promise.resolve(agent === 'omp' ? ompFresh : null)
      : firstCaps.promise);
    const published = vi.fn();
    const ompUpdated = vi.fn();
    cache.subscribeDeviceProviders('a', published);
    const offOmp = caps.subscribeAgentCapabilities('a', 'omp', ompUpdated);
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities, connectionEpoch: () => 7 });
    for (let i = 0; i < 4; i++) { refresh.notify('a'); await vi.advanceTimersByTimeAsync(2); }
    await flush();
    expect(readProviders).toHaveBeenCalledTimes(1);
    expect(readCapabilities).toHaveBeenCalledTimes(MOBILE_AGENT_KINDS.length);
    expect(readCapabilities.mock.calls.map(([, agent]) => agent)).toEqual([...MOBILE_AGENT_KINDS]);
    // A mounted page joins the same capability read as the push refresh.
    const pageRead = vi.fn();
    const joined = caps.fetchAgentCapabilities('a', 'omp', pageRead);
    for (let i = 0; i < 10; i++) refresh.notify('a');
    await flush();
    expect(readProviders).toHaveBeenCalledTimes(1);
    first.resolve(catalog('stale'));
    await flush();
    expect(published).not.toHaveBeenCalled();
    expect(cache.getDeviceFetchEpoch('a')).toBeUndefined();
    expect(readProviders).toHaveBeenCalledTimes(1); // Whole batch still settling.
    freshCapabilities = true;
    firstCaps.resolve(ompStale);
    await joined;
    await flush();
    expect(pageRead).not.toHaveBeenCalled();
    expect(readProviders).toHaveBeenCalledTimes(2);
    expect(readCapabilities).toHaveBeenCalledTimes(MOBILE_AGENT_KINDS.length * 2);
    expect(readCapabilities.mock.calls.map(([, agent]) => agent)).toEqual([
      ...MOBILE_AGENT_KINDS, ...MOBILE_AGENT_KINDS,
    ]);
    expect(caps.getCachedAgentCapabilities(caps.buildAgentCapabilitiesCacheKey('a', 'omp')))
      .toMatchObject({ availableModels: [{ id: 'omp-fresh', label: 'omp-fresh' }] });
    expect(ompUpdated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      availableModels: [expect.objectContaining({ id: 'omp-fresh' })],
    }));
    last.resolve(catalog('latest'));
    await flush();
    expect(published).toHaveBeenCalledExactlyOnceWith(catalog('latest'));
    expect(cache.getDeviceFetchEpoch('a')).toBe(7);
    offOmp();
    refresh.dispose();
  });

  it('failed or cancelled reads cannot block another peer or resurrect a disposed owner', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    const cache = await import('@/device-link/deviceProvidersCache');
    const slow = deferred<ReturnType<typeof catalog>>();
    const readProviders = vi.fn((id: string) => id === 'a' ? slow.promise : Promise.resolve(catalog(id)));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null, connectionEpoch: () => 1 });
    refresh.notify('a');
    refresh.notify('b');
    await flush();
    expect(cache.getCachedDeviceProviders('b')).toEqual(catalog('b'));
    refresh.notify('a');
    refresh.dispose();
    slow.resolve(catalog('old-owner'));
    await flush();
    expect(cache.getCachedDeviceProviders('a')).toBeUndefined();
    expect(readProviders).toHaveBeenCalledTimes(2);
    const nextRead = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(catalog('new-owner'));
    const next = createDeviceCatalogRefresh({ readProviders: nextRead, readCapabilities: async () => null, connectionEpoch: () => 2 });
    next.notify('a');
    await flush();
    expect(cache.getDeviceFetchEpoch('a')).toBeUndefined();
    next.notify('a');
    await flush();
    expect(nextRead).toHaveBeenCalledTimes(2);
    expect(cache.getCachedDeviceProviders('a')).toEqual(catalog('new-owner'));
    expect(cache.getDeviceFetchEpoch('a')).toBe(2);
    next.dispose();
  });

});
