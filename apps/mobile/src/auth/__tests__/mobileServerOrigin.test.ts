import { afterEach, expect, it, vi } from 'vitest';
import { authServiceScope } from '@cindy/auth-client';
const fixture = vi.hoisted(() => ({ development: false, activate: vi.fn() }));
vi.mock('../mobileBuild', () => ({ get IS_MOBILE_DEVELOPMENT() { return fixture.development; } }));
vi.mock('@/config/env', () => ({ activateMobileSessionRealm: fixture.activate, activateMobileLexServer: fixture.activate,
  getMobileEndpointForRealm: () => 'https://official.fixture.invalid', loadMobileEndpointsForRealm: async () => {} }));
import { activateMobileAuthScope, clearActiveMobileAuthScope, getActiveMobileAuthService, loadMobileAuthScope, mobileServiceEndpoint } from '../authService';
const loopback = authServiceScope({ kind: 'lex-server', origin: 'http://127.0.0.1:3101' });
afterEach(() => { fixture.development = false; fixture.activate.mockClear(); clearActiveMobileAuthScope(); });

it('rejects a saved development origin before release activation or endpoint resolution', async () => {
  expect(() => activateMobileAuthScope(loopback)).toThrow('INVALID_SERVICE_ORIGIN');
  expect(() => mobileServiceEndpoint(loopback, 'authApiBaseUrl')).toThrow('INVALID_SERVICE_ORIGIN');
  await expect(loadMobileAuthScope(loopback)).rejects.toThrow('INVALID_SERVICE_ORIGIN');
  expect(fixture.activate).not.toHaveBeenCalled(); expect(getActiveMobileAuthService()).toBeNull();
});
it('keeps development loopback and production HTTPS custom-port sessions usable', () => {
  fixture.development = true; activateMobileAuthScope(loopback);
  expect(getActiveMobileAuthService()).toMatchObject({ origin: 'http://127.0.0.1:3101' });
  fixture.development = false;
  const scope = authServiceScope({ kind: 'lex-server', origin: 'https://server.test:7443' });
  activateMobileAuthScope(scope);
  expect(mobileServiceEndpoint(scope, 'deviceLinkApiBaseUrl')).toBe('https://server.test:7443');
});
