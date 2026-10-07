import { beforeEach, describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { __testing as ownerTesting, getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { __testing, isSharedTaskPushAllowed, registerSharedTaskPushScope } from '@/device-link/sharedTaskPushGuard';

const peer = sharedTaskHostPeer('task-a', 'host-a');

beforeEach(() => {
  __testing.reset();
  ownerTesting.reset();
  setMobileAuthOwner('account-a');
});

describe('shared-task push route guard', () => {
  it('keeps list pushes active after the foreground task releases its subscription', () => {
    const scope = { peer, sharedTaskId: 'task-a', sessionId: 'session-a', hostDeviceId: 'host-a',
      owner: getMobileAuthOwner(), connectionEpoch: 7 };
    const releaseList = registerSharedTaskPushScope(scope);
    const releaseForeground = registerSharedTaskPushScope(scope);
    releaseForeground();
    releaseForeground();
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 7)).toBe(true);
    releaseList();
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 7)).toBe(false);
  });

  it('does not let late old-account or old-connection registration replace a current consumer', () => {
    const scope = { peer, sharedTaskId: 'task-a', sessionId: 'session-a', hostDeviceId: 'host-a',
      owner: getMobileAuthOwner(), connectionEpoch: 7 };
    registerSharedTaskPushScope({ ...scope, connectionEpoch: 8 });
    const releaseLate = registerSharedTaskPushScope(scope);
    releaseLate();
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 8)).toBe(true);
    setMobileAuthOwner('account-b');
    registerSharedTaskPushScope({ ...scope, owner: getMobileAuthOwner(), connectionEpoch: 9 });
    registerSharedTaskPushScope({ ...scope, connectionEpoch: 10 });
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 9)).toBe(true);
  });

  it('accepts only the registered task/session and connection lease', () => {
    const owner = getMobileAuthOwner();
    registerSharedTaskPushScope({
      peer, sharedTaskId: 'task-a', sessionId: 'session-a', hostDeviceId: 'host-a',
      owner, connectionEpoch: 7,
    });
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a', message: 'ok' }, 7)).toBe(true);
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-b' }, 7)).toBe(false);
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 8)).toBe(false);
  });

  it('rejects an unregistered peer, old owner, and stale cleanup', () => {
    const owner = getMobileAuthOwner();
    const releaseOld = registerSharedTaskPushScope({
      peer, sharedTaskId: 'task-a', sessionId: 'session-a', hostDeviceId: 'host-a',
      owner, connectionEpoch: 7,
    });
    const releaseCurrent = registerSharedTaskPushScope({
      peer, sharedTaskId: 'task-a', sessionId: 'session-a', hostDeviceId: 'host-a',
      owner, connectionEpoch: 8,
    });
    releaseOld();
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 8)).toBe(true);
    setMobileAuthOwner('account-b');
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 8)).toBe(false);
    releaseCurrent();
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 8)).toBe(false);
  });

  it('does not accept a scoped key or payload shape as authorization', () => {
    const owner = getMobileAuthOwner();
    registerSharedTaskPushScope({
      peer, sharedTaskId: 'task-a', sessionId: 'session-a', hostDeviceId: 'host-a',
      owner, connectionEpoch: 7,
    });
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a', ownerAccountId: 'account-a' }, undefined)).toBe(false);
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a' }, 7)).toBe(true);
    expect(isSharedTaskPushAllowed(peer, { sessionId: 'session-a', sharedTaskId: 'task-b' }, 7)).toBe(false);
  });
});
