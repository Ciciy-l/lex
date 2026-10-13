import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { sessionsStore } from '@/lib/sessionsStore';
import { enableRemoteCollabForSession } from './remoteCollabHandoff';
import type { CreateWorkerForm } from './CreateWorkerPopover';
import { createWorkerLabel } from './workerLabel';

/** Shared by the session toggle and sidebar's first-worker submission. */
export async function enableCollabFromForm(
  leadSessionId: string,
  form: CreateWorkerForm,
  label = createWorkerLabel(form.role, []),
  deviceId: string | null | undefined = getStickySessionDeviceId(leadSessionId),
) {
  const options = {
    workerAgent: form.agent,
    role: form.role,
    label,
    model: form.model,
    effort: form.effort as Parameters<typeof window.electronAPI.maker.enableOrca>[1]['effort'],
    fast: form.fast,
    providerId: form.providerId ?? undefined,
    delegateTask: form.initialTask || undefined,
    workerPermissionMode: form.workerPermissionMode,
  };
  if (deviceId) {
    const result = await enableRemoteCollabForSession({
      deviceId,
      leadSessionId,
      options,
      logTag: 'sidebar enable collab',
    });
    return result.focusWorkerSessionId;
  }
  const result = await window.electronAPI.maker.enableOrca(leadSessionId, options);
  void sessionsStore.forceRefresh('active');
  return result.workerSessionId;
}
