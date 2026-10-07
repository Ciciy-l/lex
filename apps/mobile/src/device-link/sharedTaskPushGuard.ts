import { parseSharedTaskPeer } from '@cindy/device-link';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';

/**
 * A scoped relay source is not an authorization token by itself.  The provider
 * registers a lease only after the authenticated task snapshot and the exact
 * session subscription have been accepted.  Route-frame admission then uses
 * this table before any shared peer push can reach a cache or store.
 */
export interface SharedTaskPushScope {
  readonly peer: string;
  readonly sharedTaskId: string;
  readonly sessionId: string;
  readonly hostDeviceId: string;
  readonly owner: MobileAuthOwnerGeneration;
  readonly connectionEpoch: number;
}

interface Lease extends SharedTaskPushScope {
  readonly token: number;
}

const leases = new Map<string, Lease>();
let nextToken = 0;

/** Register one task/session lease; an older lease for the same peer is replaced. */
export function registerSharedTaskPushScope(scope: SharedTaskPushScope): () => void {
  const peer = parseSharedTaskPeer(scope.peer);
  if (!peer || peer.role !== 'host'
      || peer.sharedTaskId !== scope.sharedTaskId
      || peer.deviceId !== scope.hostDeviceId
      || !scope.owner.accountKey
      || !Number.isSafeInteger(scope.connectionEpoch) || scope.connectionEpoch < 0
      || !scope.sessionId) return () => undefined;
  const lease: Lease = { ...scope, token: ++nextToken };
  leases.set(scope.peer, lease);
  return () => {
    if (leases.get(scope.peer)?.token === lease.token) leases.delete(scope.peer);
  };
}

/**
 * Validate every identity boundary that is unavailable in a generic push
 * handler: authenticated account generation, relay connection generation,
 * scoped peer task/host, and the task session stamped in the payload.
 */
export function isSharedTaskPushAllowed(
  peerValue: string,
  payload: unknown,
  connectionEpoch: number | undefined,
): boolean {
  const peer = parseSharedTaskPeer(peerValue);
  if (!peer || peer.role !== 'host' || connectionEpoch === undefined) return false;
  const lease = leases.get(peerValue);
  if (!lease || lease.connectionEpoch !== connectionEpoch || !isMobileAuthOwnerCurrent(lease.owner)) return false;
  if (peer.sharedTaskId !== lease.sharedTaskId || peer.deviceId !== lease.hostDeviceId) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  if (sessionId !== lease.sessionId) return false;
  const payloadTask = (payload as { sharedTaskId?: unknown }).sharedTaskId;
  if (payloadTask !== undefined && payloadTask !== lease.sharedTaskId) return false;
  const payloadHost = (payload as { hostDeviceId?: unknown }).hostDeviceId;
  if (payloadHost !== undefined && payloadHost !== lease.hostDeviceId) return false;
  return true;
}

export const __testing = {
  reset(): void {
    leases.clear();
    nextToken = 0;
  },
  size(): number { return leases.size; },
};
