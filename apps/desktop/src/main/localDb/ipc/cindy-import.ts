import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { CindyImportCommit } from '../../../shared/cindyImport';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { CindyImportService, errorCode } from '../../cindy-import/service';
import { notifyGhostSessionEvent } from '../../cindy-brain/index';

export function registerCindyImportIpc(): void {
  const controllers = new Map<number, CindyImportService>();
  const controller = (event: IpcMainInvokeEvent): CindyImportService => {
    const current = controllers.get(event.sender.id);
    if (!current) throwIpcError('PRECONDITION_FAILED', 'invalidSelection');
    current.assertCurrent();
    return current;
  };
  const handle = (name: string, action: (event: IpcMainInvokeEvent, payload: any) => Promise<unknown>) => {
    ipcMain.handle('local-db:cindy-import:' + name, async (event, payload) => {
      assertTrustedAppRendererEvent(event);
      try { return await action(event, payload); }
      catch (error) { throwIpcError('SHARE_IMPORT_FAILED', errorCode(error)); }
    });
  };
  handle('discover', async (event) => {
    const old = controllers.get(event.sender.id);
    await old?.cancel();
    const service = new CindyImportService();
    controllers.set(event.sender.id, service);
    event.sender.once('destroyed', () => { void service.cancel().catch(() => undefined); if (controllers.get(event.sender.id) === service) controllers.delete(event.sender.id); });
    return service.run(() => service.discover());
  });
  handle('choose-source', async (event) => {
    const service = controller(event);
    return service.run(async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return [];
      const chosen = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      service.assertCurrent();
      return chosen.canceled ? [] : service.discover(chosen.filePaths[0]);
    });
  });
  handle('scan', async (event, sourceId) => {
    const service = controller(event);
    if (typeof sourceId !== 'string') throwIpcError('INVALID_PARAMS', 'invalidSelection');
    return service.run(() => service.scan(sourceId));
  });
  handle('preview', async (event, input) => {
    const service = controller(event);
    return service.run(() => service.preview(input?.scanId, input?.ids));
  });
  handle('choose-project', async (event, input) => {
    const service = controller(event);
    return service.run(async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const chosen = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      service.assertCurrent();
      return chosen.canceled ? null : service.chooseProject(input?.previewId, input?.id, chosen.filePaths[0]);
    });
  });
  handle('commit', async (event, input: CindyImportCommit) => {
    const service = controller(event);
    if (!input || typeof input !== 'object') throwIpcError('INVALID_PARAMS', 'invalidSelection');
    return service.run(async () => {
      const results = await service.commit(input);
      for (const item of results) if (item.status === 'imported' && item.sessionId) notifyGhostSessionEvent('created', { sessionId: item.sessionId });
      return results;
    });
  });
  handle('cancel', async (event) => {
    const service = controllers.get(event.sender.id);
    await service?.cancel();
    if (controllers.get(event.sender.id) === service) controllers.delete(event.sender.id);
  });
}
