import { describe, expect, it } from 'vitest';

import {
  CloudOwnerRealmConflictError,
  emptyCloudOwnerRealmRegistry,
  hasCrossRealmOwnerCollision,
  mergeCloudOwnerRealmClaims,
  parseCloudOwnerRealmRegistry,
} from '../ownerRealmIsolation.js';

describe('owner realm isolation', () => {
  it('allows the same account within one Cindy service realm', () => {
    expect(
      hasCrossRealmOwnerCollision(
        { realm: 'cn', membershipId: 'member-1' },
        [{ realm: 'cn', membershipId: 'member-1' }],
      ),
    ).toBe(false);
  });

  it('fails closed when CN and Global reuse the same membership id', () => {
    expect(
      hasCrossRealmOwnerCollision(
        { realm: 'global', membershipId: 'member-1' },
        [{ realm: 'cn', membershipId: 'member-1' }],
      ),
    ).toBe(true);
  });

  it('does not confuse different memberships across realms', () => {
    expect(
      hasCrossRealmOwnerCollision(
        { realm: 'global', membershipId: 'member-2' },
        [{ realm: 'cn', membershipId: 'member-1' }],
      ),
    ).toBe(false);
  });

  it('keeps the first realm claim after credentials and the active account are gone', () => {
    const first = mergeCloudOwnerRealmClaims(emptyCloudOwnerRealmRegistry(), [
      { realm: 'global', membershipId: 'member-1' },
    ]).registry;

    // Logout clears the credential vault, not this independent registry. A later login therefore
    // still sees the historical local-data owner even when it has no current-account evidence.
    const afterLogout = parseCloudOwnerRealmRegistry(JSON.stringify(first));
    expect(() =>
      mergeCloudOwnerRealmClaims(afterLogout, [
        { realm: 'cn', membershipId: 'member-1' },
      ]),
    ).toThrowError(CloudOwnerRealmConflictError);
  });

  it('deduplicates same-realm claims and never reassigns an id', () => {
    const first = mergeCloudOwnerRealmClaims(emptyCloudOwnerRealmRegistry(), [
      { realm: 'cn', membershipId: 'member-1' },
      { realm: 'cn', membershipId: 'member-1' },
    ]);
    expect(first.changed).toBe(true);
    expect(first.registry.claims).toEqual([{ realm: 'cn', membershipId: 'member-1' }]);

    const retry = mergeCloudOwnerRealmClaims(first.registry, [
      { realm: 'cn', membershipId: 'member-1' },
    ]);
    expect(retry.changed).toBe(false);
    expect(retry.registry).toEqual(first.registry);
  });

  it('rejects a durable snapshot that already contains cross-realm ambiguity', () => {
    expect(() =>
      parseCloudOwnerRealmRegistry(
        JSON.stringify({
          version: 1,
          claims: [
            { realm: 'global', membershipId: 'member-1' },
            { realm: 'cn', membershipId: 'member-1' },
          ],
        }),
      ),
    ).toThrowError(CloudOwnerRealmConflictError);
  });

  it('rejects malformed, oversized, and empty-id snapshots instead of recovering them', () => {
    expect(() => parseCloudOwnerRealmRegistry('{')).toThrow();
    expect(() =>
      parseCloudOwnerRealmRegistry(
        JSON.stringify({ version: 1, claims: [{ realm: 'cn', membershipId: '' }] }),
      ),
    ).toThrow('invalid cloud owner realm claim');
    expect(() =>
      parseCloudOwnerRealmRegistry(
        JSON.stringify({
          version: 1,
          claims: Array.from({ length: 10_001 }, (_, index) => ({
            realm: 'global',
            membershipId: `member-${index}`,
          })),
        }),
      ),
    ).toThrow('invalid cloud owner realm registry');
  });
});
