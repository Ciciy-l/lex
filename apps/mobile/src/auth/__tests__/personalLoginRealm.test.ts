import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ values: new Map<string, string>(), vault: vi.fn(), secure: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => mocks.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.values.set(key, value); },
} }));
vi.mock('../mobileAccountVault', () => ({ readMobileAccountVault: mocks.vault }));
vi.mock('../secureStorage', () => ({ getSecureItem: mocks.secure }));
import { parsePersonalLoginRealm, readPersonalLoginRealm, readStartupAuthRealm, readStartupAuthScope, savePersonalLoginRealm } from '../personalLoginRealm';
import { serializeAuthSessionRecord } from '@cindy/auth-client';

beforeEach(() => {
  mocks.values.clear(); vi.clearAllMocks();
  mocks.vault.mockResolvedValue({ resources: {}, activeAccountKey: null });
  mocks.secure.mockResolvedValue(null);
});

describe('personal login realm preference', () => {
  it('proves guest absence but resolves a stored Lex origin before endpoint startup', async () => {
    await expect(readStartupAuthScope()).resolves.toBeNull();
    const service = { kind: 'lex-server' as const, origin: 'https://a.fixture.invalid:8443' };
    mocks.vault.mockResolvedValue({ activeAccountKey: 'active', resources: { active: { realm: 'global', service } } });
    mocks.secure.mockClear();
    await expect(readStartupAuthScope()).resolves.toBe('lex-server:https://a.fixture.invalid:8443');
    expect(mocks.secure).not.toHaveBeenCalled();
  });
  it('keeps old Cindy session and refresh-only upgrades on their saved realm', async () => {
    mocks.secure.mockResolvedValueOnce(serializeAuthSessionRecord('cn', 'invalid-fixture'));
    await expect(readStartupAuthScope()).resolves.toBe('cn');
    await savePersonalLoginRealm('cn');
    mocks.secure.mockImplementation(async key => key === 'cindy.mobile.auth.refreshToken' ? 'invalid-fixture' : null);
    await expect(readStartupAuthScope()).resolves.toBe('cn');
  });
  it('does not mark corrupt, unreadable, or undecryptable storage as guest', async () => {
    mocks.secure.mockResolvedValue('malformed-fixture');
    await expect(readStartupAuthScope()).rejects.toThrow('AUTH_STORAGE_UNAVAILABLE');
    mocks.secure.mockRejectedValue(new Error('fixture decrypt failure'));
    await expect(readStartupAuthScope()).rejects.toThrow('fixture decrypt failure');
    mocks.vault.mockRejectedValue(new Error('fixture vault read failure'));
    await expect(readStartupAuthScope()).rejects.toThrow('fixture vault read failure');
  });
  it('defaults to Global and serializes successive user choices', async () => {
    expect(parsePersonalLoginRealm('other')).toBe('global');
    expect(await readPersonalLoginRealm()).toBe('global');
    await Promise.all([savePersonalLoginRealm('cn'), savePersonalLoginRealm('global'), savePersonalLoginRealm('cn')]);
    expect(await readPersonalLoginRealm()).toBe('cn');
  });
  it('boots the current account realm even when the next-login preference differs', async () => {
    await savePersonalLoginRealm('global');
    mocks.vault.mockResolvedValue({ activeAccountKey: 'active', resources: { active: { realm: 'cn' } } });
    expect(await readStartupAuthRealm()).toBe('cn');
    expect(mocks.secure).not.toHaveBeenCalled();
  });
  it('preserves legacy session realm and never revives it after explicit sign-out', async () => {
    mocks.secure.mockResolvedValue(JSON.stringify({ version: 1, realm: 'cn', refreshToken: 'fixture' }));
    expect(await readStartupAuthRealm()).toBe('cn');
    mocks.vault.mockResolvedValue({ resources: {}, activeAccountKey: null, signedOutAt: 1 });
    expect(await readStartupAuthRealm()).toBe('global');
  });
  it('does not treat unreadable encrypted credentials as a new anonymous Global session', async () => {
    mocks.vault.mockRejectedValue(new Error('vault unavailable'));
    await expect(readStartupAuthRealm()).rejects.toThrow('vault unavailable');
  });
  it('cancels the old login before awaiting storage or loading the new realm', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');
    const selection = source.slice(source.indexOf("if (action.type === 'select-realm') {"), source.indexOf('const expectedLoginFlowEpoch = loginFlowEpochRef.current;', source.indexOf("if (action.type === 'select-realm') {")));
    expect(selection).toContain('loginFlowEpochRef.current += 1');
    expect(selection).toContain('resolveCaptchaChallenge(null)');
    expect(selection).toContain('pendingAuthRealmRef.current = null');
    expect(selection).toContain('pendingLoginTicketRef.current = null');
    expect(selection).not.toContain('await');
    expect(source).toContain('if (expectedEpoch !== undefined && expectedEpoch !== loginFlowEpochRef.current) return;');
    // Selecting a pending realm cannot redirect the current account's service.
    expect(selection).not.toContain('activateMobileAuthScope(');
    const gate = readFileSync(resolve(process.cwd(), 'src/config/useStartupEndpointGate.ts'), 'utf8');
    expect(gate).toContain('explicitRealm.current ?? await readStartupAuthRealm()');
    expect(gate).toContain('realmManifestBaseUrls[selected]');
    expect(gate).toContain('if (!cancelled && current === generation.current)');
    expect(gate).toContain('preserveBuildReleaseMetadata: true');
  });
});
