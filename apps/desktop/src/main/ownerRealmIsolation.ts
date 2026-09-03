import type { AuthRegion } from '@cindy/auth-client';

export interface CloudOwnerIdentity {
  realm: AuthRegion;
  membershipId: string;
}

export interface CloudOwnerRealmRegistry {
  version: 1;
  claims: CloudOwnerIdentity[];
}

const MAX_OWNER_REALM_CLAIMS = 10_000;
const MAX_MEMBERSHIP_ID_LENGTH = 1_024;

export class CloudOwnerRealmConflictError extends Error {
  constructor(
    readonly membershipId: string,
    readonly existingRealm: AuthRegion,
    readonly requestedRealm: AuthRegion,
  ) {
    super(
      `membership ${membershipId} is already claimed by ${existingRealm}, not ${requestedRealm}`,
    );
    this.name = 'CloudOwnerRealmConflictError';
  }
}

export function emptyCloudOwnerRealmRegistry(): CloudOwnerRealmRegistry {
  return { version: 1, claims: [] };
}

function assertValidIdentity(value: unknown): asserts value is CloudOwnerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid cloud owner realm claim');
  }
  const candidate = value as Partial<CloudOwnerIdentity>;
  if (
    (candidate.realm !== 'cn' && candidate.realm !== 'global') ||
    typeof candidate.membershipId !== 'string' ||
    candidate.membershipId.length === 0 ||
    candidate.membershipId.length > MAX_MEMBERSHIP_ID_LENGTH
  ) {
    throw new Error('invalid cloud owner realm claim');
  }
}

/** Parse the durable registry without accepting partial or ambiguous claims. */
export function parseCloudOwnerRealmRegistry(raw: string): CloudOwnerRealmRegistry {
  const parsed = JSON.parse(raw) as Partial<CloudOwnerRealmRegistry>;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.claims) ||
    parsed.claims.length > MAX_OWNER_REALM_CLAIMS
  ) {
    throw new Error('invalid cloud owner realm registry');
  }

  const registry = emptyCloudOwnerRealmRegistry();
  const realmByMembershipId = new Map<string, AuthRegion>();
  for (const claim of parsed.claims) {
    assertValidIdentity(claim);
    const existing = realmByMembershipId.get(claim.membershipId);
    if (existing && existing !== claim.realm) {
      throw new CloudOwnerRealmConflictError(claim.membershipId, existing, claim.realm);
    }
    if (existing) continue;
    realmByMembershipId.set(claim.membershipId, claim.realm);
    registry.claims.push({ realm: claim.realm, membershipId: claim.membershipId });
  }
  return registry;
}

/**
 * Add verified identities without ever reassigning a bare membership id.
 * The caller must hold the cross-process security-boundary lock through the
 * durable write. Returning a new value keeps failed writes from mutating the
 * in-memory representation of the last valid snapshot.
 */
export function mergeCloudOwnerRealmClaims(
  current: CloudOwnerRealmRegistry,
  identities: readonly CloudOwnerIdentity[],
): { registry: CloudOwnerRealmRegistry; changed: boolean } {
  const claims = current.claims.map((claim) => ({ ...claim }));
  const realmByMembershipId = new Map<string, AuthRegion>();
  for (const claim of claims) {
    assertValidIdentity(claim);
    const existing = realmByMembershipId.get(claim.membershipId);
    if (existing && existing !== claim.realm) {
      throw new CloudOwnerRealmConflictError(claim.membershipId, existing, claim.realm);
    }
    realmByMembershipId.set(claim.membershipId, claim.realm);
  }

  let changed = false;
  for (const identity of identities) {
    assertValidIdentity(identity);
    const existing = realmByMembershipId.get(identity.membershipId);
    if (existing && existing !== identity.realm) {
      throw new CloudOwnerRealmConflictError(identity.membershipId, existing, identity.realm);
    }
    if (existing) continue;
    if (claims.length >= MAX_OWNER_REALM_CLAIMS) {
      throw new Error('cloud owner realm registry is full');
    }
    realmByMembershipId.set(identity.membershipId, identity.realm);
    claims.push({ realm: identity.realm, membershipId: identity.membershipId });
    changed = true;
  }

  return { registry: { version: 1, claims }, changed };
}

/**
 * The Cindy CN and Global services do not promise one shared membership-id
 * namespace. Until the Profile Registry owns local storage by (realm, id), a
 * duplicate bare id must fail closed instead of opening another realm's data.
 */
export function hasCrossRealmOwnerCollision(
  target: CloudOwnerIdentity,
  known: readonly CloudOwnerIdentity[],
): boolean {
  return known.some(
    (identity) =>
      identity.membershipId === target.membershipId && identity.realm !== target.realm,
  );
}
