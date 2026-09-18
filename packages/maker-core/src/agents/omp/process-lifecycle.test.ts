import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OmpProcessLifecycle } from './process-lifecycle.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const terminate = vi.fn();
  const state = vi.fn();
  const lifecycle = new OmpProcessLifecycle({
    requestTermination: terminate,
    onState: state,
    startupTimeoutMs: 100,
    gracefulTimeoutMs: 10,
    exitTimeoutMs: 30,
  });
  return { lifecycle, terminate, state };
}

describe('OMP process exit confirmation', () => {
  it('requests termination after startup timeout without claiming exit', async () => {
    const test = fixture();
    await vi.advanceTimersByTimeAsync(100);
    expect(test.lifecycle.getState()).toBe('stopping');
    expect(test.terminate).toHaveBeenCalledExactlyOnceWith(false);
    expect(test.lifecycle.markReady()).toBe(false);
    test.lifecycle.confirmExit();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the startup timer when readiness is confirmed', async () => {
    const test = fixture();
    expect(test.lifecycle.markReady()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.terminate).not.toHaveBeenCalled();
    test.lifecycle.confirmExit();
  });

  it('force-reclaims an owned tree when natural-exit draining reaches its bound', async () => {
    const test = fixture();
    expect(test.lifecycle.markReady()).toBe(true);
    test.lifecycle.beginDrain();
    await vi.advanceTimersByTimeAsync(30);
    expect(test.terminate).toHaveBeenCalledExactlyOnceWith(true);
    expect(test.lifecycle.getState()).toBe('exit-unconfirmed');
    expect(await test.lifecycle.stopAndWait()).toBe(false);
    test.lifecycle.confirmExit();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates once and reports unconfirmed exit rather than success', async () => {
    const test = fixture();
    const first = test.lifecycle.stopAndWait();
    const second = test.lifecycle.stopAndWait();
    await vi.advanceTimersByTimeAsync(10);
    expect(test.terminate.mock.calls).toEqual([[false], [true]]);
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await test.lifecycle.stopAndWait()).toBe(false);
    expect(test.lifecycle.getState()).toBe('exit-unconfirmed');
    expect(vi.getTimerCount()).toBe(0);
    test.lifecycle.confirmExit();
    expect(await test.lifecycle.stopAndWait()).toBe(true);
  });

  it('confirms synchronous exit during termination and cancels escalation', async () => {
    const test = fixture();
    test.terminate.mockImplementation(() => test.lifecycle.confirmExit());
    expect(await test.lifecycle.stopAndWait()).toBe(true);
    expect(test.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates throwing termination and state callbacks while preserving the deadline', async () => {
    const test = fixture();
    test.terminate.mockImplementation(() => {
      throw new Error('private');
    });
    test.state.mockImplementation(() => {
      throw new Error('private');
    });
    expect(() => test.lifecycle.markReady()).not.toThrow();
    expect(test.lifecycle.getState()).toBe('stopping');
    const result = test.lifecycle.stopAndWait();
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toBe(false);
    expect(test.terminate.mock.calls).toEqual([[false], [true]]);
    expect(() => test.lifecycle.confirmExit()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows exit observers to reenter stop without signaling an exited process', async () => {
    const test = fixture();
    test.state.mockImplementation(() => test.lifecycle.stop());
    test.lifecycle.confirmExit();
    expect(await test.lifecycle.stopAndWait()).toBe(true);
    expect(test.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Infinity, NaN, 1.5, 120001])(
    'rejects invalid deadlines before arming timers: %s',
    (timeout) => {
      expect(
        () =>
          new OmpProcessLifecycle({
            requestTermination: vi.fn(),
            onState: vi.fn(),
            startupTimeoutMs: timeout,
          }),
      ).toThrow('timeout');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
