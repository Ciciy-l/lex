import type { IpcMainInvokeEvent } from 'electron';
import type { AgentSessionPresentation } from '@cindy/maker-core';
import { AGENT_PRESENTATION_CHANNEL } from '../../shared/agentPresentation.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { AgentPresentationService } from './agentPresentationService.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export { AGENT_PRESENTATION_CHANNEL };

export function createAgentPresentationHandler(resolve: (sessionId: string) => AgentSessionPresentation | undefined) {
  const service = new AgentPresentationService(resolve);
  const windows = new Set<number>();
  return {
    close: () => service.close(),
    async handle(event: IpcMainInvokeEvent, request: unknown): Promise<unknown> {
      const context = getDeviceLinkInvokeContext();
      // Shared-task guests have structured task permissions, not arbitrary native
      // shell/CLI control. Same-account paired desktops use the ordinary tunnel.
      if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Native presentation unavailable for shared task guests');
      if (context && !context.assertCurrent) throwIpcError('PERMISSION_DENIED', 'Native presentation requires a current device link');
      if (!context) assertTrustedAppRendererEvent(event);
      const owner = getCurrentDbClientSnapshot();
      const id = context ? 'device:' + context.controllerDeviceId : 'window:' + event.sender.id;
      const assertCurrent = () => {
        if (!owner || isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== owner) throw new Error('Native presentation owner changed');
        if (context) context.assertCurrent?.();
        else {
          if (event.sender.isDestroyed()) throw new Error('Native presentation window closed');
          assertTrustedAppRendererEvent(event);
        }
      };
      if (!context && !windows.has(event.sender.id)) {
        windows.add(event.sender.id);
        event.sender.once('destroyed', () => { windows.delete(event.sender.id); service.detachPeer(id); });
      }
      try { return await service.invoke({ id, assertCurrent }, request); }
      catch { throwIpcError('PRECONDITION_FAILED', 'Native presentation unavailable or view expired'); }
    },
  };
}
