// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CindyImportWizard } from '../CindyImportWizard';
const api = vi.hoisted(() => ({ discover: vi.fn(), chooseSource: vi.fn(), scan: vi.fn(), preview: vi.fn(), chooseProject: vi.fn(), commit: vi.fn(), cancel: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number }) => values?.count == null ? key : key + ' ' + values.count }) }));
vi.mock('@/state/newMakerDraft', () => ({ getDraft: () => ({ lastByVendor: { cc: {}, codex: {}, pi: {}, omp: {} } }), getFastModeForModel: () => false }));
vi.mock('@/lib/sessionsBus', () => ({ emitRefresh: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { cindyImport: api } } });
  api.discover.mockResolvedValue([{ id: 'source', label: 'Cindy', location: '/synthetic/source', accountIndex: 1 }]);
  api.scan.mockResolvedValue({ scanId: 'scan', excluded: 2, candidates: [{ id: 'one', title: 'Test task', agentKind: 'cc', updatedAt: 10, workingDir: '/synthetic/project' }] });
  api.preview.mockResolvedValue({ previewId: 'preview', items: [{ id: 'one', title: 'Test task', issues: ['nativeMissing'], missingFiles: ['history.jsonl'], historyIncomplete: true, needsDirectory: true, workingDir: null }] });
  api.chooseProject.mockResolvedValue('/chosen/project');
  api.commit.mockResolvedValue([{ id: 'one', status: 'imported', sessionId: 'copy' }]);
  api.cancel.mockResolvedValue(undefined);
});
afterEach(cleanup);
it('requires fresh partial-copy consent after source changes invalidate the preview', async () => {
  api.preview.mockResolvedValue({ previewId: 'preview', items: [{ id: 'one', title: 'Test task', issues: ['nativeMissing'], missingFiles: [], historyIncomplete: true, needsDirectory: false, workingDir: null }] });
  api.commit.mockRejectedValueOnce(new Error('[SHARE_IMPORT_FAILED] sourceChanged'));
  render(<CindyImportWizard onClose={() => undefined} />);
  await screen.findByText(/Cindy · settings.cindyImport.account 1/);
  async function preview() {
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.scan' }));
    fireEvent.click(await screen.findByRole('button', { name: /Test task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.preview 1' }));
    await screen.findByText('settings.cindyImport.historyOnly');
  }
  await preview();
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.allowIncomplete' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.import' }));
  await screen.findByText('settings.cindyImport.errors.sourceChanged');
  api.preview.mockResolvedValue({ previewId: 'fresh-preview', items: [{ id: 'one', title: 'Test task', issues: ['nativeMissing', 'attachmentMissing'], missingFiles: ['newly-missing.txt'], historyIncomplete: true, needsDirectory: false, workingDir: null }] });
  await preview();
  expect(screen.getByRole('button', { name: 'settings.cindyImport.allowIncomplete' }).getAttribute('aria-pressed')).toBe('false');
  const submit = screen.getByRole('button', { name: 'settings.cindyImport.import' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(api.commit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.allowIncomplete' }));
  fireEvent.click(submit);
  await screen.findByText('settings.cindyImport.results.imported');
  expect(api.commit).toHaveBeenLastCalledWith(expect.objectContaining({ previewId: 'fresh-preview', allowIncomplete: true }));
});
it('requires selection, preview, a project directory and explicit partial-copy consent before committing', async () => {
  render(<CindyImportWizard onClose={() => undefined} />);
  await screen.findByText(/Cindy · settings.cindyImport.account 1/);
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.scan' }));
  fireEvent.click(await screen.findByRole('button', { name: /Test task/ }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.preview 1' }));
  await screen.findByText('settings.cindyImport.historyOnly');
  const submit = screen.getByRole('button', { name: 'settings.cindyImport.import' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true); expect(api.commit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.chooseProject' }));
  await screen.findByText('/chosen/project'); expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.allowIncomplete' }));
  fireEvent.click(submit);
  await screen.findByText('settings.cindyImport.results.imported');
  expect(api.commit).toHaveBeenCalledWith(expect.objectContaining({ previewId: 'preview', allowIncomplete: true }));
});
it('does not scan account contents before the user chooses to scan and cancels on close', async () => {
  const close = vi.fn(); render(<CindyImportWizard onClose={close} />);
  await screen.findByText(/Cindy · settings.cindyImport.account 1/); expect(api.scan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'settings.cindyImport.close' }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalled()); expect(close).toHaveBeenCalled();
});
