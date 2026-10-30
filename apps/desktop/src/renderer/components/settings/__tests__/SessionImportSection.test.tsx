// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionImportSection } from '../SessionImportSection';
const api = vi.hoisted(() => ({ discover: vi.fn(), chooseSource: vi.fn(), scan: vi.fn(), preview: vi.fn(), chooseProject: vi.fn(), commit: vi.fn(), cancel: vi.fn() }));
const native = vi.hoisted(() => ({ scan: vi.fn(), importSelected: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number }) => values?.count == null ? key : key + ' ' + values.count }) }));
vi.mock('@/state/newMakerDraft', () => ({ getDraft: () => ({ lastByVendor: { cc: {}, codex: {}, pi: {}, omp: {} } }), getFastModeForModel: () => false }));
vi.mock('@/lib/sessionsBus', () => ({ emitRefresh: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../SessionShareImportWizard', () => ({ SessionShareImportWizard: () => null }));
const candidate = { id: 'one', title: 'Cindy task', agentKind: 'cc', updatedAt: 10, workingDir: null, workspaceKind: 'dialogue', archived: false, imported: false };
const preview = { previewId: 'preview', items: [{ id: 'one', title: 'Cindy task', issues: ['nativeMissing'], missingFiles: ['history.jsonl'], historyIncomplete: true, needsDirectory: false, workingDir: null }] };
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { cindyImport: api, sessionImport: native } } });
  api.discover.mockResolvedValue([{ id: 'source', label: 'Cindy', location: '/synthetic/source', accountIndex: 1 }]);
  api.chooseSource.mockResolvedValue([]);
  api.scan.mockResolvedValue({ scanId: 'scan', excluded: 2, candidates: [candidate] });
  api.preview.mockResolvedValue(preview);
  api.chooseProject.mockResolvedValue('/chosen/project');
  api.commit.mockResolvedValue([{ id: 'one', status: 'imported', sessionId: 'copy' }]);
  api.cancel.mockResolvedValue(undefined);
  native.scan.mockResolvedValue({ sources: { codexHomes: [], claudeRoots: [] }, currentProjectDirs: [], rejected: { codex: 0, claude: 0, existing: 0 }, candidates: [{ key: 'codex:native', id: 'native', source: 'codex', title: 'Native task', cwd: '', updatedAt: new Date(20).toISOString(), archived: false, workspaceKind: 'dialogue', sidebarBucket: 'dialogue', projectDir: null }] });
  native.importSelected.mockResolvedValue({ inserted: 1, updated: 0 });
});
afterEach(cleanup);
function button(name: string) { return screen.getByRole('button', { name }) as HTMLButtonElement; }
function checkbox(name: RegExp | string) { return screen.getByRole('checkbox', { name }) as HTMLInputElement; }
async function ready() {
  await waitFor(() => expect(button('settings.sessionImport.filters.cindy').disabled).toBe(false));
}
async function scanCindy() {
  await ready();
  fireEvent.click(button('settings.sessionImport.filters.cindy'));
  fireEvent.click(button('settings.sessionImport.scan'));
  await screen.findByRole('checkbox', { name: /Cindy task/ });
}
async function prepareCindy() {
  await scanCindy();
  fireEvent.click(checkbox(/Cindy task/));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await screen.findByText('settings.cindyImport.historyOnly');
}
it('offers Cindy next to Codex and Claude Code, without a modal or automatic account scan', async () => {
  const view = render(<StrictMode><SessionImportSection /></StrictMode>);
  await ready();
  const sources = screen.getByRole('group', { name: 'settings.sessionImport.filters.source' });
  for (const name of ['all', 'codex', 'claude', 'cindy']) expect(within(sources).getByRole('button', { name: 'settings.sessionImport.filters.' + name })).toBeTruthy();
  expect(api.discover).toHaveBeenCalledTimes(1); expect(native.scan).toHaveBeenCalledTimes(1);
  expect(api.scan).not.toHaveBeenCalled(); expect(api.cancel).not.toHaveBeenCalled();
  fireEvent.click(button('settings.sessionImport.filters.cindy'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(button('settings.sessionImport.filters.codex'));
  expect(api.cancel).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
});
it('retains selections across source filters and includes Cindy in All and mixed imports', async () => {
  render(<SessionImportSection />); await ready();
  fireEvent.click(checkbox(/Native task/));
  await scanCindy(); fireEvent.click(checkbox(/Cindy task/));
  expect(screen.getByText('settings.sessionImport.selectedOutsideFilter 1')).toBeTruthy();
  const sources = screen.getByRole('group', { name: 'settings.sessionImport.filters.source' });
  fireEvent.click(within(sources).getByRole('button', { name: 'settings.sessionImport.filters.all' }));
  expect(checkbox(/Native task/).checked).toBe(true); expect(checkbox(/Cindy task/).checked).toBe(true);
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await screen.findByText('settings.cindyImport.alsoImportNative 1');
  expect(native.importSelected).not.toHaveBeenCalled();
  fireEvent.click(checkbox('settings.cindyImport.allowIncomplete'));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await waitFor(() => expect(native.importSelected).toHaveBeenCalledWith([{ source: 'codex', id: 'native' }]));
  await screen.findByText('settings.cindyImport.results.imported');
});
it('requires fresh consent after source changes invalidate the preview', async () => {
  api.commit.mockRejectedValueOnce(new Error('[SHARE_IMPORT_FAILED] sourceChanged'));
  render(<SessionImportSection />);
  await prepareCindy();
  fireEvent.click(checkbox('settings.cindyImport.allowIncomplete'));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await screen.findByText('settings.cindyImport.errors.sourceChanged');
  api.preview.mockResolvedValue({ ...preview, previewId: 'fresh-preview', items: [{ ...preview.items[0], issues: ['nativeMissing', 'attachmentMissing'], missingFiles: ['newly-missing.txt'] }] });
  await prepareCindy();
  expect(checkbox('settings.cindyImport.allowIncomplete').checked).toBe(false);
  expect(button('settings.sessionImport.importSelected').disabled).toBe(true);
  expect(api.commit).toHaveBeenCalledTimes(1);
  fireEvent.click(checkbox('settings.cindyImport.allowIncomplete'));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await screen.findByText('settings.cindyImport.results.imported');
  expect(api.commit).toHaveBeenLastCalledWith(expect.objectContaining({ previewId: 'fresh-preview', allowIncomplete: true }));
});
it('requires a project directory and explicit partial-copy consent before committing', async () => {
  api.preview.mockResolvedValue({ ...preview, items: [{ ...preview.items[0], needsDirectory: true }] });
  render(<SessionImportSection />); await prepareCindy();
  expect(button('settings.sessionImport.importSelected').disabled).toBe(true); expect(api.commit).not.toHaveBeenCalled();
  fireEvent.click(button('settings.cindyImport.chooseProject'));
  await screen.findByText('/chosen/project'); expect(button('settings.sessionImport.importSelected').disabled).toBe(true);
  fireEvent.click(checkbox('settings.cindyImport.allowIncomplete'));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await screen.findByText('settings.cindyImport.results.imported');
  fireEvent.click(button('settings.cindyImport.backToList'));
  expect(checkbox(/Cindy task/).disabled).toBe(true);
  expect(checkbox(/Cindy task/).checked).toBe(false);
});
it('invalidates Cindy selection on account changes, but keeps native selection', async () => {
  api.discover.mockResolvedValue([{ id: 'source', label: 'Cindy', location: '/synthetic/one', accountIndex: 1 }, { id: 'second', label: 'Cindy', location: '/synthetic/two', accountIndex: 2 }]);
  render(<SessionImportSection />); await ready(); fireEvent.click(checkbox(/Native task/));
  await scanCindy(); fireEvent.click(checkbox(/Cindy task/));
  fireEvent.click(button('Cindy · settings.cindyImport.account 2'));
  expect(screen.queryByRole('checkbox', { name: /Cindy task/ })).toBeNull();
  expect(screen.getByText('settings.sessionImport.selected 1')).toBeTruthy();
  fireEvent.click(button('settings.sessionImport.scan'));
  await waitFor(() => expect(api.scan).toHaveBeenLastCalledWith('second'));
});
it('caps Cindy bulk selection at 100, skips imported rows, and can clear a capped selection', async () => {
  api.scan.mockResolvedValue({ scanId: 'scan', excluded: 0, candidates: Array.from({ length: 102 }, (_, i) => ({ ...candidate, id: String(i), title: 'Cindy task ' + i, imported: i === 101 })) });
  render(<SessionImportSection />); await ready(); fireEvent.click(button('settings.sessionImport.filters.cindy'));
  fireEvent.click(button('settings.sessionImport.scan')); await screen.findByRole('checkbox', { name: /Cindy task 101/ });
  const all = checkbox('settings.sessionImport.selectAll 101');
  fireEvent.click(all);
  expect(screen.getByText('settings.sessionImport.selected 100')).toBeTruthy();
  expect(checkbox(/Cindy task 101/).checked).toBe(false);
  fireEvent.click(all); expect(screen.getByText('settings.sessionImport.selected 0')).toBeTruthy();
});
it('ignores a late scan after cancel and can restart without leaving settings', async () => {
  let finish!: (value: unknown) => void;
  api.scan.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<SessionImportSection />); await ready(); fireEvent.click(button('settings.sessionImport.filters.cindy'));
  fireEvent.click(button('settings.sessionImport.scan'));
  fireEvent.click(await screen.findByRole('button', { name: 'settings.cindyImport.cancel' }));
  await act(async () => { finish({ scanId: 'late', candidates: [candidate], excluded: 0 }); });
  expect(screen.queryByRole('checkbox', { name: /Cindy task/ })).toBeNull();
  fireEvent.click(button('settings.cindyImport.restart'));
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
});
it('keeps native-only imports on their existing direct path', async () => {
  render(<SessionImportSection />); await ready(); fireEvent.click(checkbox(/Native task/));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  await waitFor(() => expect(native.importSelected).toHaveBeenCalledWith([{ source: 'codex', id: 'native' }]));
  expect(api.preview).not.toHaveBeenCalled(); expect(api.commit).not.toHaveBeenCalled();
});
it('does not continue a mixed batch after cancellation, even if the in-flight item completes', async () => {
  let finish!: (value: unknown) => void;
  api.commit.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<SessionImportSection />); await ready(); fireEvent.click(checkbox(/Native task/));
  await prepareCindy(); fireEvent.click(checkbox('settings.cindyImport.allowIncomplete'));
  fireEvent.click(button('settings.sessionImport.importSelected'));
  fireEvent.click(button('settings.cindyImport.cancel'));
  await act(async () => { finish([{ id: 'one', status: 'imported', sessionId: 'completed-before-cancel' }]); });
  expect(api.commit).toHaveBeenCalledTimes(1); expect(native.importSelected).not.toHaveBeenCalled();
  expect(screen.getByText('settings.cindyImport.results.imported')).toBeTruthy();
});
it('uses the same project group for native and Cindy tasks and selects both together', async () => {
  const nativeScan = await native.scan(); native.scan.mockClear();
  native.scan.mockResolvedValue({ ...nativeScan, candidates: [{ ...nativeScan.candidates[0], cwd: '/synthetic/project', projectDir: '/synthetic/project', sidebarBucket: 'project', workspaceKind: 'project' }] });
  api.scan.mockResolvedValue({ scanId: 'scan', excluded: 0, candidates: [{ ...candidate, workingDir: '/synthetic/project', workspaceKind: 'project' }] });
  render(<SessionImportSection />); await ready();
  fireEvent.click(button('settings.sessionImport.scan'));
  await waitFor(() => expect(button('settings.sessionImport.scan').disabled).toBe(false));
  expect(screen.getAllByRole('button', { name: 'settings.sessionImport.expand' })).toHaveLength(1);
  fireEvent.click(checkbox('settings.sessionImport.selectGroup'));
  expect(screen.getByText('settings.sessionImport.selected 2')).toBeTruthy();
  fireEvent.click(button('settings.sessionImport.expand'));
  expect(checkbox(/Native task/).checked).toBe(true); expect(checkbox(/Cindy task/).checked).toBe(true);
});
