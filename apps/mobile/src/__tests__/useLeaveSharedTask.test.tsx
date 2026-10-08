// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useLeaveSharedTask } from '@/device-link/useLeaveSharedTask';

const h = vi.hoisted(() => ({
  confirm: vi.fn(), api: { leave: vi.fn() }, link: { closeLink: vi.fn() },
  remove: vi.fn(), revoke: vi.fn(), revoked: vi.fn(), left: vi.fn(), error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock('@/session/useSharedTaskConfirmation', () => ({ useSharedTaskConfirmation: () => ({ confirm: h.confirm, dialog: null }) }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => h.api }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { removeDevice: h.remove } }));
vi.mock('@/device-link/accessRevoked', () => ({ markDeviceAccessRevoked: h.revoke }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ revokedDevicesStore: { has: h.revoked } }));

let root: Root;
let host: HTMLDivElement;
let resolveConfirm!: (value: boolean) => void;
const peer = sharedTaskHostPeer('shared-task', 'desktop');
function Harness({ enabled = true, deviceId = peer }: { enabled?: boolean; deviceId?: string }) {
  const leave = useLeaveSharedTask({ deviceId, enabled, onLeft: h.left, onError: h.error });
  return <button disabled={leave.busy} onClick={() => void leave.leave()}>leave</button>;
}
const click = () => act(async () => host.querySelector('button')!.click());

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  setMobileAuthOwner('owner');
  h.confirm.mockImplementation(() => new Promise<boolean>(resolve => { resolveConfirm = resolve; }));
  h.api.leave.mockResolvedValue(undefined);
  host = document.createElement('div'); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  setMobileAuthOwner(null);
});

it('opens one confirmation and leaves the task untouched when cancelled', async () => {
  await click(); await click();
  expect(h.confirm).toHaveBeenCalledTimes(1);
  await act(async () => resolveConfirm(false));
  expect(h.api.leave).not.toHaveBeenCalled();
  expect(h.link.closeLink).not.toHaveBeenCalled();
  await click();
  expect(h.confirm).toHaveBeenCalledTimes(2);
});

it('revokes only the scoped peer after the leave API succeeds', async () => {
  let complete!: () => void;
  h.api.leave.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  await click(); await act(async () => resolveConfirm(true));
  expect(h.api.leave).toHaveBeenCalledWith('shared-task');
  expect(h.link.closeLink).not.toHaveBeenCalled();
  await act(async () => complete());
  expect(h.revoke).toHaveBeenCalledWith(peer);
  expect(h.link.closeLink).toHaveBeenCalledWith(peer);
  expect(h.remove).toHaveBeenCalledWith(peer);
  expect(h.left).toHaveBeenCalledOnce();
});

it('retains access on failure and allows a later retry', async () => {
  h.api.leave.mockRejectedValue(new Error('offline'));
  await click(); await act(async () => resolveConfirm(true));
  expect(h.error).toHaveBeenCalledWith('sharedTask.retry');
  expect(h.revoke).not.toHaveBeenCalled();
  await click();
  expect(h.confirm).toHaveBeenCalledTimes(2);
});

it('ignores a confirmed leave after the account changes', async () => {
  await click();
  setMobileAuthOwner('other');
  await act(async () => resolveConfirm(true));
  expect(h.api.leave).not.toHaveBeenCalled();
  expect(h.left).not.toHaveBeenCalled();
});
