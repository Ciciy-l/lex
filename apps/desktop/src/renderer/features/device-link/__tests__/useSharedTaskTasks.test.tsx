// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useSharedTaskTasks } from '../useSharedTaskTasks';

const state = vi.hoisted(() => ({
  account: vi.fn(),
  openLink: vi.fn(),
  closeLink: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  invoke: vi.fn(),
  removeDevice: vi.fn(),
  markDisconnected: vi.fn(),
  setDeviceSessions: vi.fn(),
  bindOwner: vi.fn(),
  resetFence: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, dataOwnerId: 'account-a', dataOwnerRecoveryEpoch: 0 }),
}));
vi.mock('../remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getAllDeviceIds: () => [],
    removeDevice: state.removeDevice,
    markDeviceDisconnected: state.markDisconnected,
    setDeviceSessions: state.setDeviceSessions,
  },
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({
  bindSharedTaskPushOwner: state.bindOwner,
  resetRemoteDataOwnerPushFence: state.resetFence,
}));
vi.mock('../SharedTaskEndedNotice', () => ({ notifySharedTaskEnded: vi.fn() }));

const task = {
  sharedTaskId: 'task-a', sessionId: 'session-a', ownerAccountId: 'owner-a',
  hostDeviceId: 'host-a', title: 'Shared task', revision: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setDataOwnerGeneration('account-a');
  state.account.mockImplementation(async ({ action }: { action: string }) =>
    action === 'status' ? { status: 'ready' } : [task]);
  state.openLink.mockResolvedValue({});
  state.closeLink.mockResolvedValue({ ok: true });
  state.subscribe.mockResolvedValue({ ok: true });
  state.unsubscribe.mockResolvedValue({ ok: true });
  state.invoke.mockResolvedValue({ id: task.sessionId, title: task.title });
  Object.assign(window, { electronAPI: {
    sharedTask: { account: state.account },
    deviceLink: {
      openLink: state.openLink, closeLink: state.closeLink, subscribe: state.subscribe,
      unsubscribe: state.unsubscribe, invoke: state.invoke,
    },
  } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); setDataOwnerGeneration(null); });
async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

describe('useSharedTaskTasks capability and connection lifecycle', () => {
  it('does not poll the account list when the relay reports unsupported', async () => {
    state.account.mockResolvedValue({ status: 'unsupported' });
    renderHook(() => useSharedTaskTasks());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
    expect(state.account.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.account).not.toHaveBeenCalledWith({ action: 'list' });
  });

  it('retains the last mirror and retries status while offline', async () => {
    state.account.mockResolvedValue({ status: 'offline' });
    renderHook(() => useSharedTaskTasks());
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(state.account).not.toHaveBeenCalledWith({ action: 'list' });
    expect(state.removeDevice).not.toHaveBeenCalled();
    expect(state.markDisconnected).not.toHaveBeenCalled();
  });

  it('reopens and resubscribes a guest after a refresh failure', async () => {
    let attempts = 0;
    state.invoke.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary disconnect');
      return { id: task.sessionId, title: task.title };
    });
    renderHook(() => useSharedTaskTasks());
    await flushAsync();
    expect(state.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); await Promise.resolve(); });
    await flushAsync();
    expect(state.invoke).toHaveBeenCalledTimes(2);
    expect(state.openLink).toHaveBeenCalledTimes(2);
    expect(state.subscribe).toHaveBeenCalledTimes(2);
    expect(state.markDisconnected).toHaveBeenCalledWith(expect.stringContaining('task-a'));
    expect(state.closeLink).toHaveBeenCalledWith(expect.stringContaining('task-a'));
  });

  it('closes a link whose subscribe fails after open before retrying', async () => {
    let attempts = 0;
    state.subscribe.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary subscribe failure');
      return { ok: true };
    });
    renderHook(() => useSharedTaskTasks());
    await flushAsync();
    expect(state.subscribe).toHaveBeenCalledTimes(1);
    expect(state.closeLink).toHaveBeenCalledWith(expect.stringContaining('task-a'));
    await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); await Promise.resolve(); });
    await flushAsync();
    expect(state.subscribe).toHaveBeenCalledTimes(2);
    expect(state.invoke).toHaveBeenCalledTimes(1);
  });

  it('closes only a stale generation open and never subscribes it', async () => {
    let finish!: (value: unknown) => void;
    state.openLink.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderHook(() => useSharedTaskTasks());
    await flushAsync();
    expect(state.openLink).toHaveBeenCalledTimes(1);
    await act(async () => {
      setDataOwnerGeneration('account-b');
      finish({});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.closeLink).toHaveBeenCalledWith(expect.stringContaining('task-a'));
    expect(state.subscribe).not.toHaveBeenCalled();
    expect(state.setDeviceSessions).not.toHaveBeenCalled();
  });
});
