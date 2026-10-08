import { useEffect, useRef, useState } from 'react';
import { isSharedTaskPeer, sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { useDeviceLink } from './DeviceLinkContext';
import { useSharedTaskApi } from './useSharedTaskApi';
import { registerSharedTaskPushScope } from './sharedTaskPushGuard';

interface SharedTaskLease {
  readonly token: number;
  readonly peer: string;
  readonly task: SharedTaskListItem;
  readonly ownerKey: string;
  readonly connectionEpoch: number;
  inFlight?: Promise<void>;
  subscribedAttempted: boolean;
  ready: boolean;
  disposed: boolean;
  releasePush?: () => void;
}

/** The authority list is separate from the paired-device roster. */
export function useSharedTasks(): readonly SharedTaskListItem[] {
  const { accountGeneration, isAuthenticated } = useAuth();
  const api = useSharedTaskApi();
  const {
    openLink, closeLink, invoke, subscribe, unsubscribe,
    status, sharedTaskAvailable, connectionEpoch,
  } = useDeviceLink();
  const [owned, setOwned] = useState<{ owner: ReturnType<typeof getMobileAuthOwner>; tasks: SharedTaskListItem[] } | null>(null);
  const leasesRef = useRef(new Map<string, SharedTaskLease>());
  const nextLeaseTokenRef = useRef(0);

  useEffect(() => {
    // An old relay or an unknown connection must not be polled and must not
    // be projected as an empty authoritative list.
    if (!isAuthenticated || status !== 'online' || sharedTaskAvailable !== true) return;
    const owner = getMobileAuthOwner();
    const epoch = connectionEpoch;
    let disposed = false;
    let busy = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const leaseCurrent = (lease: SharedTaskLease) => (
      current() && !lease.disposed && leasesRef.current.get(lease.peer) === lease
        && lease.connectionEpoch === epoch
    );

    const releaseLease = (lease: SharedTaskLease, removeMirror: boolean) => {
      const isCurrentLease = leasesRef.current.get(lease.peer) === lease;
      if (isCurrentLease) leasesRef.current.delete(lease.peer);
      lease.disposed = true;
      lease.releasePush?.();
      lease.releasePush = undefined;
      if (lease.subscribedAttempted) {
        void unsubscribe(lease.ownerKey, lease.peer, [`session:${lease.task.sessionId}`]).catch(() => undefined);
      }
      // Never let an older cleanup close a lease installed by a newer poll or
      // connection epoch.  A removed authoritative task has no replacement,
      // so it is safe to close and evict its mirror.
      if (removeMirror && isCurrentLease) {
        closeLink(lease.peer);
        remoteSessionStore.removeDevice(lease.peer);
      }
    };

    const ensureTask = async (task: SharedTaskListItem): Promise<void> => {
      if (!current()) return;
      const peer = sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
      let lease = leasesRef.current.get(peer);
      const sameIdentity = lease && lease.task.sessionId === task.sessionId
        && lease.task.sharedTaskId === task.sharedTaskId
        && lease.task.hostDeviceId === task.hostDeviceId
        && lease.connectionEpoch === epoch;
      if (lease && !sameIdentity) {
        releaseLease(lease, false);
        lease = undefined;
      }
      if (!lease) {
        const token = ++nextLeaseTokenRef.current;
        lease = {
          token,
          peer,
          task,
          ownerKey: `shared-task:${task.sharedTaskId}:${owner.generation}:${epoch}:${token}`,
          connectionEpoch: epoch,
          subscribedAttempted: false,
          ready: false,
          disposed: false,
        };
        leasesRef.current.set(peer, lease);
      }
      if (lease.ready || lease.inFlight) {
        if (lease.inFlight) await lease.inFlight.catch(() => undefined);
        return;
      }
      const activeLease = lease;
      let attempt!: Promise<void>;
      attempt = (async () => {
        try {
          await openLink(peer);
          if (!leaseCurrent(activeLease)) return;
          activeLease.subscribedAttempted = true;
          await subscribe(activeLease.ownerKey, peer, [`session:${task.sessionId}`]);
          if (!leaseCurrent(activeLease)) return;
          const session = await invoke<RemoteSession>(peer, 'local-db:sessions:get', [task.sessionId]);
          if (!leaseCurrent(activeLease) || session?.id !== task.sessionId) return;
          activeLease.releasePush = registerSharedTaskPushScope({
            peer,
            sharedTaskId: task.sharedTaskId,
            sessionId: task.sessionId,
            hostDeviceId: task.hostDeviceId,
            owner,
            connectionEpoch: epoch,
          });
          remoteSessionStore.setDeviceSessions(peer, task.title, [session]);
          activeLease.ready = true;
        } catch {
          // Keep an offline mirror and leave this lease retryable on the next
          // authority poll; a transient failure is not departure.
        } finally {
          if (activeLease.inFlight === attempt) activeLease.inFlight = undefined;
        }
      })();
      activeLease.inFlight = attempt;
      await attempt.catch(() => undefined);
    };

    const poll = async () => {
      if (busy || !current()) return;
      busy = true;
      try {
        const all = await api.list();
        if (!current()) return;
        const ownedTasks = all.filter(task => task.ownerAccountId === owner.accountId);
        const joinedTasks = all.filter(task => task.ownerAccountId !== owner.accountId);
        setOwned({ owner, tasks: ownedTasks });
        const peers = new Set(joinedTasks.map(task => sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId)));
        for (const [peer, lease] of [...leasesRef.current]) {
          if (!peers.has(peer)) releaseLease(lease, true);
        }
        // Mirrors that predate this owner/list are not authoritative. Keep the
        // existing behavior of evicting only shared peers absent from a
        // successful list; ordinary same-account sessions are untouched.
        for (const task of remoteSessionStore.getSessions()) {
          const peer = task.deviceLinkDeviceId;
          if (peer && isSharedTaskPeer(peer) && !peers.has(peer) && !leasesRef.current.has(peer)) {
            closeLink(peer);
            remoteSessionStore.removeDevice(peer);
          }
        }
        for (const task of joinedTasks) {
          if (!current()) return;
          await ensureTask(task);
        }
      } catch {
        // A transient authority failure is not evidence of departure.
      } finally { busy = false; }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, 5_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const [, lease] of [...leasesRef.current]) {
        // Effect teardown can be caused by a transient relay/capability
        // transition or account generation handoff.  Release this lease's
        // subscription and push guard, but retain the last-known task mirror;
        // only a successful authoritative list may prove that a task is gone.
        if (lease.connectionEpoch === epoch) releaseLease(lease, false);
      }
    };
  }, [accountGeneration, api, closeLink, connectionEpoch, invoke, isAuthenticated, openLink, sharedTaskAvailable, status, subscribe, unsubscribe]);
  return isAuthenticated && owned && isMobileAuthOwnerCurrent(owned.owner) ? owned.tasks : [];
}
