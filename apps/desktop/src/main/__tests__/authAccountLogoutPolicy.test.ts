import {
  accountVaultKey,
  passportVaultKey,
  type AuthRegion,
  type StoredAccountMetadata,
} from '@cindy/auth-client';
import { describe, expect, it } from 'vitest';

import {
  isLoggedOutVaultAccount,
  removeLoggedOutVaultAccount,
  restoreLoggedOutVaultAccount,
} from '../authAccountLogoutPolicy';

const realm: AuthRegion = 'global';

function metadata(membershipId: string, passportId: string): StoredAccountMetadata {
  return {
    membershipId,
    passportId,
    displayName: membershipId,
    email: `${membershipId}@example.com`,
    avatarUrl: null,
    kind: 'personal',
    role: 'owner',
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
  };
}

function resource(membershipId: string, passportId: string) {
  return {
    realm,
    refreshToken: `resource-${membershipId}`,
    metadata: metadata(membershipId, passportId),
    lastUsedAt: 1,
  };
}

function passport(passportId: string, membershipIds: string[]) {
  return {
    realm,
    passportId,
    accountRefreshToken: `passport-${passportId}`,
    memberships: membershipIds.map((membershipId) => metadata(membershipId, passportId)),
  };
}

describe('auth account logout policy', () => {
  it('tombstones one deployment without removing identical identities on another or Cindy', () => {
    const scopes = ['lex-server:https://a.example', 'lex-server:https://b.example', 'global'] as const;
    const vault = {
      activeAccountKey: accountVaultKey(scopes[0], 'same-member'),
      resources: Object.fromEntries(scopes.map(scope => [accountVaultKey(scope, 'same-member'), {
        ...resource('same-member', 'same-passport'), realm: scope,
      }])),
      passports: Object.fromEntries(scopes.map(scope => [passportVaultKey(scope, 'same-passport'), {
        ...passport('same-passport', ['same-member']), realm: scope,
      }])),
    };
    const removed = removeLoggedOutVaultAccount(vault, {
      realm: scopes[0], accountKey: vault.activeAccountKey, passportId: 'same-passport',
    });
    expect(removed?.realm).toBe(scopes[0]);
    for (const scope of scopes) {
      expect(isLoggedOutVaultAccount(vault, accountVaultKey(scope, 'same-member'))).toBe(scope === scopes[0]);
      expect(Boolean(vault.resources[accountVaultKey(scope, 'same-member')])).toBe(scope !== scopes[0]);
      expect(Boolean(vault.passports[passportVaultKey(scope, 'same-passport')])).toBe(scope !== scopes[0]);
    }
  });

  it('removes only the current membership while a sibling from the same Passport remains', () => {
    const currentKey = accountVaultKey(realm, 'personal');
    const siblingKey = accountVaultKey(realm, 'org');
    const passportKey = passportVaultKey(realm, 'passport-a');
    const vault = {
      activeAccountKey: currentKey,
      resources: {
        [currentKey]: resource('personal', 'passport-a'),
        [siblingKey]: resource('org', 'passport-a'),
      },
      passports: {
        [passportKey]: passport('passport-a', ['personal', 'org']),
      },
    };

    const removedPassport = removeLoggedOutVaultAccount(vault, {
      accountKey: currentKey,
      realm,
      passportId: 'passport-a',
    });

    expect(removedPassport).toBeNull();
    expect(vault.activeAccountKey).toBeNull();
    expect(vault.resources[currentKey]).toBeUndefined();
    expect(vault.resources[siblingKey]).toBeDefined();
    expect(vault.passports[passportKey]).toBeDefined();
    expect(
      vault.passports[passportKey].memberships.map((membership) => membership.membershipId),
    ).toEqual(['org']);
    expect(isLoggedOutVaultAccount(vault, currentKey)).toBe(true);
    expect(isLoggedOutVaultAccount(vault, siblingKey)).toBe(false);
  });

  it('removes and returns the Passport when its last restorable membership logs out', () => {
    const currentKey = accountVaultKey(realm, 'personal');
    const passportKey = passportVaultKey(realm, 'passport-a');
    const storedPassport = passport('passport-a', ['personal']);
    const vault = {
      activeAccountKey: currentKey,
      resources: { [currentKey]: resource('personal', 'passport-a') },
      passports: { [passportKey]: storedPassport },
    };

    const removedPassport = removeLoggedOutVaultAccount(vault, {
      accountKey: currentKey,
      realm,
      passportId: 'passport-a',
    });

    expect(removedPassport).toBe(storedPassport);
    expect(vault.passports[passportKey]).toBeUndefined();
    expect(vault.resources[currentKey]).toBeUndefined();
    expect(isLoggedOutVaultAccount(vault, currentKey)).toBe(true);
  });

  it('keeps an account hidden through repeated logout and restores it only on explicit login', () => {
    const currentKey = accountVaultKey(realm, 'personal');
    const vault: {
      activeAccountKey: string | null;
      resources: Record<string, ReturnType<typeof resource>>;
      passports: Record<string, ReturnType<typeof passport>>;
      loggedOutAccountKeys?: string[];
    } = {
      activeAccountKey: null,
      resources: {},
      passports: {},
    };
    const identity = { accountKey: currentKey, realm, passportId: 'passport-a' };

    removeLoggedOutVaultAccount(vault, identity);
    removeLoggedOutVaultAccount(vault, identity);
    expect(vault.loggedOutAccountKeys).toEqual([currentKey]);

    restoreLoggedOutVaultAccount(vault, currentKey);
    expect(vault.loggedOutAccountKeys).toBeUndefined();
    expect(isLoggedOutVaultAccount(vault, currentKey)).toBe(false);
  });
});
