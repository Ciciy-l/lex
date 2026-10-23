// @vitest-environment jsdom
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import serviceCopy from '../../i18n/locales/en/serviceLogin.json';

const native = vi.hoisted(() => ({
  http: vi.fn(),
  platform: 'android',
  replaceRoute: vi.fn(),
  closeAccount: undefined as (() => void) | undefined,
  storage: new Map<string, string>(),
  readSecure: vi.fn(),
  deleteSecure: vi.fn(),
  writeSecure: vi.fn(),
  logoutCleanup: vi.fn(),
  unregisterPush: vi.fn(),
  links: new Set<(event: { url: string }) => void>(),
  open: vi.fn(),
  exchange: vi.fn(),
  selectAccount: vi.fn(),
  requestBinding: vi.fn(),
  requestVerification: vi.fn(),
  providers: vi.fn(),
  initialUrl: vi.fn(),
  requestCode: vi.fn(),
  discoverOrganization: vi.fn(),
  crossRealm: false,
  readPersonalRealm: vi.fn(),
  savePersonalRealm: vi.fn(),
  loadRealm: vi.fn(),
  activateRealm: vi.fn(),
  providerRealms: [] as string[],
  exchangeRealms: [] as string[],
  state: 0,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: native.replaceRoute }), Stack: { Screen: () => null } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => (serviceCopy as Record<string, string>)[key.replace('serviceLogin.', '')] ?? key }) }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}),
  spacing: {}, radius: {}, typeScale: {}, lineHeight: {}, fontWeight: {},
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: { children: React.ReactNode; testID?: string }) => <span data-testid={testID}>{children}</span>,
  TextInput: ({ value, onChangeText, testID }: { value: string; onChangeText(value: string): void; testID: string }) =>
    <input data-testid={testID} value={value} onInput={event => onChangeText(event.currentTarget.value)} readOnly />,
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string; onPress(): void; testID: string; disabled?: boolean; busy?: boolean } }) =>
    <button data-testid={action.testID} disabled={action.disabled || action.busy} onClick={action.onPress}>{action.label}</button>,
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: ({ onBack }: { onBack(): void }) => <button data-testid="back" onClick={onBack}>Back</button> }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../../../app/(auth)/login', () => ({
  LoginScreen: ({ onClose }: { onClose?: () => void }) => { native.closeAccount = onClose; return null; },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  Platform: { get OS() { return native.platform; } },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Linking: {
    getInitialURL: native.initialUrl,
    addEventListener: (_: string, listener: (event: { url: string }) => void) => {
      native.links.add(listener);
      return { remove: () => native.links.delete(listener) };
    },
  },
  Keyboard: { dismiss() {} },
}));
vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => native.http(...args) }));
vi.mock('@/device-link/lexServiceWebSocket', () => ({ supportsLexServiceWebSocket: () => true }));
vi.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession() {}, openAuthSessionAsync: native.open,
}));
vi.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ addCustomField() {} }) }));
vi.mock('@/config/env', () => ({
  BUILD_AUTH_REGION: 'global', MOBILE_REDIRECT_URL: 'cindycn://auth',
  WECHAT_APP_ID: '', WECHAT_UNIVERSAL_LINK: '',
  IS_OTA_SELFHOST: false, MOBILE_VISUAL_MOCK_ENABLED: false,
  OAUTH_BROKER_API_BASE_URL: 'https://auth.example.invalid',
  getMobileEndpointForRealm: (realm: string) => `https://${realm}.auth.example.invalid`,
  getMobileEndpointRealmConfig: () => ({ crossRealmOrgLoginEnabled: native.crossRealm }),
  loadMobileEndpointsForRealm: native.loadRealm,
  activateMobileSessionRealm: native.activateRealm, activateMobileLexServer: native.activateRealm, resetMobileSessionRealm() {},
}));
vi.mock('@/config/lexMobile', () => ({ IS_LEX_MOBILE: true }));
vi.mock('@/auth/personalLoginRealm', () => ({
  readPersonalLoginRealm: native.readPersonalRealm,
  savePersonalLoginRealm: native.savePersonalRealm,
}));
vi.mock('@cindy/auth-client/fixtures', () => ({ resolveLoginScenarioFetch: () => undefined }));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: native.readSecure,
  setSecureItem: native.writeSecure,
  deleteSecureItem: native.deleteSecure,
}));
vi.mock('@/auth/pkce', () => ({
  createPkcePair: async () => ({ codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }),
  createState: () => `fixture-state-${++native.state}`,
}));
vi.mock('@/auth/deviceId', () => ({ ensureDeviceId: async () => 'fixture-device', hasStoredDeviceId: async () => true }));
vi.mock('@/api/client', () => ({ registerAccountUnavailableHandler: () => () => {} }));
vi.mock('@/auth/nativeSocial', () => ({}));
vi.mock('@/auth/ssoOrgHistory', () => ({ rememberSsoOrgIdentifier: async () => {} }));
vi.mock('@/auth/canaryChannelSync', () => ({}));
vi.mock('@/auth/xdOrgBetaDefault', () => ({}));
vi.mock('@/analytics/mobileTapdb', () => ({ setTapdbUser: async () => {}, clearTapdbUser: async () => {}, stopMobileTapdbReporting: async () => {} }));
vi.mock('@/analytics/analyticsConsentStore', () => ({ clearAnalyticsConsent: async () => {}, migrateExistingLoginAsConsented: async () => {} }));
vi.mock('@/notifications/pushNotifications', () => ({ unregisterPushTokenBestEffort: native.unregisterPush }));
vi.mock('@/session/agentCapabilitiesCache', () => ({ resetAgentCapabilitiesCache: async () => {} }));
vi.mock('@/session/composerPaletteCache', () => ({ resetComposerPaletteCache: async () => {} }));
vi.mock('@/device-link/remoteResourceCache', () => ({ clearRemoteResourceCache: async () => {} }));
vi.mock('@/session/mobileHomeListCache', () => ({ clearCachedHomeListSnapshot: async () => {} }));
vi.mock('@/device-link/clipboardInvitationHistory', () => ({ clearClipboardInvitationHistory: async () => {} }));
vi.mock('@/remote-desktop/credentialIdentity', () => ({ updateCredentialAccessToken() {} }));
vi.mock('@/session/mobileSessionMessageCache', () => ({ clearCachedSessionMessages: async () => {} }));
vi.mock('@/session/remoteHistoryDiskCache', () => ({ clearHistoryDisk: async () => {} }));
vi.mock('@/session/mobileVoiceCredentialStore', () => ({ clearAllMobileVoiceCredentials: async () => {} }));
vi.mock('@/session/mobileVoiceDictionaryCache', () => ({ setMobileVoiceDictionaryAccountScope() {}, clearAllMobileVoiceDictionaryCaches: async () => {} }));
vi.mock('@/session/mobileVoiceHistoryStore', () => ({ clearAllMobileVoiceInputHistories: async () => {} }));
vi.mock('@/debug/visualMock', () => ({}));
vi.mock('@/update/canaryChannelStore', () => ({ clearCanaryChannel: async () => {} }));
vi.mock('@/update/betaChannelStore', () => ({ prepareBetaChannelForDevice: async () => {} }));
vi.mock('@/update/fetchLatestRelease', () => ({}));

import { AuthProvider, useAuth } from '../AuthContext';
import { MobileServiceLogin } from '../MobileServiceLogin';
import { getMobileAuthOwner, setMobileAuthOwner } from '../authOwnerGeneration';
import { clearActiveMobileAuthScope } from '../authService';
import { readMobileAccountVault, MOBILE_ACCOUNT_VAULT_KEY } from '../mobileAccountVault';
import { accountVaultKey, authServiceScope, parseAuthSessionRecord } from '@cindy/auth-client';

const providers = { region: 'global', attribution: 'email', email: true, phone: false, social: [] };
const member = (id = 'test-member') => ({ id, passportId: 'test-passport', kind: 'org' as const, role: 'member' as const,
  displayName: 'Test account', email: 'test@fixture.invalid', orgId: 'test-org', orgName: 'Test organization' });
let multi = false;
const pair = (origin: string, id = 'test-member') => ({ accessToken: 'test-access-' + origin + '|' + id, refreshToken: 'test-refresh-' + origin + '|' + id, membership: member(id) });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
async function server(url: string, init?: RequestInit): Promise<Response> {
  const { origin, pathname } = new URL(url);
  if (pathname === '/health') return json({ status: 'ok', service: 'Lex Admin Server', capabilities: ['device-link'] });
  if (pathname === '/ready') return json({ status: 'ready' });
  if (pathname.endsWith('/providers')) return json({ ...providers, region: origin === 'https://cn.auth.example.invalid' ? 'cn' : 'global' });
  if (pathname.endsWith('/discovery')) return json({ methods: [{ type: 'email_code' }] });
  if (pathname.endsWith('/request-code')) return json({ status: 'sent' });
  if (pathname.endsWith('/verify-code')) return json(multi ? { status: 'select_account', loginTicket: 'test-ticket',
    accounts: [member(), member('test-second')], accountToken: 'test-account-access', accountRefreshToken: 'test-account-refresh' }
    : { status: 'ok', ...pair(origin), accountToken: 'test-account-access', accountRefreshToken: 'test-account-refresh' });
  if (pathname.endsWith('/select-account')) return json({ status: 'ok', ...pair(origin, 'test-second') });
  if (pathname === '/api/me') {
    const token = new Headers(init?.headers).get('authorization') ?? '';
    const id = token.endsWith('|test-second') ? 'test-second' : 'test-member';
    return json({ membership: member(id), passportId: 'test-passport', identities: [member(), member('test-second')] });
  }
  if (pathname === '/api/auth/refresh') {
    const body = JSON.parse(String(init?.body)) as { refreshToken: string };
    return json(pair(origin, body.refreshToken.endsWith('|test-second') ? 'test-second' : 'test-member'));
  }
  if (pathname === '/api/auth/logout') return json({ status: 'ok' });
  throw new Error('Unexpected fixture endpoint ' + pathname);
}
let root: Root, container: HTMLDivElement, auth: ReturnType<typeof useAuth>;
function Probe() { auth = useAuth(); return null; }
function CindyLoginProbe() {
  const current = useAuth();
  useEffect(() => { void current.dispatchLoginAction({ type: 'initialize' }); }, [current.dispatchLoginAction]);
  return <output data-testid="cindy-realm">{current.loginRealm}</output>;
}
async function mount() { container = document.createElement('div'); root = createRoot(container); await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); }); }
async function showServiceChooser() {
  await act(async () => { root.render(<AuthProvider><Probe /><MobileServiceLogin renderCindy={() => <CindyLoginProbe />} /></AuthProvider>); });
}
async function click(id: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  expect(button, id).not.toBeNull(); expect(button!.disabled, id).toBe(false);
  await act(async () => { button!.click(); });
}
async function select(origin: string) { await act(async () => { expect(await auth.selectLoginService({ kind: 'lex-server', origin })).toBe(true); }); }
async function login(origin = 'https://a.test') {
  await select(origin);
  await act(async () => { expect(await auth.dispatchLoginAction({ type: 'discover', email: 'test@fixture.invalid' })).toBe(true); });
  await act(async () => { expect(await auth.dispatchLoginAction({ type: 'verify-code', kind: 'email', identifier: 'test@fixture.invalid', code: 'test-only' })).toBe(true); });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  multi = false; native.storage.clear(); native.http.mockReset().mockImplementation(server);
  native.readSecure.mockReset().mockImplementation(async key => native.storage.get(key) ?? null);
  native.writeSecure.mockReset().mockImplementation(async (key, value) => { native.storage.set(key, value); });
  native.deleteSecure.mockReset().mockImplementation(async key => { native.storage.delete(key); });
  native.initialUrl.mockReset().mockResolvedValue(null); native.readPersonalRealm.mockReset().mockResolvedValue('global');
  native.crossRealm = false; native.savePersonalRealm.mockReset().mockResolvedValue(undefined);
  native.loadRealm.mockReset().mockResolvedValue(undefined); native.activateRealm.mockClear(); native.unregisterPush.mockReset().mockResolvedValue(undefined);
  clearActiveMobileAuthScope(); setMobileAuthOwner(null); await mount();
});
afterEach(async () => { await act(async () => root.unmount()); setMobileAuthOwner(null); clearActiveMobileAuthScope(); });

describe('service chooser restores the personal realm without changing the active owner', () => {
  it.each(['cn', 'global'] as const)('opens Cindy with saved/default %s before requesting providers', async realm => {
    native.crossRealm = true; native.readPersonalRealm.mockResolvedValue(realm);
    await showServiceChooser();
    expect(native.readPersonalRealm).not.toHaveBeenCalled();
    expect(native.http).not.toHaveBeenCalled();
    await click('login.service.cindy');
    expect(container.querySelector('[data-testid="cindy-realm"]')?.textContent).toBe(realm);
    expect(auth.pendingService).toEqual({ kind: 'cindy', realm });
    expect(native.readPersonalRealm).toHaveBeenCalledTimes(1);
    expect(native.loadRealm).toHaveBeenCalledExactlyOnceWith(realm);
    expect(native.http.mock.calls.map(([url]) => new URL(url).origin)).toEqual([`https://${realm}.auth.example.invalid`]);
    expect(auth.service).toBeNull(); expect(getMobileAuthOwner().accountKey).toBe('');
    expect(native.savePersonalRealm).not.toHaveBeenCalled();
  });

  it('fails closed on a saved-realm read error and retries through the same chooser', async () => {
    native.crossRealm = true; native.readPersonalRealm.mockRejectedValueOnce(new Error('AUTH_STORAGE_UNAVAILABLE')).mockResolvedValue('cn');
    await showServiceChooser(); await click('login.service.cindy');
    expect(auth.authError).toBe('AUTH_STORAGE_UNAVAILABLE');
    expect(auth.pendingService).toBeNull(); expect(auth.isBusy).toBe(false);
    expect(native.http).not.toHaveBeenCalled(); expect(native.loadRealm).not.toHaveBeenCalled();
    await click('login.service.cindy');
    expect(auth.pendingService).toEqual({ kind: 'cindy', realm: 'cn' });
    expect(auth.authError).toBeNull();
  });

  it('keeps a newer explicit Global choice when an old saved cn read finishes', async () => {
    native.crossRealm = true;
    let finish!: (realm: string) => void;
    native.readPersonalRealm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await showServiceChooser(); await click('login.service.cindy');
    expect(native.readPersonalRealm).toHaveBeenCalledTimes(1);
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'select-realm', realm: 'global' })).toBe(true); });
    await act(async () => { finish('cn'); });
    expect(auth.loginRealm).toBe('global'); expect(auth.isBusy).toBe(false);
    expect(native.savePersonalRealm).toHaveBeenCalledWith('global');
    expect(native.http.mock.calls.every(([url]) => new URL(url).origin === 'https://global.auth.example.invalid')).toBe(true);
    expect(auth.pendingService).toBeNull();
  });

  it.each(['cancel', 'lex', 'reenter'] as const)('discards the old preference read after %s', async action => {
    native.crossRealm = true;
    let finish!: (realm: string) => void;
    native.readPersonalRealm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('global');
    await showServiceChooser(); await click('login.service.cindy');
    expect(native.readPersonalRealm).toHaveBeenCalledTimes(1);
    await click('back');
    expect(auth.pendingService).toBeNull();
    if (action === 'lex') await select('https://a.test');
    if (action === 'reenter') {
      // A cancelled route is remounted on a fresh entry, just as the router does.
      await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
      await showServiceChooser(); await click('login.service.cindy');
    }
    await act(async () => { finish('cn'); });
    expect(auth.loginRealm).toBe('global');
    expect(auth.pendingService).toEqual(action === 'lex' ? { kind: 'lex-server', origin: 'https://a.test' }
      : action === 'reenter' ? { kind: 'cindy', realm: 'global' } : null);
    expect(native.http.mock.calls.some(([url]) => new URL(url).origin === 'https://cn.auth.example.invalid')).toBe(false);
    expect(auth.service).toBeNull(); expect(getMobileAuthOwner().accountKey).toBe('');
  });

  it('keeps the active Lex owner while loading a Cindy preference for an additional account', async () => {
    await login(); const owner = getMobileAuthOwner(), service = auth.service;
    await act(async () => { await auth.beginAddAccount(); });
    native.crossRealm = true; native.readPersonalRealm.mockResolvedValue('cn'); native.activateRealm.mockClear();
    await showServiceChooser(); await click('login.service.cindy');
    expect(auth.pendingService).toEqual({ kind: 'cindy', realm: 'cn' });
    expect(auth.service).toEqual(service); expect(getMobileAuthOwner()).toEqual(owner);
    expect(native.activateRealm).not.toHaveBeenCalled();
  });

  it('does not apply a late Cindy preference after a saved-account switch', async () => {
    await login(); await act(async () => { await auth.beginAddAccount(); }); await login('https://b.test');
    await act(async () => { await auth.beginAddAccount(); });
    native.crossRealm = true;
    let finish!: (realm: string) => void;
    native.readPersonalRealm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await showServiceChooser(); await click('login.service.cindy');
    expect(native.readPersonalRealm).toHaveBeenCalledTimes(1);
    const keyA = accountVaultKey(authServiceScope({ kind: 'lex-server', origin: 'https://a.test' }), 'test-member');
    await act(async () => { await auth.switchAccount(keyA); });
    const owner = getMobileAuthOwner();
    await act(async () => { finish('cn'); });
    expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    expect(auth.pendingService).toBeNull(); expect(auth.loginRealm).toBe('global');
    expect(auth.isBusy).toBe(false);
    expect(getMobileAuthOwner()).toEqual(owner);
    expect(native.http.mock.calls.some(([url]) => new URL(url).origin === 'https://cn.auth.example.invalid')).toBe(false);
  });
});

describe('service address errors on the real chooser', () => {
  it.each(['http://127.0.0.1:3101', 'https://server.test/api', 'https://server.test?query=1', 'https://server.test/#fragment'])(
    'explains the root HTTPS requirement without fetching %s', async origin => {
      await showServiceChooser(); await click('login.service.lex');
      const input = container.querySelector<HTMLInputElement>('[data-testid="login.server.address"]')!;
      await act(async () => {
        input.value = origin; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click('login.server.continue');
      expect(native.http).not.toHaveBeenCalled();
      expect(auth.pendingService).toBeNull();
      expect(container.querySelector('[data-testid="login.service.error"]')?.textContent).toBe(
        'Enter the server root address using HTTPS, without a path, query or fragment.',
      );
    },
  );
  it('keeps an unavailable HTTPS service distinct from an invalid address', async () => {
    native.http.mockRejectedValue(new TypeError('fixture offline'));
    await showServiceChooser();
    await act(async () => { expect(await auth.selectLoginService({ kind: 'lex-server', origin: 'https://server.test' })).toBe(false); });
    expect(container.querySelector('[data-testid="login.service.error"]')?.textContent).toBe(serviceCopy.serverError);
  });
});

describe('Lex auth commits with real AuthProvider, client and encrypted-vault contract', () => {
  it('starts a real guest without querying official authentication services', () => { expect(auth.initialized).toBe(true); expect(auth.isAuthenticated).toBe(false); expect(native.http).not.toHaveBeenCalled(); expect(getMobileAuthOwner().accountKey).toBe(''); });
  it('persists the deployment before publishing the owner and restores it on restart', async () => {
    await login(); expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    expect(getMobileAuthOwner().accountKey).toBe(accountVaultKey(authServiceScope(auth.service!), 'test-member'));
    expect(parseAuthSessionRecord(native.storage.get('cindy.mobile.auth.session.v1') ?? null)).toMatchObject({ version: 2, service: auth.service });
    await act(async () => root.unmount()); await mount(); expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    expect(auth.isAuthenticated).toBe(true);
    expect(native.http.mock.calls.every(([url]) => new URL(url).origin === 'https://a.test')).toBe(true);
  });
  it('retains the OTP account pair when a one-use ticket selects another membership', async () => {
    multi = true; await login(); expect(auth.loginState?.step).toBe('account-selection'); expect(auth.isAuthenticated).toBe(false);
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'select-account', accountId: 'test-second' })).toBe(true); });
    const vault = await readMobileAccountVault(); expect(Object.values(vault.passports)[0].accountRefreshToken).toBe('test-account-refresh');
    const selected = native.http.mock.calls.filter(([url]) => url.endsWith('/select-account')); expect(selected).toHaveLength(1);
    expect(native.http.mock.calls.some(([url]) => url.endsWith('/account/exchange'))).toBe(false);
    expect(auth.user?.id).toBe('test-second');
    expect(getMobileAuthOwner().accountKey).toBe(accountVaultKey(authServiceScope(auth.service!), 'test-second'));
  });
  it('keeps active service and owner while an additional preflight is pending or cancelled', async () => {
    await login(); const old = getMobileAuthOwner(), oldService = auth.service;
    await act(async () => { await auth.beginAddAccount(); });
    let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
    native.http.mockImplementation(async (url, init) => { if (url.startsWith('https://b.test/')) await waiting; return server(url, init); });
    let pending!: Promise<boolean>; await act(async () => { pending = auth.selectLoginService({ kind: 'lex-server', origin: 'https://b.test' }); });
    expect(auth.service).toEqual(oldService); expect(getMobileAuthOwner()).toEqual(old);
    await act(async () => { await auth.cancelLoginService(); finish(); expect(await pending).toBe(false); });
    expect(auth.service).toEqual(oldService); expect(getMobileAuthOwner()).toEqual(old);
  });
  it('does not publish a late login or overwrite the previous service after secure persistence fails', async () => {
    await login(); const oldService = auth.service, originalSession = native.storage.get('cindy.mobile.auth.session.v1');
    await act(async () => { await auth.beginAddAccount(); }); await select('https://b.test');
    native.writeSecure.mockImplementation(async (key, value) => { if (key === MOBILE_ACCOUNT_VAULT_KEY) throw new Error('fixture storage unavailable'); native.storage.set(key, value); });
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'verify-code', kind: 'email', identifier: 'test@fixture.invalid', code: 'test-only' })).toBe(false); });
    expect(auth.service).toEqual(oldService); expect(native.storage.get('cindy.mobile.auth.session.v1')).toBe(originalSession);
    expect(getMobileAuthOwner().accountKey).toContain('https://a.test');
  });
  it('does not authenticate a cancelled OTP response', async () => {
    await select('https://a.test'); let finish!: (value: Response) => void;
    native.http.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    let pending!: Promise<boolean>; await act(async () => { pending = auth.dispatchLoginAction({ type: 'verify-code', kind: 'email', identifier: 'test@fixture.invalid', code: 'test-only' }); });
    await act(async () => { await auth.cancelLoginService(); finish(json({ status: 'ok', ...pair('https://a.test') })); expect(await pending).toBe(false); });
    expect(auth.isAuthenticated).toBe(false); expect(getMobileAuthOwner().accountKey).toBe(''); expect(Object.keys((await readMobileAccountVault()).resources)).toHaveLength(0);
  });
  it('recovers the known vault rotation after the compatibility projection fails or the process ends between writes', async () => {
    await login();
    const sessionKey = 'cindy.mobile.auth.session.v1';
    const oldSession = native.storage.get(sessionKey);
    const next = { ...pair('https://a.test'), refreshToken: 'fixture-known-T1' };
    native.http.mockImplementation(async (url, init) => url.endsWith('/api/auth/refresh') ? json(next) : server(url, init));
    native.writeSecure.mockImplementation(async (key, value) => {
      if (key === sessionKey) throw new Error('fixture compatibility write failed');
      native.storage.set(key, value);
    });
    await act(async () => { await expect(auth.refreshAccessToken()).rejects.toThrow('fixture compatibility write failed'); });
    const vault = await readMobileAccountVault();
    expect(Object.values(vault.resources)[0]).toMatchObject({ refreshToken: 'fixture-known-T1' });
    expect(Object.values(vault.resources)[0].rotation).toBeUndefined();
    expect(native.storage.get(sessionKey)).toBe(oldSession);
    // These durable bytes are also the state after process interruption between
    // vault replacement and compatibility projection. Remount a real Provider.
    await act(async () => root.unmount());
    native.writeSecure.mockImplementation(async (key, value) => { native.storage.set(key, value); });
    native.http.mockClear().mockImplementation(async (url, init) => url.endsWith('/api/auth/refresh')
      ? json({ ...next, refreshToken: 'fixture-known-T2' }) : server(url, init));
    await mount();
    expect(auth.isAuthenticated).toBe(true);
    const refreshes = native.http.mock.calls.filter(([url]) => url.endsWith('/api/auth/refresh'));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0][0]).toBe('https://a.test/api/auth/refresh');
    expect(JSON.parse(String(refreshes[0][1]?.body))).toMatchObject({ refreshToken: 'fixture-known-T1' });
    expect(parseAuthSessionRecord(native.storage.get(sessionKey) ?? null)?.refreshToken).toBe('fixture-known-T2');
  });
  it('retires an in-flight OTP when Back returns to email without abandoning the selected service', async () => {
    await select('https://a.test'); let finish!: (value: Response) => void;
    native.http.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    let pending!: Promise<boolean>;
    await act(async () => { pending = auth.dispatchLoginAction({ type: 'verify-code', kind: 'email', identifier: 'test@fixture.invalid', code: 'test-only' }); });
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'back' })).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.pendingService).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    await act(async () => { finish(json({ status: 'ok', ...pair('https://a.test') })); expect(await pending).toBe(false); });
    expect(auth.isAuthenticated).toBe(false);
    expect(Object.keys((await readMobileAccountVault()).resources)).toHaveLength(0);
  });
  it('switches between same-ID deployments without logout and explicitly removes only the selected one', async () => {
    await login(); await act(async () => { await auth.beginAddAccount(); }); await login('https://b.test');
    const keyA = accountVaultKey(authServiceScope({ kind: 'lex-server', origin: 'https://a.test' }), 'test-member');
    await act(async () => { await auth.switchAccount(keyA); }); expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    expect(native.http.mock.calls.some(([url]) => url.endsWith('/logout'))).toBe(false);
    await act(async () => { await auth.logout(); }); expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://b.test' });
    expect((await readMobileAccountVault()).resources[keyA]).toBeUndefined();
    await act(async () => { await auth.logout(); }); expect(auth.isAuthenticated).toBe(false); expect(auth.service).toBeNull(); expect(getMobileAuthOwner().accountKey).toBe('');
    expect(native.storage.has('cindy.mobile.auth.session.v1')).toBe(false); expect(Object.keys((await readMobileAccountVault()).resources)).toHaveLength(0);
    expect(native.unregisterPush).not.toHaveBeenCalled();
  });
  it('keeps an offline deployment recoverable without contacting Cindy or replaying an unknown rotation', async () => {
    await login();
    await act(async () => root.unmount());
    native.http.mockClear().mockRejectedValue(new TypeError('fixture offline'));
    await mount();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    const vault = await readMobileAccountVault();
    expect(Object.values(vault.resources)[0].rotation).toBe('unknown');
    const requestCount = native.http.mock.calls.length;
    await act(async () => { await expect(auth.refreshAccessToken()).rejects.toThrow('SAVED_ACCOUNT_REAUTH_REQUIRED'); });
    expect(native.http).toHaveBeenCalledTimes(requestCount);
    expect(native.http.mock.calls.every(([url]) => new URL(url).origin === 'https://a.test')).toBe(true);
  });
  it.each(['logout', 'terminateSession'] as const)('keeps the current owner and credentials when %s cannot persist', async method => {
    await login(); const owner = getMobileAuthOwner();
    const previousSession = native.storage.get('cindy.mobile.auth.session.v1');
    const previousVault = native.storage.get(MOBILE_ACCOUNT_VAULT_KEY);
    native.deleteSecure.mockImplementation(async key => {
      if (key === 'cindy.mobile.auth.session.v1') throw new Error('fixture secure delete failed');
      native.storage.delete(key);
    });
    await act(async () => { await expect(auth[method]()).rejects.toThrow('fixture secure delete failed'); });
    expect(auth.isAuthenticated).toBe(true); expect(getMobileAuthOwner()).toEqual(owner);
    expect(native.storage.get('cindy.mobile.auth.session.v1')).toBe(previousSession);
    expect(native.storage.get(MOBILE_ACCOUNT_VAULT_KEY)).toBe(previousVault);
    expect(native.http.mock.calls.some(([url]) => url.endsWith('/logout'))).toBe(false);
  });
  it('does not allow an account switch to publish while an explicit logout is retiring the old service', async () => {
    await login(); await act(async () => { await auth.beginAddAccount(); }); await login('https://b.test');
    let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
    native.http.mockImplementation(async (url, init) => { if (url.endsWith('/logout')) await waiting; return server(url, init); });
    let pending!: Promise<void>;
    await act(async () => { pending = auth.logout(); });
    const keyA = accountVaultKey(authServiceScope({ kind: 'lex-server', origin: 'https://a.test' }), 'test-member');
    await act(async () => { await expect(auth.switchAccount(keyA)).rejects.toThrow('AUTH_FLOW_SUPERSEDED'); });
    expect(auth.isAuthenticated).toBe(false);
    await act(async () => { finish(); await pending; });
    expect(auth.service).toEqual({ kind: 'lex-server', origin: 'https://a.test' });
    expect(auth.isAuthenticated).toBe(true);
  });
});
