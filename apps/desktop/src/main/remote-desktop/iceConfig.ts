import {
  REMOTE_DESKTOP_ICE_CONFIG_PATH,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
  resolveDesktopIceServers,
} from '@cindy/device-link';
import { getAppCapabilities } from '../appCapabilities.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';

export function loadDesktopIceServers() {
  if (!getAppCapabilities().canUseCindyAccountServices) return Promise.resolve([]);
  return resolveDesktopIceServers(() =>
    serverApiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
      baseUrl: () => getClientEndpoint('deviceLinkApiBaseUrl'),
      timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
      cache: 'no-store',
      redactErrorDetails: true,
    }),
  );
}
