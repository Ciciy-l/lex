import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { watchSharedTaskAccess } from '@/device-link/sharedTaskAccessWatch';

type Detail = { sharedTaskId: string; sessionId: string; status: string };
const active: Detail = { sharedTaskId: 'shared-task', sessionId: 'session', status: 'active' };
const stops: (() => void)[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  vi.useRealTimers();
});

function start(read: () => Promise<Detail>, isCurrent = () => true) {
  const onRevoked = vi.fn();
  const stop = watchSharedTaskAccess({ ...active, read, isCurrent, onRevoked });
  stops.push(stop);
  return { onRevoked, stop };
}

describe('mobile shared-task access reconciliation', () => {
  it('does not overlap reads and only schedules after the prior read settles', async () => {
    let resolve!: (value: Detail) => void;
    const read = vi.fn(() => new Promise<Detail>(done => { resolve = done; }));
    const watch = start(read);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(1);
    resolve(active);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(watch.onRevoked).not.toHaveBeenCalled();
  });

  it('reports active authority only while the watch is current', async () => {
    const onAuthorized = vi.fn();
    const watch = watchSharedTaskAccess({
      ...active,
      read: async () => ({ ...active, hostDeviceId: 'host' }),
      isCurrent: () => true,
      onRevoked: vi.fn(),
      onAuthorized,
    });
    await Promise.resolve();
    expect(onAuthorized).toHaveBeenCalledWith({ ...active, hostDeviceId: 'host' });
    watch();
  });

  it.each([
    new ApiError('UNAUTHORIZED', 401, 'login expired'),
    new ApiError('ROUTE_NOT_FOUND', 404, 'unsupported'),
    new ApiError('NOT_FOUND', 503, 'unavailable'),
    new Error('timeout'),
  ])('does not infer revocation from transient or unsupported error: %s', async error => {
    const read = vi.fn().mockRejectedValue(error);
    const watch = start(read);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watch.onRevoked).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'closed'] as const)('revokes once for an authoritative %s result', async state => {
    const read = state === 'missing'
      ? vi.fn().mockRejectedValue(new ApiError('NOT_FOUND', 404, 'not found'))
      : vi.fn().mockResolvedValue({ ...active, status: 'closed' });
    const watch = start(read);
    const other = start(async () => active);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watch.onRevoked).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(other.onRevoked).not.toHaveBeenCalled();
  });

  it('drops a late authoritative response after stop or owner change', async () => {
    let reject!: (reason: Error) => void;
    let current = true;
    const read = vi.fn(() => new Promise<Detail>((_, fail) => { reject = fail; }));
    const watch = start(read, () => current);
    watch.stop();
    current = false;
    reject(new ApiError('NOT_FOUND', 404, 'not found'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watch.onRevoked).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('ignores a closed detail for another task or session', async () => {
    const watch = start(async () => ({ ...active, sessionId: 'other', status: 'closed' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watch.onRevoked).not.toHaveBeenCalled();
  });
});
