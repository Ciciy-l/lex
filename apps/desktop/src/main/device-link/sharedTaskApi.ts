import {
  buildSharedTaskInvitationLink,
  createSharedTaskApi,
  parseSharedTaskInvitation,
  sharedTaskAccountName,
  SharedTaskScopeChangedError,
} from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  getAccessToken,
  getActiveAuthRealm,
  getAuthState,
  getCurrentUserId,
} from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Main-owned adapter; authentication and retry policy stay in serverApiClient. */
const accountApi = createSharedTaskApi({
  captureScope() {
    const key = activeOwnerScopeKey();
    const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
    const region = getActiveAuthRealm();
    return {
      isCurrent: () => getAuthState().isAuthenticated &&
        !isAppSessionBoundaryPending() &&
        activeOwnerScopeKey() === key &&
        getActiveAuthRealm() === region &&
        getClientEndpoint('deviceLinkApiBaseUrl') === endpoint,
    };
  },
  async request(path, options) {
    try {
      return await serverApiFetch<unknown>(path, {
        method: options.method,
        body: options.body,
        // This callback is run before every physical attempt, including the
        // token refresh path. It is deliberately bound to this request, not a
        // mutable global account callback.
        beforeAttempt: () => {
          if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
        },
        baseUrl: () => {
          if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
          return getClientEndpoint('deviceLinkApiBaseUrl');
        },
        timeoutMs: 15_000,
        cache: 'no-store',
        logLabel: '/api/device-link/shared-tasks',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: [
          'NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED', 'INVALID_PARAMS',
          'RATE_LIMITED', 'SHARED_TASK_HOST_LIMIT', 'SHARED_TASK_JOIN_LIMIT',
          'SHARED_TASK_GUEST_LIMIT', 'SHARED_TASK_SELF_JOIN',
        ],
      });
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === 'SHARED_TASK_HOST_LIMIT' || code === 'SHARED_TASK_JOIN_LIMIT' || code === 'SHARED_TASK_GUEST_LIMIT') {
        throwIpcError(code, 'Shared task limit reached');
      }
      // Only stable actionable codes cross Electron serialization. Never copy
      // an invitation, token, endpoint, or server response body into the error.
      if (code === 'NOT_FOUND' || code === 'PERMISSION_DENIED' || code === 'INVALID_PARAMS' || code === 'SHARED_TASK_SELF_JOIN') {
        throwIpcError(code, 'Shared task request rejected');
      }
      if (code === 'NETWORK_ERROR') throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Shared task service unreachable');
      throw error;
    }
  },
});

export const sharedTaskApi = {
  ...accountApi,
  async invite(sharedTaskId: string) {
    const result = await accountApi.invite(sharedTaskId);
    return {
      ...result,
      invitationLink: buildSharedTaskInvitationLink(
        result.invitation,
        getClientEndpoint('deviceLinkApiBaseUrl'),
      ),
    };
  },
  async join(input: string, _displayName: string) {
    const parsed = parseSharedTaskInvitation(
      input,
      getClientEndpoint('deviceLinkApiBaseUrl'),
    );
    if (!parsed.ok) {
      throwIpcError(
        parsed.reason === 'different-server' ? 'REGION_MISMATCH' : 'INVALID_PARAMS',
        'Invalid shared task invitation or service mismatch',
      );
    }
    return accountApi.join(parsed.invitation, sharedTaskAccountName(getAuthState().user?.name));
  },
};

/**
 * Capture the outgoing credentials for close-only cleanup. This adapter never
 * refreshes or invalidates a session: a late 401 from the old account must not
 * log out or otherwise mutate the account that won the handover.
 */
export function captureSharedTaskBoundaryClose(
  ownerAccountId: string,
  region: ReturnType<typeof getActiveAuthRealm>,
) {
  if (getCurrentUserId() !== ownerAccountId || getActiveAuthRealm() !== region) return null;
  const token = getAccessToken();
  if (!token) return null;
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const api = createSharedTaskApi({
    captureScope: () => ({ isCurrent: () => true }),
    request: (path, options) => serverApiFetch<unknown>(path, {
      method: options.method,
      body: options.body,
      token,
      baseUrl: endpoint,
      skipAutoRefresh: true,
      skipSessionInvalidation: true,
      timeoutMs: 3_000,
      cache: 'no-store',
      redactErrorDetails: true,
      logLabel: '/api/device-link/shared-tasks',
    }),
  });
  return (sharedTaskId: string) => api.close(sharedTaskId);
}
