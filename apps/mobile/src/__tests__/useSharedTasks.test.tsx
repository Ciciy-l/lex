// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useSharedTasks } from '@/device-link/useSharedTasks';

const state = vi.hoisted(() => ({
  auth: { isAuthenticated: true, accountGeneration: 1 },
  link: { status: 'online', sharedTaskAvailable: false as boolean | undefined, connectionEpoch: 1, openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn(), subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined) },
  api: { list: vi.fn<() => Promise<SharedTaskListItem[]>>(async () => []) },
  store: { getSessions: vi.fn(() => []), removeDevice: vi.fn(), setDeviceSessions: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.link }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => state.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: state.store }));

let root: Root;
let result: readonly SharedTaskListItem[] = [];
function Probe() { result = useSharedTasks(); return null; }
async function render() { await act(async () => root.render(createElement(Probe))); }

const own: SharedTaskListItem = { sharedTaskId: 'owned', sessionId: 'task-owned', ownerAccountId: 'owner', hostDeviceId: 'desktop', title: 'Owned', revision: 1 };
const joined: SharedTaskListItem = { ...own, sharedTaskId: 'joined', sessionId: 'task-joined', ownerAccountId: 'other', title: 'Joined', revision: 2 };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.resetAllMocks();
  state.auth.isAuthenticated = true; state.auth.accountGeneration = 1;
  state.link.status = 'online'; state.link.sharedTaskAvailable = false;
  state.link.connectionEpoch = 1;
  state.api.list.mockResolvedValue([]); state.store.getSessions.mockReturnValue([]);
  state.link.invoke.mockResolvedValue({ id: joined.sessionId });
  setMobileAuthOwner('owner');
  result = [];
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  setMobileAuthOwner(null);
  vi.useRealTimers();
});

describe('mobile shared-task authority polling', () => {
  it('does not poll an old or unknown relay, then resumes after explicit capability', async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(state.api.list).not.toHaveBeenCalled();
    state.link.sharedTaskAvailable = true;
    await render();
    expect(state.api.list).toHaveBeenCalledTimes(1);
    state.link.sharedTaskAvailable = undefined; state.link.status = 'connecting';
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(state.api.list).toHaveBeenCalledTimes(1);
    expect(state.store.removeDevice).not.toHaveBeenCalled();
  });

  it('projects only current-account tasks and opens joined links through task-scoped peers', async () => {
    state.link.sharedTaskAvailable = true;
    state.api.list.mockResolvedValue([own, joined]);
    await render();
    expect(result).toEqual([own]);
    const peer = sharedTaskHostPeer(joined.sharedTaskId, joined.hostDeviceId);
    expect(state.link.openLink).toHaveBeenCalledWith(peer);
    expect(state.link.invoke).toHaveBeenCalledWith(peer, 'local-db:sessions:get', [joined.sessionId]);
    expect(state.store.setDeviceSessions).toHaveBeenCalledWith(peer, joined.title, [{ id: joined.sessionId }]);
  });

  it('keeps the previous mirror on a transient list failure and ignores a late old-account response', async () => {
    state.link.sharedTaskAvailable = true;
    state.api.list.mockResolvedValue([own]);
    await render();
    expect(result).toEqual([own]);
    let finish!: (items: SharedTaskListItem[]) => void;
    state.api.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    setMobileAuthOwner('other'); state.auth.accountGeneration++;
    state.api.list.mockResolvedValue([]);
    await render();
    expect(result).toEqual([]);
    finish([own]);
    await act(async () => Promise.resolve());
    expect(result).toEqual([]);
  });

  it('uses only the task session topic and retries a failed subscription on the next poll', async () => {
    state.link.sharedTaskAvailable = true;
    state.api.list.mockResolvedValue([joined]);
    state.link.subscribe.mockRejectedValueOnce(new Error('temporary subscribe failure'));
    await render();
    const peer = sharedTaskHostPeer(joined.sharedTaskId, joined.hostDeviceId);
    expect(state.link.subscribe).toHaveBeenCalledWith(
      expect.stringContaining(`shared-task:${joined.sharedTaskId}:`),
      peer,
      [`session:${joined.sessionId}`],
    );
    expect(state.link.invoke).not.toHaveBeenCalled();
    state.link.subscribe.mockResolvedValue(undefined);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(state.link.subscribe).toHaveBeenCalledTimes(2);
    expect(state.link.invoke).toHaveBeenCalledWith(peer, 'local-db:sessions:get', [joined.sessionId]);
  });

  it('does not let a late old lease cleanup close a replacement task lease', async () => {
    state.link.sharedTaskAvailable = true;
    let finishOpen!: () => void;
    state.api.list.mockResolvedValue([joined]);
    state.link.openLink.mockImplementationOnce(() => new Promise<void>(resolve => { finishOpen = resolve; }));
    await render();
    const replacement = { ...joined, sessionId: 'task-replacement', revision: joined.revision + 1 };
    state.api.list.mockResolvedValue([replacement]);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    finishOpen();
    await act(async () => Promise.resolve());
    expect(state.link.closeLink).not.toHaveBeenCalled();
    const replacementPeer = sharedTaskHostPeer(replacement.sharedTaskId, replacement.hostDeviceId);
    expect(state.link.openLink).toHaveBeenCalledWith(replacementPeer);
  });
});
