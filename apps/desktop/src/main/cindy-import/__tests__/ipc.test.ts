import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: any, payload?: unknown) => Promise<unknown>>(),
  trusted: true, current: true,
  discover: vi.fn(), scan: vi.fn(), preview: vi.fn(), commit: vi.fn(), chooseProject: vi.fn(), cancel: vi.fn(),
  choose: vi.fn(), notify: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, action: any) => state.handlers.set(channel, action) },
  BrowserWindow: { fromWebContents: () => ({}) }, dialog: { showOpenDialog: state.choose },
}));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => { if (!state.trusted) throw new Error('untrusted'); } }));
vi.mock('../../utils/ipcValidate', () => ({ throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); } }));
vi.mock('../../cindy-brain/index', () => ({ notifyGhostSessionEvent: state.notify }));
vi.mock('../service', () => ({
  errorCode: (error: Error) => error.message,
  CindyImportService: class {
    assertCurrent() { if (!state.current) throw new Error('ownerChanged'); }
    async run(action: () => Promise<unknown>) { this.assertCurrent(); return action(); }
    discover = state.discover; scan = state.scan; preview = state.preview;
    commit = state.commit; chooseProject = state.chooseProject; cancel = state.cancel;
  },
}));
import { registerCindyImportIpc } from '../../localDb/ipc/cindy-import';
const event = { sender: { id: 1, once: vi.fn() } };
const invoke = (name: string, payload?: unknown) => state.handlers.get('local-db:cindy-import:' + name)!(event, payload);
beforeEach(() => {
  vi.clearAllMocks(); state.handlers.clear(); state.trusted = true; state.current = true;
  state.discover.mockResolvedValue([]); state.scan.mockResolvedValue({ scanId: 'scan' });
  state.cancel.mockResolvedValue(undefined);
  state.choose.mockResolvedValue({ canceled: false, filePaths: ['/chosen/by/native-dialog'] });
  registerCindyImportIpc();
});
it('rejects untrusted senders before discovering any files', async () => {
  state.trusted = false;
  await expect(invoke('discover')).rejects.toThrow('untrusted');
  expect(state.discover).not.toHaveBeenCalled();
});
it('requires an active discovery and validates the opaque scan handle type', async () => {
  await expect(invoke('scan', 'id')).rejects.toThrow('invalidSelection');
  await invoke('discover');
  await expect(invoke('scan', { file: '/arbitrary/database' })).rejects.toThrow('invalidSelection');
  expect(state.scan).not.toHaveBeenCalled();
  await invoke('scan', 'opaque-id'); expect(state.scan).toHaveBeenCalledWith('opaque-id');
});
it('uses only the native chooser path and checks the owner again when the chooser returns', async () => {
  await invoke('discover');
  await invoke('choose-project', { previewId: 'preview', id: 'task', directory: '/renderer/path' });
  expect(state.chooseProject).toHaveBeenCalledWith('preview', 'task', '/chosen/by/native-dialog');
  state.chooseProject.mockClear();
  state.choose.mockImplementationOnce(async () => { state.current = false; return { canceled: false, filePaths: ['/late'] }; });
  await expect(invoke('choose-project', { previewId: 'preview', id: 'task' })).rejects.toThrow('ownerChanged');
  expect(state.chooseProject).not.toHaveBeenCalled();
});
it('notifies only published tasks and clears the controller on cancel', async () => {
  await invoke('discover');
  state.commit.mockResolvedValue([{ id: 'a', status: 'imported', sessionId: 'copy' }, { id: 'b', status: 'failed' }]);
  await invoke('commit', { previewId: 'preview', preferences: {}, allowIncomplete: false });
  expect(state.notify).toHaveBeenCalledExactlyOnceWith('created', { sessionId: 'copy' });
  await invoke('cancel');
  await expect(invoke('scan', 'id')).rejects.toThrow('invalidSelection');
});
