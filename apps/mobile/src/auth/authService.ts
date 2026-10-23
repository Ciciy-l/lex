import { authServiceFromScope, type AuthService, type AuthServiceScope } from '@cindy/auth-client';
import { activateMobileSessionRealm, activateMobileLexServer, getMobileEndpointForRealm, loadMobileEndpointsForRealm } from '@/config/env';
import type { ClientEndpointKey } from '@cindy/maker-shared/client-endpoints';
import { normalizeMobileLexServerOrigin } from './mobileServerOrigin';

let activeScope: AuthServiceScope | null = null;
export function getActiveMobileAuthScope(): AuthServiceScope | null { return activeScope; }
export function getActiveMobileAuthService(): AuthService | null { return activeScope ? authServiceFromScope(activeScope) : null; }
export function isCindyMobileSession(): boolean { return activeScope === 'cn' || activeScope === 'global'; }
export function mobileServiceEndpoint(scope: AuthServiceScope, key: ClientEndpointKey): string {
  const service = authServiceFromScope(scope);
  if (service.kind === 'cindy') return getMobileEndpointForRealm(service.realm, key);
  const origin = normalizeMobileLexServerOrigin(service.origin);
  if (key === 'authApiBaseUrl' || key === 'deviceLinkApiBaseUrl') return origin;
  throw new Error('SERVICE_CAPABILITY_UNAVAILABLE');
}
export async function loadMobileAuthScope(scope: AuthServiceScope): Promise<void> {
  const service = authServiceFromScope(scope);
  if (service.kind === 'cindy') await loadMobileEndpointsForRealm(service.realm);
  else normalizeMobileLexServerOrigin(service.origin);
}
export function activateMobileAuthScope(scope: AuthServiceScope): void {
  const service = authServiceFromScope(scope);
  if (service.kind === 'cindy') activateMobileSessionRealm(service.realm);
  else activateMobileLexServer(normalizeMobileLexServerOrigin(service.origin));
  activeScope = scope;
}
export function clearActiveMobileAuthScope(): void { activeScope = null; }
