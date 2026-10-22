import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, authServiceFromScope, authServiceRealm, authServiceScope, isAuthServiceScope, storedAuthServiceScope } from '@cindy/auth-client';
import { normalizeLexRefreshFailureCode } from '../authRefreshFailure';
import { parseDesktopAccountKey, parseDesktopLoginServiceInput } from '../../shared/authIpc';
import { removeLoggedOutVaultAccount } from '../authAccountLogoutPolicy';

// Execute the real Main functions against synthetic disk/transport boundaries.
// No Electron profile, safeStorage key, deployed server, or real identity is read.
const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8');
const ast = ts.createSourceFile('authManager.ts', source, ts.ScriptTarget.ES2022, true);
function load(names: string[], deps: Record<string, unknown>, state = '', result = names.join(',')) {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text));
  if (functions.length !== names.length) throw new Error('Missing lifecycle function');
  const code = ts.transpileModule(functions.map(node => node.getText(ast).replace(/^export /u, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('deps', 'const {' + Object.keys(deps).join(',') + '}=deps;' + state + code + ';return {' + result + '};')(deps);
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('lex-service-test-')) throw new Error('Invalid fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const metadata = { membershipId: 'same-member', passportId: 'same-passport', displayName: 'Synthetic', email: 'fixture@example.test', avatarUrl: null, kind: 'org', role: 'member', orgId: 'org', orgName: 'Fixture', orgLogoUrl: null };
const A = 'lex-server:https://a.example' as const;
const B = 'lex-server:https://b.example' as const;
const key = (scope: string, id: string) => JSON.stringify([scope, id]);
const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

function logoutFixture(scope: typeof A | typeof B | 'global', options: { writeFailure?: boolean; replacementDuringWrite?: boolean; savedFallback?: boolean } = {}) {
  const accountKey = key(scope, metadata.membershipId);
  const vault = { activeAccountKey: accountKey, resources: { [accountKey]: { realm: scope, metadata, refreshToken: 'synthetic-resource' } },
    passports: { [key(scope, metadata.passportId)]: { realm: scope, passportId: metadata.passportId, memberships: [metadata], accountRefreshToken: 'synthetic-account' } } };
  const remove = vi.fn();
  const revoke = vi.fn();
  const commit = vi.fn(async (input: { nextMode: string; validateBeforeCommit: () => boolean }) => {
    expect(input.validateBeforeCommit()).toBe(true);
    expect(remove).toHaveBeenCalledWith('session');
    expect(vault.resources[accountKey]).toBeUndefined();
    api.clearSession();
  });
  const switchSaved = vi.fn(async (_key: string, input: { validateBeforeCommit: (epoch: number) => void }) => { input.validateBeforeCommit(1); });
  let api: ReturnType<typeof load>;
  api = load(['logout', 'isCindyServiceActive'], {
    AuthApiError, authServiceFromScope, isPassiveSharedUserDataInstance: () => false,
    authServerUrl: () => scope === 'global' ? 'https://auth.example.test' : scope.slice('lex-server:'.length),
    readAuthAccountVault: () => vault, accountVaultKey: key,
    savedAccountSummaries: () => options.savedFallback ? [{ accountKey: key(B, 'other-member') }] : [],
    switchSavedAccount: switchSaved, isUnavailableSavedAccountError: () => false, isRetryableSavedAccountSwitchError: () => false,
    mutateAuthAccountVault: async (operation: (value: typeof vault) => void) => {
      if (options.writeFailure) throw new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'Synthetic write failure');
      if (options.replacementDuringWrite) api.replaceOwner();
      operation(vault);
    },
    removeLoggedOutVaultAccount, removeSafe: remove, AUTH_SESSION_KEY: 'session',
    LEGACY_RESOURCE_REFRESH_TOKEN_KEY: 'legacy-resource', LEGACY_ACCOUNT_REFRESH_TOKEN_KEY: 'legacy-account', LEGACY_REFRESH_TOKEN_KEY: 'legacy-old',
    clearAccountDeletionReceipt: vi.fn(), withAccountFreeOwnerCommit: commit, revokeLoggedOutAccountBestEffort: revoke,
  }, 'let activeAuthRealm=' + JSON.stringify(scope) + ';let authStateEpoch=1;let currentUser={id:' + JSON.stringify(metadata.membershipId) + ',passportId:' + JSON.stringify(metadata.passportId) + '};const accessToken="synthetic-access";',
  'logout,replaceOwner:()=>{authStateEpoch+=1;currentUser={id:"replacement",passportId:"other-passport"};},clearSession:()=>{authStateEpoch+=1;activeAuthRealm="global";currentUser=null;}');
  return { api, vault, commit, remove, switchSaved, revoke };
}

describe('explicit Lex logout landing', () => {
  it.each([A, B])('returns %s to the local owner only after durable account cleanup', async scope => {
    const fixture = logoutFixture(scope);
    await fixture.api.logout();
    expect(fixture.commit).toHaveBeenCalledOnce();
    expect(fixture.commit.mock.calls[0][0].nextMode).toBe('local');
    expect(fixture.remove.mock.calls.map(([name]) => name)).toEqual(['session']);
    expect(fixture.revoke).toHaveBeenCalledWith({ accessToken: 'synthetic-access', authBaseUrl: scope.slice('lex-server:'.length),
      passport: expect.objectContaining({ realm: scope }) });
  });

  it('keeps the existing Cindy signed-out landing', async () => {
    const fixture = logoutFixture('global');
    await fixture.api.logout();
    expect(fixture.commit.mock.calls[0][0].nextMode).toBe('signed-out');
  });

  it('preserves the normal saved-account fallback without committing a local owner', async () => {
    const fixture = logoutFixture(A, { savedFallback: true });
    await fixture.api.logout();
    expect(fixture.switchSaved).toHaveBeenCalledOnce();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it.each([{ writeFailure: true }, { replacementDuringWrite: true }])('does not enter local on an unsuccessful or stale logout: %j', async options => {
    const fixture = logoutFixture(A, options);
    await expect(fixture.api.logout()).rejects.toMatchObject({ code: options.writeFailure ? 'CREDENTIAL_STORE_UNAVAILABLE' : 'AUTH_FLOW_SUPERSEDED' });
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });
});

describe('service-scoped saved credentials', () => {
  it.each([A, B, 'global', 'cn'])('does not clear legacy Cindy credentials when expiring %s', scope => {
    const remove = vi.fn();
    const api = load(['clearAuth', 'isCindyServiceActive'], {
      credentialStoreHealth: { reset: vi.fn() }, resetLoginFlowState: vi.fn(),
      clearReplacementIntegrationReloadTimers: vi.fn(), isPassiveSharedUserDataInstance: () => false,
      AUTH_SESSION_KEY: 'session', LEGACY_RESOURCE_REFRESH_TOKEN_KEY: 'legacy-resource',
      LEGACY_ACCOUNT_REFRESH_TOKEN_KEY: 'legacy-account', LEGACY_REFRESH_TOKEN_KEY: 'legacy-old',
      removeSafe: remove, resetActiveAuthRealmToBuild: vi.fn(), canaryFlagStore: { clear: vi.fn() },
      clearPerAccountIntegrationsInBackground: vi.fn(),
    }, 'let activeAuthRealm=' + JSON.stringify(scope) + ';let authStateEpoch=0,loginFlowEpoch=0,accessToken,pendingAccountToken,pendingAccountRefreshToken,pendingAccountMemberships,currentUser,accountDeletionRestoredNoticePending,confirmedAccountDeletionCredential,persistedRefreshTokenNeedsIdentityCheck,lastAcceptedRefreshToken;let refreshTimer=null;');
    api.clearAuth({ notify: false, deferSessionCommit: true });
    expect(remove.mock.calls.map(([key]) => key)).toEqual(scope === 'cn' || scope === 'global'
      ? ['session', 'legacy-resource', 'legacy-account', 'legacy-old'] : ['session']);
  });

  it('does not rotate a replacement owner when an old runtime refresh waited for the lease', async () => {
    let acquire!: () => Promise<boolean>;
    const lease = vi.fn((_scope: string, operation: () => Promise<boolean>) =>
      new Promise<boolean>(resolve => { acquire = async () => { const result = await operation(); resolve(result); return result; }; }));
    const readSession = vi.fn(() => ({ realm: A, refreshToken: 'synthetic' }));
    const api = load(['refresh'], {
      getActiveAppSession: () => ({ mode: 'cloud' }), readPersistedAuthSession: readSession,
      withLexAuthRotation: lease, log,
    }, 'let authStateEpoch=1,activeAuthRealm=' + JSON.stringify(A) + ';const refreshFlights=new Map();',
    'refresh,switchOwner:()=>{authStateEpoch++}');
    const first = api.refresh(); const duplicate = api.refresh();
    expect(lease).toHaveBeenCalledTimes(1);
    api.switchOwner();
    await acquire();
    await expect(first).resolves.toBe(false);
    await expect(duplicate).resolves.toBe(false);
    // Only the captures before acquiring the lease ran. No credential was re-read or sent afterwards.
    expect(readSession).toHaveBeenCalledTimes(2);
  });

  it('does not clear the active deployment when a different on-disk service rejects refresh', async () => {
    const expire = vi.fn();
    const retry = vi.fn();
    const api = load(['refresh'], {
      getActiveAppSession: () => ({ mode: 'cloud' }),
      readPersistedAuthSession: () => ({ realm: B, refreshToken: 'synthetic-b' }),
      withLexAuthRotation: (_scope: string, operation: () => unknown) => operation(),
      credentialStoreHealth: { noteRecovered: () => false },
      loadClientEndpointsForRealm: vi.fn(async () => undefined),
      runAuthRefreshWithReplacementRetry: vi.fn(async () => ({
        result: { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } },
        failureAction: { kind: 'definitive-failure' }, requestedToken: 'synthetic-b', replacementRetries: 0,
      })),
      expireRuntimeAuth: expire, getRefreshErrorCode: (result: any) => result.data?.error?.code,
      resolveSessionExpiredReason: () => 'expired', scheduleRefreshRetryAfterTransientFailure: retry, log,
    }, 'let authStateEpoch=1,activeAuthRealm=' + JSON.stringify(A) + ';const refreshFlights=new Map();let currentUser={id:1},lastAcceptedRefreshToken=null;');
    await expect(api.refresh()).resolves.toBe(false);
    expect(expire).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('does not replace a newer owner with signed-out when cold refresh waited for the lease', async () => {
    let acquire!: () => Promise<unknown>;
    const signedOut = vi.fn();
    const next = { mode: 'cloud', dataOwnerId: 'synthetic-owner-b' };
    const read = vi.fn(() => ({ realm: B, refreshToken: 'synthetic-b' }));
    const api = load(['runColdStartRefreshFlow'], {
      withLexAuthRotation: (_scope: string, operation: () => Promise<unknown>) => new Promise(resolve => {
        acquire = async () => { const value = await operation(); resolve(value); return value; };
      }),
      readPersistedAuthSession: read, finishColdStartSignedOut: signedOut, snapshotAuthState: () => next,
    }, 'let authStateEpoch=1;', 'runColdStartRefreshFlow,switchOwner:()=>{authStateEpoch+=1;}');
    const pending = api.runColdStartRefreshFlow('synthetic-a', A);
    api.switchOwner();
    await acquire();
    await expect(pending).resolves.toBe(next);
    expect(read).not.toHaveBeenCalled();
    expect(signedOut).not.toHaveBeenCalled();
  });

  it('round trips v3 A/B and legacy Cindy accounts with identical public ids', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-service-test-')); roots.push(root);
    const file = path.join(root, 'synthetic-vault.json');
    const api = load(['emptyAuthAccountVault', 'readAuthAccountVault', 'serializeAuthAccountVault', 'accountVaultKey', 'passportVaultKey', 'isStoredAccountMetadata'], {
      AUTH_ACCOUNT_VAULT_VERSION: 3, AUTH_ACCOUNT_VAULT_KEY: 'vault', storedAuthServiceScope, authServiceRealm, authServiceFromScope,
      isAuthServiceScope, parseDesktopAccountKey, AuthApiError, log,
      readAuthAccountLogoutTombstones: () => [],
      readAtomicSafe: () => fs.readFileSync(file, 'utf8'), isAtomicPersistedSecretAbsent: () => false,
    });
    const vault = api.emptyAuthAccountVault();
    for (const scope of [A, B, 'global']) {
      vault.resources[key(scope, metadata.membershipId)] = { realm: scope, metadata, refreshToken: 'synthetic-' + scope, lastUsedAt: 1 };
      vault.passports[key(scope, metadata.passportId)] = { realm: scope, passportId: metadata.passportId, accountRefreshToken: 'account-' + scope, memberships: [metadata] };
    }
    vault.activeAccountKey = key(B, metadata.membershipId);
    fs.writeFileSync(file, api.serializeAuthAccountVault(vault));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(3);
    const restored = api.readAuthAccountVault();
    for (const scope of [A, B, 'global']) {
      expect(restored.resources[key(scope, metadata.membershipId)].realm).toBe(scope);
      expect(restored.passports[key(scope, metadata.passportId)].realm).toBe(scope);
    }
    expect(restored.activeAccountKey).toBe(vault.activeAccountKey);
    const wrongScope = JSON.parse(fs.readFileSync(file, 'utf8'));
    wrongScope.resources[key(A, metadata.membershipId)].service.origin = 'https://b.example';
    fs.writeFileSync(file, JSON.stringify(wrongScope));
    expect(() => api.readAuthAccountVault()).toThrow('Saved account credentials could not be read safely');
  });

  it('keeps a pending single-use rotation across reconstruction and refuses replay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-service-test-')); roots.push(root);
    const file = path.join(root, 'synthetic-rotation.json'); fs.writeFileSync(file, '{}');
    let offline = false, failWrite = false;
    const deps = {
      crypto, AuthApiError, normalizeLexRefreshFailureCode, net: { isOnline: () => !offline },
      accountVaultLockError: () => new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'Synthetic store failure'),
      mutateAuthAccountVault: async (operation: (vault: Record<string, unknown>) => unknown) => {
        const vault = JSON.parse(fs.readFileSync(file, 'utf8'));
        const result = operation(vault);
        if (failWrite) throw new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'Synthetic write failure');
        fs.writeFileSync(file, JSON.stringify(vault)); return result;
      },
    };
    const create = () => load(['rotationAttemptKey', 'clearRotationAttempt', 'beginRotationAttempt', 'releaseRejectedRotation', 'rotateSavedCredential'], deps);
    let api = create(); const send = vi.fn(async () => { throw new AuthApiError('NETWORK_ERROR', 0, 'Synthetic lost response'); });
    await expect(api.rotateSavedCredential(A, 'resource', 'token-a', send)).rejects.toMatchObject({ code: 'AUTH_ROTATION_UNCERTAIN' });
    api = create();
    await expect(api.rotateSavedCredential(A, 'resource', 'token-a', send)).rejects.toMatchObject({ code: 'AUTH_ROTATION_UNCERTAIN' });
    expect(send).toHaveBeenCalledTimes(1);
    // Same token text on B cannot be mistaken for A's unknown outcome.
    const accepted = vi.fn(async () => 'accepted');
    await expect(api.rotateSavedCredential(B, 'resource', 'token-a', accepted)).resolves.toBe('accepted');
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('token-a');
    // Storage/known-offline failures occur before transmission and do not consume a credential.
    failWrite = true;
    await expect(api.rotateSavedCredential(A, 'passport', 'new-token', accepted)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    failWrite = false; offline = true;
    await expect(api.rotateSavedCredential(A, 'passport', 'offline-token', accepted)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    offline = false;
    await expect(api.rotateSavedCredential(A, 'passport', 'offline-token', accepted)).resolves.toBe('accepted');
    expect(accepted).toHaveBeenCalledTimes(2);
  });

  it('releases an explicit rate-limit rejection but retains unknown 5xx outcomes', async () => {
    const vault: Record<string, unknown> = {};
    const api = load(['rotationAttemptKey', 'clearRotationAttempt', 'beginRotationAttempt', 'releaseRejectedRotation', 'rotateSavedCredential'], {
      crypto, AuthApiError, normalizeLexRefreshFailureCode, net: { isOnline: () => true },
      mutateAuthAccountVault: async (fn: (v: typeof vault) => unknown) => fn(vault),
    });
    const send = vi.fn().mockRejectedValueOnce(new AuthApiError('RATE_LIMITED', 429, 'Synthetic')).mockResolvedValueOnce('ok');
    await expect(api.rotateSavedCredential(A, 'resource', 'token', send)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(api.rotateSavedCredential(A, 'resource', 'token', send)).resolves.toBe('ok');
    const bad = vi.fn().mockRejectedValue(new AuthApiError('INTERNAL_ERROR', 500, 'Synthetic'));
    await expect(api.rotateSavedCredential(A, 'passport', 'account-token', bad)).rejects.toMatchObject({ code: 'AUTH_ROTATION_UNCERTAIN' });
    await expect(api.rotateSavedCredential(A, 'passport', 'account-token', bad)).rejects.toMatchObject({ code: 'AUTH_ROTATION_UNCERTAIN' });
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe('Main-owned server selection', () => {
  it('selects a device-bound membership ticket while retaining the OTP account pair', async () => {
    const outcome = { status: 'ok', accessToken: 'resource-access', refreshToken: 'resource-refresh', membership: { id: 'same-member', passportId: 'same-passport' } };
    const client = { selectAccount: vi.fn(async () => outcome) };
    const completeLogin = vi.fn(async () => ({ step: 'completed' }));
    const api = load(['runLoginAction', 'assertLoginFlowCurrent'], {
      AuthApiError, createAuthClient: () => client, completeLogin, log,
    }, 'let loginFlowEpoch=1,selectedPersonalAuthRealm=' + JSON.stringify(A) + ',pendingAuthRealm=' + JSON.stringify(A) + ',providerConfig={},loginFlowState={step:"account-selection"},pendingLoginTicket="device-ticket",pendingAccountMemberships=[{id:"same-member"}],pendingAccountToken="otp-access",pendingAccountRefreshToken="otp-refresh";',
    'runLoginAction,accountPair:()=>[pendingAccountToken,pendingAccountRefreshToken],ticket:()=>pendingLoginTicket');
    await expect(api.runLoginAction({ type: 'select-account', accountId: 'same-member' })).resolves.toMatchObject({ success: true, state: { step: 'completed' } });
    expect(client.selectAccount).toHaveBeenCalledWith('device-ticket', 'same-member');
    expect(completeLogin).toHaveBeenCalledWith(outcome, 1);
    expect(api.accountPair()).toEqual(['otp-access', 'otp-refresh']);
    expect(api.ticket()).toBeNull();
  });

  it('cancels anonymous preflight without changing the active owner and ignores its late result', async () => {
    let resolveProbe!: (v: unknown) => void;
    let probeSignal: AbortSignal | undefined;
    const providers = vi.fn(async () => ({ success: true }));
    const api = load(['beginAddAccountLogin', 'cancelAddAccountLogin', 'resetLoginFlowState', 'assertLoginFlowCurrent'], {
      AuthApiError, parseDesktopLoginServiceInput, authServiceScope,
      isPassiveSharedUserDataInstance: () => false,
      browserAuthorizationSlot: { cancelActive: vi.fn() }, isLoginFlowCommitSealed: () => false, log,
      getLoginState: providers,
      preflightLexServer: (_origin: string, signal: AbortSignal) => { probeSignal = signal; return new Promise(resolve => { resolveProbe = resolve; }); },
    }, 'let loginFlowEpoch=0,loginServiceProbe=null,selectedPersonalAuthRealm="global",handledLoginEmail,pendingPersonalLogin,loginFlowState,providerConfig,discoveredMethods,pendingAccountToken,pendingAccountRefreshToken,pendingAccountMemberships,pendingLoginTicket,pendingBindTicket,pendingSsoVerificationTicket,pendingAuthRealm,pendingAccountDeletionRestored;', 'beginAddAccountLogin,cancelAddAccountLogin,scope:()=>selectedPersonalAuthRealm');
    const pending = api.beginAddAccountLogin({ kind: 'lex-server', origin: 'https://a.example' });
    api.cancelAddAccountLogin();
    expect(probeSignal?.aborted).toBe(true);
    resolveProbe({ kind: 'lex-server', origin: 'https://a.example' });
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_FLOW_SUPERSEDED' });
    expect(providers).not.toHaveBeenCalled();
    expect(api.scope()).toBe('global');
  });
});
