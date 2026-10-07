import { ipcMain } from 'electron';
import { getActiveAuthRealm, getCurrentUserId } from '../authManager.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { SHARED_TASK_ACCOUNT_CHANNEL, SHARED_TASK_HOST_CHANNEL } from '@cindy/device-link';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { requireSharedTaskHost } from './sharedTaskRuntime.js';
import { sharedTaskApi } from './sharedTaskApi.js';
import { executeSharedTaskAccountCommand, executeSharedTaskHostCommand } from './sharedTaskCommands.js';

interface SharedTaskRemoteHostDeps {
  openLink(deviceId: string): Promise<unknown>;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
}

/** Narrow Renderer adapter; account operations cannot be tunneled on somebody else's login. */
export function registerSharedTaskIpc(
  available: () => boolean,
  relayOnline: () => boolean,
  capability: () => boolean = available,
  remoteHost: SharedTaskRemoteHostDeps | undefined = undefined,
): void {
  const availableOnline = () => {
    // A transient disconnect is not evidence of an unsupported server version.
    if (!relayOnline()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'SharedTask relay is not connected');
    return available();
  };
  ipcMain.handle(SHARED_TASK_HOST_CHANNEL, async (event, raw: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Only the sharedTask owner can manage members');
    if (!context) assertTrustedAppRendererEvent(event);
    return executeSharedTaskHostCommand(raw, { available: availableOnline, host: requireSharedTaskHost });
  });
  ipcMain.handle(SHARED_TASK_ACCOUNT_CHANNEL, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'SharedTask account operations are local only');
    assertTrustedAppRendererEvent(event);
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { action?: unknown }).action === 'status') {
      if (!relayOnline()) return { status: 'offline' as const };
      let supported = false;
      try { supported = capability(); } catch { return { status: 'unknown' as const }; }
      if (!supported) return { status: 'unsupported' as const };
      return { status: available() ? 'ready' as const : 'unknown' as const };
    }
    if (!availableOnline()) throwIpcError('UNSUPPORTED_CAPABILITY', 'SharedTask mode requires updated clients and server');
    const owner = getCurrentUserId();
    const region = getActiveAuthRealm();
    const scope = activeOwnerScopeKey();
    const isCurrent = () => getCurrentUserId() === owner && getActiveAuthRealm() === region && activeOwnerScopeKey() === scope;
    return executeSharedTaskAccountCommand(raw, sharedTaskApi, getCurrentUserId() ?? undefined, {
      hostedIds: () => { try { return requireSharedTaskHost().activeSharedTaskIds(); } catch { return []; } },
      closeHosted: (sharedTaskId) => requireSharedTaskHost().close(sharedTaskId),
      closeRemoteHosted: async (sharedTaskId, hostDeviceId) => {
        if (!isCurrent()) throw new Error('SharedTask account changed');
        if (!remoteHost) throw new Error('Remote SharedTask host is unavailable');
        await remoteHost.openLink(hostDeviceId);
        if (!isCurrent()) throw new Error('SharedTask account changed');
        const response = await remoteHost.invoke(hostDeviceId, SHARED_TASK_HOST_CHANNEL, [
          { action: 'close', sharedTaskId },
        ]);
        if (!isCurrent()) throw new Error('SharedTask account changed');
        if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
          throw new Error('Remote SharedTask host rejected closure');
        }
      },
      isCurrent,
    });
  });
}
