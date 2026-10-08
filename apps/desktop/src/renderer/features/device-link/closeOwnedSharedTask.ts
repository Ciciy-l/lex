import type { SharedTaskCloseResult } from '@cindy/device-link';

/** Remote hosts must revoke local guest access before cancellation completes. */
export async function closeOwnedSharedTask(
  sharedTaskId: string,
  _hostDeviceId: string | undefined,
  current: () => boolean,
): Promise<boolean> {
  if (!current()) return false;
  // The main account adapter verifies the server-owned target once and routes
  // local tasks through the host journal or remote tasks over the authenticated
  // physical host connection. Renderer-provided hostDeviceId is deliberately
  // not used as an authority-bearing route.
  const result = await window.electronAPI.sharedTask.account({ action: 'close', sharedTaskId }) as SharedTaskCloseResult;
  return current() && result.closed.includes(sharedTaskId);
}
