import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RendererBootGuard,
  shouldMarkRendererBootAliveFromLog,
  type BootGuardTarget,
} from '../renderer-boot-guard';

function makeTarget(overrides: Partial<BootGuardTarget> = {}): BootGuardTarget & {
  reloadIgnoringCache: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => false,
    reloadIgnoringCache: vi.fn(),
    ...overrides,
  } as BootGuardTarget & { reloadIgnoringCache: ReturnType<typeof vi.fn> };
}

function makeGuard(
  target: BootGuardTarget,
  opts: { timeoutMs?: number; maxReloads?: number } = {},
) {
  const logError = vi.fn();
  const logInfo = vi.fn();
  const guard = new RendererBootGuard(target, {
    timeoutMs: opts.timeoutMs ?? 1000,
    maxReloads: opts.maxReloads ?? 2,
    logError,
    logInfo,
  });
  return { guard, logError, logInfo };
}

describe('RendererBootGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not treat the dynamic entry failure report as a boot-ready signal', () => {
    expect(shouldMarkRendererBootAliveFromLog('renderer/entry')).toBe(false);
    expect(shouldMarkRendererBootAliveFromLog('renderer/app')).toBe(true);
  });

  it('markAlive 在超时前到达 → 不 reload 不报错', () => {
    const target = makeTarget();
    const { guard, logError } = makeGuard(target);
    guard.start();
    guard.markAlive();
    vi.advanceTimersByTime(10_000);
    expect(target.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('超时未存活 → 记 error 并 reload,直到 maxReloads 后放弃', () => {
    const target = makeTarget();
    const { guard, logError } = makeGuard(target, { timeoutMs: 1000, maxReloads: 2 });
    guard.start();

    vi.advanceTimersByTime(1000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(2);

    // 第三轮超时:不再 reload,记终局日志
    vi.advanceTimersByTime(1000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(3);
    expect(String(logError.mock.calls[2][0])).toContain('giving up');

    // 之后彻底静默
    vi.advanceTimersByTime(60_000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(2);
  });

  it('reload 后收到存活信号 → 记恢复 info,看门狗永久解除', () => {
    const target = makeTarget();
    const { guard, logInfo } = makeGuard(target);
    guard.start();
    vi.advanceTimersByTime(1000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(1);

    guard.markAlive();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(String(logInfo.mock.calls[0][0])).toContain('recovered');

    // 解除后再 start 也不再武装
    guard.start();
    vi.advanceTimersByTime(10_000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });

  it('dispose 后超时不再触发任何动作', () => {
    const target = makeTarget();
    const { guard, logError } = makeGuard(target);
    guard.start();
    guard.dispose();
    vi.advanceTimersByTime(10_000);
    expect(target.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('窗口已销毁时超时 → 静默跳过 reload', () => {
    const target = makeTarget({ isDestroyed: () => true });
    const { guard, logError } = makeGuard(target);
    guard.start();
    vi.advanceTimersByTime(1000);
    expect(target.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('start 幂等:重复调用不叠加定时器', () => {
    const target = makeTarget();
    const { guard } = makeGuard(target, { timeoutMs: 1000, maxReloads: 1 });
    guard.start();
    guard.start();
    guard.start();
    vi.advanceTimersByTime(1000);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });
});
