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
import { parsePersonalLoginRealm, readPersonalLoginRealm, readStartupAuthRealm, savePersonalLoginRealm } from '../personalLoginRealm';

beforeEach(() => {
  mocks.values.clear(); vi.clearAllMocks();
  mocks.vault.mockResolvedValue({ resources: {}, activeAccountKey: null });
  mocks.secure.mockResolvedValue(null);
});

describe('personal login realm preference', () => {
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
    expect(source).toContain('if (!additionalLoginRef.current) activateMobileSessionRealm(personalRealm)');
    const gate = readFileSync(resolve(process.cwd(), 'src/config/useStartupEndpointGate.ts'), 'utf8');
    expect(gate).toContain('explicitRealm.current ?? await readStartupAuthRealm()');
    expect(gate).toContain('realmManifestBaseUrls[selected]');
    expect(gate).toContain('if (!cancelled && current === generation.current)');
    expect(gate).toContain('preserveBuildReleaseMetadata: true');
  });
});
