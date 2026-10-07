import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { parseSharedTaskPeer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useAuth } from '@/auth/AuthContext';
import { markDeviceAccessRevoked } from './accessRevoked';
import { useDeviceLink } from './DeviceLinkContext';
import { useSharedTaskApi } from './useSharedTaskApi';
import { revokedDevicesStore } from './revokedDevicesStore';
import { watchSharedTaskAccess } from './sharedTaskAccessWatch';
import { registerSharedTaskPushScope } from './sharedTaskPushGuard';

/** Only the foreground guest task reconciles membership; other peers are untouched. */
export function useSharedTaskAccess(
  deviceId: string | undefined,
  sessionId: string,
  appActive: boolean,
  onRevoked?: () => void,
) {
  const api = useSharedTaskApi();
  const { accountGeneration } = useAuth();
  const { status, sharedTaskAvailable, closeLink, connectionEpoch, getSubscriptionIdentity } = useDeviceLink();
  const handleRevoked = useCallback(() => {
    if (!deviceId) return;
    markDeviceAccessRevoked(deviceId);
    closeLink(deviceId);
    onRevoked?.();
  }, [closeLink, deviceId, onRevoked]);
  useFocusEffect(useCallback(() => {
    const peer = deviceId ? parseSharedTaskPeer(deviceId) : null;
    if (!appActive || status !== 'online' || sharedTaskAvailable !== true
        || !deviceId || peer?.role !== 'host' || revokedDevicesStore.has(deviceId)) return;
    const owner = getMobileAuthOwner();
    const epoch = connectionEpoch;
    let releasePush: (() => void) | undefined;
    const stop = watchSharedTaskAccess({
      sharedTaskId: peer.sharedTaskId,
      sessionId,
      read: () => api.get(peer.sharedTaskId),
      isCurrent: () => appActive
        && isMobileAuthOwnerCurrent(owner)
        && status === 'online'
        && sharedTaskAvailable === true,
      onAuthorized: (detail) => {
        // Register the route guard only after the authenticated authority read
        // and exact session subscription both agree on this host/task.
        const subscriptionIdentity = getSubscriptionIdentity?.(deviceId, ['sessions', `session:${sessionId}`]) ?? null;
        if (subscriptionIdentity === null || detail.hostDeviceId !== peer.deviceId
            || detail.status !== 'active' || !isMobileAuthOwnerCurrent(owner)) return;
        releasePush?.();
        releasePush = registerSharedTaskPushScope({
          peer: deviceId,
          sharedTaskId: peer.sharedTaskId,
          sessionId,
          hostDeviceId: peer.deviceId,
          owner,
          connectionEpoch: epoch,
        });
      },
      onRevoked: handleRevoked,
    });
    return () => {
      stop();
      releasePush?.();
      releasePush = undefined;
    };
  }, [accountGeneration, api, appActive, connectionEpoch, deviceId, getSubscriptionIdentity, handleRevoked, sessionId, sharedTaskAvailable, status]));
}
