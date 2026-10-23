import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authServiceScope } from '@cindy/auth-client';

const fixture = vi.hoisted(() => ({
  device: vi.fn(async () => 'fixture-device'),
  native: { reset: vi.fn(async () => {}), configure: vi.fn(async () => {}),
    updateToken: vi.fn(async () => {}), pushHeaders: vi.fn(async () => ({ signature: 'fixture' })) },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/auth/deviceId', () => ({ ensureDeviceId: fixture.device }));
vi.mock('@/config/env', () => ({
  BUILD_AUTH_REGION: 'global', getActiveMobileSessionRealm: () => 'global',
  activateMobileSessionRealm() {}, activateMobileLexServer() {},
  getMobileEndpointForRealm: () => 'https://official.invalid', loadMobileEndpointsForRealm: async () => {},
}));
vi.mock('../../../modules/cindy-remote-credentials/src', () => ({ remoteCredentials: fixture.native }));
import { activateMobileAuthScope } from '@/auth/authService';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { configureCredentialIdentity, credentialPushHeaders, updateCredentialAccessToken } from '../credentialIdentity';
import { supportsAutoUnlock } from '../autoUnlockSupport';

const lex = authServiceScope({ kind: 'lex-server', origin: 'https://lex.fixture.invalid' });
describe('official native credential service boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks(); fixture.device.mockResolvedValue('fixture-device');
    activateMobileAuthScope('global'); setMobileAuthOwner('fixture-member', 'global');
  });
  it('resets Cindy native state and makes no credential/push/auto-unlock calls for Lex', async () => {
    await configureCredentialIdentity('fixture-cindy');
    expect(fixture.native.configure).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    activateMobileAuthScope(lex); setMobileAuthOwner('fixture-member', lex);
    await expect(configureCredentialIdentity('fixture-lex')).rejects.toThrow('SERVICE_CAPABILITY_UNAVAILABLE');
    await expect(credentialPushHeaders('fixture-lex', 'PUT', {})).rejects.toThrow('SERVICE_CAPABILITY_UNAVAILABLE');
    updateCredentialAccessToken('fixture-lex');
    await Promise.resolve();
    expect(supportsAutoUnlock('darwin')).toBe(false);
    expect(fixture.native.reset).toHaveBeenCalledOnce();
    expect(fixture.native.configure).not.toHaveBeenCalled();
    expect(fixture.native.updateToken).not.toHaveBeenCalled();
    expect(fixture.native.pushHeaders).not.toHaveBeenCalled();
  });
  it('fences a Cindy configure that finishes device setup after a service switch', async () => {
    let finish!: (value: string) => void;
    fixture.device.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = configureCredentialIdentity('fixture-cindy');
    await vi.waitFor(() => expect(fixture.device).toHaveBeenCalledOnce());
    activateMobileAuthScope(lex); setMobileAuthOwner('fixture-member', lex);
    finish('fixture-device');
    await expect(pending).rejects.toThrow('CREDENTIAL_CANCELLED');
    expect(fixture.native.configure).not.toHaveBeenCalled();
  });
});
