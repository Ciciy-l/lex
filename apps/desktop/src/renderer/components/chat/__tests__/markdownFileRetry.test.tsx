// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ error: vi.fn(), sidebar: vi.fn(), lightbox: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, warning: vi.fn(), dismiss: vi.fn(), loading: vi.fn() } }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/useStreamFadePreference', () => ({ useStreamFadeEnabled: () => false }));
vi.mock('@/hooks/useLinkOpenPreference', () => ({ getLinkOpenPreference: () => 'sidebar', getLinkOpenPreferenceForUrl: () => 'sidebar' }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: vi.fn(), remoteProjectsStore: { subscribe: vi.fn() } }));
vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({ useSidebarTargetSessionId: (id: string) => id }));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({ openUrlInSidebarBrowser: mocks.sidebar, pathToFileUrl: (p: string) => 'file://' + p }));
vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({ openDirInSidebarFileBrowser: vi.fn() }));
vi.mock('../useFileChipContextMenu', () => ({ useFileChipContextMenu: () => ({ onContextMenu: vi.fn(), menu: null }) }));
vi.mock('../TextLightbox', () => ({ TextLightbox: (props: { filePath: string; initialLine?: number }) => {
  mocks.lightbox(props);
  return <div data-testid="file-preview">{props.filePath}:{props.initialLine}</div>;
} }));
vi.mock('../ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../ImageHoverPreview', () => ({ ImageHoverPreview: () => null }));
vi.mock('../ModelLightbox', () => ({ ModelLightbox: () => null }));
vi.mock('../SessionHandoffCard', () => ({ SessionHandoffCard: () => null }));
vi.mock('../SessionLinkChip', () => ({ SessionLinkChip: () => null }));
vi.mock('../ProjectLinkChip', () => ({ ProjectLinkChip: () => null }));
vi.mock('../MarkdownDiffBlock', () => ({ MarkdownDiffBlock: () => null }));
vi.mock('../MarkdownMermaidBlock', () => ({ MarkdownMermaidBlock: () => null }));
vi.mock('../CopyAsImageBlock', () => ({ CopyAsImageBlock: ({ children }: { children: ReactNode }) => children, mathBlockToLatex: vi.fn(), tableToTsv: vi.fn() }));

import { _clearResolveCache, resolveWorkspacePathBatchCached, resolveWorkspacePathCached } from '../../../../main/pathResolver';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { _clearSmartResolveCache } from '@/lib/localPathResolver';
import { _clearRemotePathVerdictCache } from '@/lib/remoteFileOpen';
import type { SessionFileOrigin } from '@/lib/sessionFileOrigin';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let cwd: string;
const api = {
  resolvePath: vi.fn(), resolvePathBatch: vi.fn(), openPath: vi.fn(), openExternal: vi.fn(),
  fileBrowser: { chatStat: vi.fn(), chatFetch: vi.fn(), previewHtml: vi.fn() },
};
function view(content = '[Read file](./new.ts:7)', sessionId = 'task-a', origin: SessionFileOrigin = { kind: 'local' }, workdir = cwd) {
  return <ChatSessionFileProvider value={{ sessionId, origin, workingDir: workdir }}>
    <MarkdownRenderer content={content} workingDir={workdir} currentSessionId={sessionId} />
  </ChatSessionFileProvider>;
}
beforeEach(() => {
  vi.resetAllMocks();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-file-retry-'));
  _clearResolveCache(); _clearSmartResolveCache(); _clearRemotePathVerdictCache();
  setDataOwnerGeneration('fixture-owner');
  api.resolvePathBatch.mockImplementation(({ hrefs, workingDir }) => resolveWorkspacePathBatchCached(hrefs, workingDir));
  api.resolvePath.mockImplementation(({ href, workingDir, refresh }) => resolveWorkspacePathCached(href, workingDir, { refresh }));
  api.openPath.mockResolvedValue({ success: true });
  api.fileBrowser.chatStat.mockResolvedValue({ verdict: 'unknown' });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
});
afterEach(() => {
  cleanup(); _clearSmartResolveCache(); _clearRemotePathVerdictCache(); _clearResolveCache();
  setDataOwnerGeneration(null);
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('authored Markdown file links through production resolver caches', () => {
  it('keeps missing links copyable, reports failure, then opens a newly created file on an explicit retry', async () => {
    render(view());
    const link = screen.getByRole('link', { name: 'Read file' });
    expect(link.getAttribute('href')).toBe('./new.ts:7');
    await waitFor(() => expect(api.resolvePathBatch).toHaveBeenCalledOnce());
    fireEvent.click(link);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('chat.markdownRenderer.fileUnavailable'));
    expect(screen.queryByTestId('file-preview')).toBeNull();
    fs.writeFileSync(path.join(cwd, 'new.ts'), 'export const value = 1;');
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId('file-preview').textContent).toBe(path.join(cwd, 'new.ts') + ':7'));
    expect(api.resolvePath).toHaveBeenCalledTimes(2);
    expect(api.resolvePath).toHaveBeenLastCalledWith({ href: './new.ts', workingDir: cwd, refresh: true });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it('does not open a stale positive after deletion, or dispatch duplicate clicks while a refresh is pending', async () => {
    fs.writeFileSync(path.join(cwd, 'new.ts'), 'fixture');
    render(view());
    await waitFor(() => expect(api.resolvePathBatch).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    fs.unlinkSync(path.join(cwd, 'new.ts'));
    const pending = deferred<{ status: 'none'; candidates: string[] }>();
    api.resolvePath.mockReturnValueOnce(pending.promise);
    const link = screen.getByRole('link', { name: 'Read file' });
    fireEvent.click(link); fireEvent.click(link);
    expect(api.resolvePath).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ status: 'none', candidates: [] }));
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('file-preview')).toBeNull();
  });

  it.each(['task', 'cwd', 'owner', 'origin', 'unmount'] as const)('discards a late click result after %s changes', async boundary => {
    const pending = deferred<{ status: 'unique'; candidates: string[] }>();
    api.resolvePath.mockReturnValueOnce(pending.promise);
    const mounted = render(view());
    fireEvent.click(screen.getByRole('link', { name: 'Read file' }));
    if (boundary === 'task') mounted.rerender(view(undefined, 'task-b'));
    if (boundary === 'cwd') mounted.rerender(view(undefined, 'task-a', { kind: 'local' }, path.join(cwd, 'different')));
    if (boundary === 'owner') setDataOwnerGeneration('new-owner');
    if (boundary === 'origin') mounted.rerender(view(undefined, 'task-a', { kind: 'device', deviceId: 'new-device' }));
    if (boundary === 'unmount') mounted.unmount();
    await act(async () => pending.resolve({ status: 'unique', candidates: [path.join(cwd, 'private.ts')] }));
    expect(mocks.lightbox).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it('does not let a retired click release the new task single-flight guard', async () => {
    const old = deferred<{ status: 'unique'; candidates: string[] }>();
    const current = deferred<{ status: 'unique'; candidates: string[] }>();
    api.resolvePath.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const mounted = render(view());
    fireEvent.click(screen.getByRole('link', { name: 'Read file' }));
    mounted.rerender(view(undefined, 'task-b'));
    fireEvent.click(screen.getByRole('link', { name: 'Read file' }));
    await act(async () => old.resolve({ status: 'unique', candidates: [path.join(cwd, 'old.ts')] }));
    fireEvent.click(screen.getByRole('link', { name: 'Read file' }));
    expect(api.resolvePath).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ status: 'unique', candidates: [path.join(cwd, 'current.ts')] }));
    expect(screen.getByTestId('file-preview').textContent).toBe(path.join(cwd, 'current.ts') + ':7');
  });

  it('keeps automatic bare paths, inline code and untrusted previews noninteractive when unresolved', async () => {
    const mounted = render(view('src/missing.ts and `src/other.ts`'));
    await waitFor(() => expect(api.resolvePathBatch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    mounted.rerender(<MarkdownRenderer content="[Untrusted](new.ts)" workingDir={cwd} allowPrivilegedLinks={false} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(api.resolvePath).not.toHaveBeenCalled();
  });

  it('fails closed on an older host without resolvePath and leaves the explicit link available for retry', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
    render(view());
    fireEvent.click(screen.getByRole('link', { name: 'Read file' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('file-preview')).toBeNull();
    expect(screen.getByRole('link', { name: 'Read file' })).toBeTruthy();
  });

  it.each([{ kind: 'device', deviceId: 'device-a' }, { kind: 'ssh', remoteHostId: 'ssh-a' }] as const)('refreshes $kind unknown without ever falling back to local resolution', async origin => {
    api.fileBrowser.chatStat.mockResolvedValue({ verdict: 'unknown' });
    render(view('[Remote file](file.ts)', 'remote-task', origin, '/remote'));
    await waitFor(() => expect(api.fileBrowser.chatStat).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('link', { name: 'Remote file' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    api.fileBrowser.chatStat.mockResolvedValue({ verdict: 'file' });
    fireEvent.click(screen.getByRole('link', { name: 'Remote file' }));
    await waitFor(() => expect(screen.getByTestId('file-preview').textContent).toBe('/remote/file.ts:'));
    expect(api.fileBrowser.chatStat).toHaveBeenCalledTimes(3);
    expect(api.resolvePath).not.toHaveBeenCalled();
    expect(api.resolvePathBatch).not.toHaveBeenCalled();
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it('keeps a remote HTML result from opening after its task changes during preview fetch', async () => {
    api.fileBrowser.chatStat.mockResolvedValue({ verdict: 'file' });
    const preview = deferred<{ url: string }>();
    api.fileBrowser.previewHtml.mockReturnValueOnce(preview.promise);
    const origin = { kind: 'device' as const, deviceId: 'device-a' };
    const mounted = render(view('[Preview](index.html)', 'task-a', origin, '/remote'));
    fireEvent.click(screen.getByRole('link', { name: 'Preview' }));
    await waitFor(() => expect(api.fileBrowser.previewHtml).toHaveBeenCalledOnce());
    mounted.rerender(view('[Preview](index.html)', 'task-b', origin, '/remote'));
    await act(async () => preview.resolve({ url: 'http://127.0.0.1:12345/fixture/' }));
    expect(mocks.sidebar).not.toHaveBeenCalled();
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
