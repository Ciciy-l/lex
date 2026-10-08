import { useEffect } from 'react';
import { sharedTaskHostPeer, parseSharedTaskPeer, type SharedTaskListItem } from '@cindy/device-link';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore } from './remoteProjectsStore';
import { bindSharedTaskPushOwner, resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { notifySharedTaskEnded } from './SharedTaskEndedNotice';

/** SharedTask peers have their own authority list, independent of the user's device directory. */
const openLeases = new Map<string, symbol>();
function closeOwnedLink(peer: string, lease: symbol | undefined): void {
  if (!lease || openLeases.get(peer) !== lease) return;
  openLeases.delete(peer);
  void window.electronAPI.deviceLink.closeLink(peer).catch(() => undefined);
}
export function useSharedTaskTasks(): void {
  const { isAuthenticated, dataOwnerId, dataOwnerRecoveryEpoch } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  useEffect(() => {
    if (!isAuthenticated) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const currentOwner = () => !disposed && isDataOwnerGenerationCurrent(owner);
    let busy = false;
    const linked = new Map<string, string>();
    const linkedLeases = new Map<string, symbol>();
    const opening = new Map<string, symbol>();
    const poll = async () => {
      if (busy || !currentOwner()) return;
      busy = true;
      try {
        // Capability is a local negotiated relay fact. Unsupported clients do
        // not poll the account API; offline/unknown retains the last confirmed
        // mirror and remains retryable rather than looking like departure.
        const availability = await window.electronAPI.sharedTask.account({ action: 'status' }) as {
          status?: 'ready' | 'unsupported' | 'offline' | 'unknown';
        };
        if (!currentOwner() || availability?.status !== 'ready') return;
        const sharedTasks = await window.electronAPI.sharedTask.account({ action: 'list' }) as SharedTaskListItem[];
        if (!currentOwner()) return;
        const current = new Set(sharedTasks.map((sharedTask) => sharedTaskHostPeer(sharedTask.sharedTaskId, sharedTask.hostDeviceId)));
        for (const id of remoteProjectsStore.getAllDeviceIds()) {
          if (!parseSharedTaskPeer(id) || current.has(id)) continue;
          notifySharedTaskEnded(id);
          linked.delete(id);
          resetRemoteDataOwnerPushFence(id);
          remoteProjectsStore.removeDevice(id);
          // A stale link may already have been closed by a newer owner/page
          // generation.  Cleanup is best effort and must not turn a revoked
          // mirror into an unhandled rejection.
          void window.electronAPI.deviceLink.closeLink(id).catch(() => undefined);
        }
        for (const sharedTask of sharedTasks) {
          if (!currentOwner()) return;
          const peer = sharedTaskHostPeer(sharedTask.sharedTaskId, sharedTask.hostDeviceId);
          bindSharedTaskPushOwner(peer, sharedTask.ownerAccountId);
          let activeLease: symbol | undefined;
          try {
            if (!linked.has(peer)) {
              activeLease = Symbol(peer);
              openLeases.set(peer, activeLease);
              opening.set(peer, activeLease);
              await window.electronAPI.deviceLink.openLink(peer);
              opening.delete(peer);
              if (!currentOwner()) {
                // This open belongs to the old account/page generation. Do not
                // leave a stale mirror or connection behind.
                closeOwnedLink(peer, activeLease);
                return;
              }
              await window.electronAPI.deviceLink.subscribe(peer, ['session:' + sharedTask.sessionId]);
              if (!currentOwner()) {
                closeOwnedLink(peer, activeLease);
                return;
              }
              linked.set(peer, sharedTask.sessionId);
              linkedLeases.set(peer, activeLease);
            } else {
              activeLease = linkedLeases.get(peer);
            }
            const session = await window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [sharedTask.sessionId]) as Session;
            if (!currentOwner()) return;
            if (session?.id !== sharedTask.sessionId) throw new Error('SharedTask task mismatch');
            remoteProjectsStore.setDeviceSessions(peer, sharedTask.title, [session]);
          } catch {
            // openLink may have succeeded before subscribe/invoke failed, so
            // opening no longer owns the lease. Close whichever generation
            // actually acquired it before allowing the next poll to retry.
            const lease = activeLease ?? opening.get(peer) ?? linkedLeases.get(peer);
            opening.delete(peer);
            linked.delete(peer);
            linkedLeases.delete(peer);
            closeOwnedLink(peer, lease);
            if (!currentOwner()) {
              return;
            }
            remoteProjectsStore.markDeviceDisconnected(peer);
          }
        }
      } catch { /* No authority response is not evidence of departure. */ }
      finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 5_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const [peer, sessionId] of linked) {
        const lease = linkedLeases.get(peer);
        // A newer owner generation may already own this same scoped peer.
        // Its lease keeps the old cleanup from unsubscribing/removing the new
        // mirror or closing its connection.
        if (lease && openLeases.get(peer) === lease) {
          void window.electronAPI.deviceLink.unsubscribe(peer, ['session:' + sessionId]).catch(() => undefined);
          remoteProjectsStore.removeDevice(peer);
          resetRemoteDataOwnerPushFence(peer);
          closeOwnedLink(peer, lease);
        }
      }
      for (const [peer, lease] of opening) {
        closeOwnedLink(peer, lease);
      }
    };
  }, [dataOwnerId, ownerGeneration, dataOwnerRecoveryEpoch, isAuthenticated]);
}
