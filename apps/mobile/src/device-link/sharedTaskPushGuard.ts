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

const leases = new Map<string, Map<number, Lease>>();
let nextToken = 0;

/** Independent list and foreground consumers retain their own authorization. */
export function registerSharedTaskPushScope(scope: SharedTaskPushScope): () => void {
  const peer = parseSharedTaskPeer(scope.peer);
  if (!peer || peer.role !== 'host'
      || peer.sharedTaskId !== scope.sharedTaskId
      || peer.deviceId !== scope.hostDeviceId
      || !scope.owner.accountKey || !isMobileAuthOwnerCurrent(scope.owner)
      || !Number.isSafeInteger(scope.connectionEpoch) || scope.connectionEpoch < 0
      || !scope.sessionId) return () => undefined;
  const lease: Lease = { ...scope, token: ++nextToken };
  let consumers = leases.get(scope.peer);
  const previous = consumers?.values().next().value;
  if (previous && isMobileAuthOwnerCurrent(previous.owner)
      && previous.connectionEpoch > scope.connectionEpoch) return () => undefined;
  if (!previous || previous.connectionEpoch !== scope.connectionEpoch
      || previous.sessionId !== scope.sessionId
      || previous.owner.accountKey !== scope.owner.accountKey
      || previous.owner.generation !== scope.owner.generation) {
    consumers = new Map();
    leases.set(scope.peer, consumers);
  }
  consumers!.set(lease.token, lease);
  return () => {
    if (leases.get(scope.peer) !== consumers) return;
    consumers!.delete(lease.token);
    if (consumers!.size === 0) leases.delete(scope.peer);
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
  const lease = leases.get(peerValue)?.values().next().value;
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
