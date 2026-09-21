import { describe, expect, it, vi } from 'vitest';

import { createPiRuntimeRecovery } from '../pi-runtime-recovery.js';

describe('Pi runtime recovery', () => {
  it('starts an optional runtime in the background without a prior failed prepare', async () => {
    let online = false;
    const prepare = vi.fn(async () => ({ ready: true, path: '/tmp/omp' }));
    const register = vi.fn(() => true);
    const onRegistered = vi.fn();
    const schedule = vi.fn(() => 0);
    const recovery = createPiRuntimeRecovery({
      runtimeName: 'OMP',
      isOnline: () => online,
      prepare,
      register,
      onRegistered,
      retryDelayMs: 60_000,
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    // Offline startup schedules recovery but does not touch the downloader.
    expect(await recovery.start('startup-after-maker-ipcs')).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();

    online = true;
    expect(await recovery.start('manual-retry')).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    expect(onRegistered).toHaveBeenCalledOnce();
    // A runtime which is already registered is not prepared a second time.
    expect(await recovery.start('duplicate')).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it('retries after the network returns and registers Pi once', async () => {
    let online = false;
    let prepareCalls = 0;
    let registered = false;
    const onRegistered = vi.fn();
    const recovery = createPiRuntimeRecovery({
      isOnline: () => online,
      prepare: async () => {
        prepareCalls += 1;
        return { ready: true, path: '/tmp/pi' };
      },
      register: () => {
        if (registered) return false;
        registered = true;
        return true;
      },
      onRegistered,
      retryDelayMs: 60_000,
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('manifest_failed');
    expect(await recovery.retryNow('offline')).toBe(false);
    online = true;
    expect(await recovery.retryNow('online')).toBe(true);
    expect(await recovery.retryNow('duplicate')).toBe(false);
    expect(prepareCalls).toBe(1);
    expect(onRegistered).toHaveBeenCalledOnce();
    expect(recovery.isDisabled()).toBe(false);
    recovery.dispose();
  });

  it('deduplicates concurrent recovery and keeps retryable failure disabled', async () => {
    let resolvePrepare!: (value: { ready: boolean; path?: string; error?: string }) => void;
    const prepare = vi.fn(
      () => new Promise<{ ready: boolean; path?: string; error?: string }>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
      retryDelayMs: 60_000,
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('manifest_failed');
    const first = recovery.retryNow();
    const second = recovery.retryNow();
    expect(first).toBe(second);
    expect(prepare).toHaveBeenCalledOnce();
    resolvePrepare({ ready: false, error: 'still_offline' });
    expect(await first).toBe(false);
    expect(recovery.isDisabled()).toBe(true);
    recovery.dispose();
  });

  it('does not schedule retries for permanent prepare errors', async () => {
    const prepare = vi.fn(async () => ({ ready: true, path: '/tmp/pi' }));
    const schedule = vi.fn(() => 0);
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('asset_missing');
    expect(schedule).not.toHaveBeenCalled();
    expect(await recovery.retryNow('permanent')).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    recovery.dispose();
  });

  it('stops an existing retry loop when a later prepare becomes permanent', async () => {
    const prepare = vi.fn(async () => ({ ready: false, error: 'asset_missing' }));
    const schedule = vi.fn(() => 0);
    const cancel = vi.fn();
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: cancel as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('manifest_failed');
    expect(schedule).toHaveBeenCalledOnce();
    expect(await recovery.retryNow('permanent-after-transient')).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledOnce();
    expect(recovery.isDisabled()).toBe(true);
    recovery.dispose();
  });

  it('honours an explicit retryable override for a permanent-looking error', () => {
    // dev 态 OMP:二进制随时可能被 pnpm install:omp 补上,没有错误码能表达这件事。
    const schedule = vi.fn(() => 0);
    const cancel = vi.fn();
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare: vi.fn(async () => ({ ready: false, error: 'asset_missing' })),
      register: () => true,
      onRegistered: vi.fn(),
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: cancel as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('omp dev binary not found for win32-x64', { retryable: true });
    expect(schedule).toHaveBeenCalledOnce();
    expect(recovery.isDisabled()).toBe(true);
    recovery.dispose();

    const strict = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare: vi.fn(async () => ({ ready: false, error: 'asset_missing' })),
      register: () => true,
      onRegistered: vi.fn(),
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: cancel as unknown as typeof clearTimeout,
    });
    strict.markUnavailable('omp dev binary not found for win32-x64', { retryable: false });
    expect(schedule).toHaveBeenCalledOnce();
    strict.dispose();
  });
});
