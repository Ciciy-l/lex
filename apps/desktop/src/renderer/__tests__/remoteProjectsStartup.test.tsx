// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ refresh: vi.fn(async () => 'ok') }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, deviceId: 'self', dataOwnerId: 'owner' }),
}));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: state.refresh,
  collectSessionListSnapshot: vi.fn(),
}));
vi.mock('@/features/device-link/mirrorCacheClient', () => ({
  clearMirrorCacheAccountState: vi.fn(),
  readCachedSessionList: async () => [],
  sessionListOwnerTokensReady: () => true,
  cancelSessionListPersist: vi.fn(),
  scheduleSessionListPersist: vi.fn(),
  clearCachedDevice: vi.fn(),
}));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  prefetchDeviceCapabilities: vi.fn(),
  evictDeviceCapabilities: vi.fn(),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  prefetchDeviceProviders: vi.fn(),
  evictDeviceProviders: vi.fn(),
}));
vi.mock('@/hooks/useGitSafetySettings', () => ({
  prefetchDeviceGitSafetySettings: vi.fn(),
  evictDeviceGitSafetySettings: vi.fn(),
}));
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { prefetchDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import { prefetchDeviceProviders } from '@/hooks/useDeviceProviders';
import { prefetchDeviceGitSafetySettings } from '@/hooks/useGitSafetySettings';
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.refresh.mockReset().mockResolvedValue('ok');
  remoteProjectsStore.clear();
  unresponsiveDevicesStore.clearAll();
  vi.mocked(prefetchDeviceCapabilities).mockReset().mockResolvedValue(undefined);
  vi.mocked(prefetchDeviceProviders).mockReset().mockResolvedValue(undefined);
  vi.mocked(prefetchDeviceGitSafetySettings).mockReset().mockResolvedValue(undefined);
  Reflect.deleteProperty(window, 'electronAPI');
});

it.each(['connecting', 'unknown', 'late-subscribe', 'late-snapshot', 'circuit-subscribe', 'circuit-snapshot'])('handles initial %s state without redundant bootstrap', async (initialStatus) => {
  vi.useFakeTimers();
  const listeners: Record<string, (...args: any[]) => void> = {};
  let release!: () => void;
  const subscribe = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let finishState!: (value: { linkStatus: string }) => void;
  const initialState = new Promise<{ linkStatus: string }>((resolve) => { finishState = resolve; });
  const api = {
    getState: async () => {
      if (initialStatus.startsWith('late-')) return initialState;
      if (initialStatus === 'unknown') throw new Error('temporary IPC failure');
      return { linkStatus: initialStatus.startsWith('circuit-') ? 'online' : initialStatus };
    },
    listDevices: async () => ({
      devices: [
        { deviceId: 'peer', name: 'Peer', online: true, remoteControlEnabled: true, isSelf: false },
      ],
    }),
    subscribe,
    unsubscribe: vi.fn(async () => {}),
    ...Object.fromEntries(
      ['Responsiveness', 'Presence', 'Status', 'AccessRevoked', 'ControlTarget'].map((name) => [
        `on${name}Changed`,
        (callback: (...args: any[]) => void) => {
          listeners[name] = callback;
          return () => {};
        },
      ]),
    ),
    onAccessRevoked: () => () => {},
    onRemotePush: () => () => {},
  };
  if (initialStatus.startsWith('circuit-')) {
    remoteProjectsStore.setDeviceSessions('peer', 'Peer', [{ id: 'cached' } as any]);
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: api } });
  const { unmount } = renderHook(() => useDeviceLinkRemoteProjects());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  if (initialStatus.startsWith('circuit-')) {
    let finishRead: (() => void) | undefined;
    if (initialStatus === 'circuit-snapshot') {
      state.refresh.mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = () => resolve('gave-up'); }));
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    }
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(true);
    await act(async () => {
      listeners.Responsiveness({ deviceId: 'peer', unresponsive: true });
      if (initialStatus === 'circuit-snapshot') finishRead?.();
      else release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    expect(remoteProjectsStore.getDeviceSessions('peer').map((row) => row.id)).toEqual(['cached']);
    expect(state.refresh).toHaveBeenCalledTimes(initialStatus === 'circuit-snapshot' ? 1 : 0);
    expect(prefetchDeviceCapabilities).not.toHaveBeenCalled();
    expect(prefetchDeviceProviders).not.toHaveBeenCalled();
    expect(prefetchDeviceGitSafetySettings).not.toHaveBeenCalled();

    await act(async () => {
      listeners.Responsiveness({ deviceId: 'peer', unresponsive: false, recovered: true });
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(state.refresh).toHaveBeenCalledTimes(initialStatus === 'circuit-snapshot' ? 2 : 1);
    expect(prefetchDeviceCapabilities).toHaveBeenCalledOnce();
    expect(prefetchDeviceProviders).toHaveBeenCalledOnce();
    expect(prefetchDeviceGitSafetySettings).toHaveBeenCalledOnce();
    unmount();
    return;
  }
  if (initialStatus.startsWith('late-')) {
    await act(async () => {
      listeners.Presence({ deviceId: 'peer', deviceName: 'Peer', online: true, remoteControlEnabled: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    let finishRead: (() => void) | undefined;
    if (initialStatus === 'late-snapshot') {
      state.refresh.mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = () => resolve('ok'); }));
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    }
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(true);
    await act(async () => { finishState({ linkStatus: 'connecting' }); await vi.advanceTimersByTimeAsync(0); });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    await act(async () => { finishRead?.(); release(); await vi.advanceTimersByTimeAsync(0); });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    expect(state.refresh).toHaveBeenCalledTimes(initialStatus === 'late-snapshot' ? 1 : 0);
    unmount();
    return;
  }
  if (initialStatus === 'unknown') {
    expect(subscribe).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    unmount();
    return;
  }
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => {
    listeners.Status({ status: 'online' });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).toHaveBeenCalledTimes(1);
  await act(async () => {
    listeners.Status({ status: 'online' });
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    listeners.Status({ status: 'connecting' });
    listeners.Status({ status: 'online' });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(async () => {
    listeners.Status({ status: 'connecting' });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  unmount();
});
