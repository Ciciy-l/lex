// @vitest-environment jsdom

import { useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import type { TerminalCreateResult } from '../../../../../../shared/terminal-bridge';
import { createInitialTerminalState, createPaneState, hydrateTerminalState, splitTerminalPane } from '../terminal-layout';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const xtermMocks = vi.hoisted(() => ({
  disposeXterm: vi.fn(),
  getOrCreateXterm: vi.fn(),
  updateXtermTheme: vi.fn(),
}));
const actionMocks = vi.hoisted(() => ({ confirm: vi.fn(), destroy: vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: actionMocks.confirm }) }));
vi.mock('../../../lib/terminalNavigation', () => ({ destroyTerminal: actionMocks.destroy }));
const linkMocks = vi.hoisted(() => ({
  activate: null as null | ((link: { path: string; line?: number; column?: number }) => void),
  openDirectory: vi.fn(async () => undefined),
  openFile: vi.fn(async () => undefined),
}));
vi.mock('../lib/terminalFileLinks', () => ({
  registerTerminalFileLinks: (_terminal: unknown, activate: NonNullable<typeof linkMocks.activate>) => {
    linkMocks.activate = activate;
    return { dispose: vi.fn() };
  },
}));
vi.mock('../../../lib/openInSidebarFileBrowser', () => ({ openDirInSidebarFileBrowser: linkMocks.openDirectory }));
vi.mock('../../../lib/openFileContentTab', () => ({ openFileContentInSidebar: linkMocks.openFile }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../lib/xtermPool', () => xtermMocks);

import { TerminalTabBody } from '../TerminalTabBody';

function makeEntry() {
  const terminal = {
    cols: 80,
    rows: 24,
    element: undefined as HTMLElement | undefined,
    focus: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    open: vi.fn((slot: HTMLElement) => {
      terminal.element = document.createElement('div');
      slot.appendChild(terminal.element);
    }),
    write: vi.fn(),
  };
  return {
    terminal,
    searchAddon: { clearDecorations: vi.fn(), findNext: vi.fn(() => true), findPrevious: vi.fn(() => true) },
    fitAddon: { fit: vi.fn() },
    lastSize: { cols: 80, rows: 24 },
    ptyAttached: false,
  };
}

function makeContext(patchState: ReturnType<typeof vi.fn>, overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'terminal-tab',
    sessionId: 'session-1',
    workdir: 'C:\\project',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState,
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function renderSplitWorkbench(direction: 'horizontal' | 'vertical' = 'horizontal', active = false) {
  const state = splitTerminalPane(
    createInitialTerminalState(),
    'pane-1',
    direction,
    createPaneState('pane-2'),
  );
  if (!state) throw new Error('split state missing');
  const patchState = vi.fn();
  const ctx = makeContext(patchState);
  const view = render(<TerminalTabBody state={state} ctx={ctx} active={active} />);
  return { ...view, patchState, state, ctx };
}

beforeEach(() => {
  setDataOwnerGeneration('terminal-test-owner');
  actionMocks.confirm.mockReset().mockResolvedValue(false);
  actionMocks.destroy.mockReset().mockResolvedValue(undefined);
  linkMocks.openDirectory.mockClear();
  linkMocks.openFile.mockClear();
  const entries = new Map<string, ReturnType<typeof makeEntry>>();
  xtermMocks.disposeXterm.mockReset();
  xtermMocks.updateXtermTheme.mockReset();
  xtermMocks.getOrCreateXterm.mockReset();
  xtermMocks.getOrCreateXterm.mockImplementation((id: string) => {
    const existing = entries.get(id);
    if (existing) return existing;
    const entry = makeEntry();
    entries.set(id, entry);
    return entry;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      terminal: {
        resolveFile: vi.fn(),
        create: vi.fn(() => new Promise(() => undefined)),
        list: vi.fn(async () => []),
        dispose: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        resize: vi.fn(async () => undefined),
        restart: vi.fn(async () => ({ shellId: 'pwsh', shellDisplayName: 'PowerShell' })),
        write: vi.fn(async () => undefined),
      },
    },
  });
});

describe('persisted shell recovery', () => {
  const result: TerminalCreateResult = { shellId: 'pwsh', shellDisplayName: 'PowerShell',
    profile: 'shell', profileDisplayName: 'PowerShell', pid: 42, exit: null };
  const missing = () => new Error('[TERMINAL_NOT_FOUND] terminal is no longer available');
  function saved() {
    const state = createInitialTerminalState();
    state.cwd = 'C:\\saved-project';
    Object.assign(state.panes['pane-1'], { runtimeStarted: true, terminalId: 'saved-pty', shellId: 'pwsh' });
    return hydrateTerminalState(state);
  }

  it('restores an absent shell once with saved cwd and shell, then reattaches without replay', async () => {
    const state = saved();
    const patch = vi.fn();
    const ctx = makeContext(patch);
    vi.mocked(window.electronAPI.terminal.create).mockRejectedValueOnce(missing()).mockResolvedValue(result);
    const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.terminal.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'saved-pty', sessionId: 'session-1', cwd: state.cwd, profile: 'shell', shellPref: 'pwsh', attachOnly: false,
    }));
    const next = patch.mock.calls.at(-1)![0];
    expect(next.panes['pane-1']).toMatchObject({ created: true, shellPref: 'pwsh', runtimeStarted: true });
    view.rerender(<TerminalTabBody state={next} ctx={ctx} active />);
    expect(screen.queryByText('rightSidebar.terminal.spawnFailed')).toBeNull();
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.restart).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.dispose).not.toHaveBeenCalled();
  });

  it.each(['[PERMISSION_DENIED] wrong owner', 'timeout', 'terminal is no longer available'])(
    'does not infer absence from %s', async message => {
      vi.mocked(window.electronAPI.terminal.create).mockRejectedValue(new Error(message));
      render(<TerminalTabBody state={saved()} ctx={makeContext(vi.fn())} active />);
      await screen.findByText('rightSidebar.terminal.spawnFailed');
      expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['claude', 'codex', 'pi'] as const)('does not automatically relaunch saved %s tasks', async profile => {
    const state = saved(); state.panes['pane-1'].profile = profile;
    vi.mocked(window.electronAPI.terminal.create).mockRejectedValue(missing());
    render(<TerminalTabBody state={state} ctx={makeContext(vi.fn())} active />);
    await screen.findByText('rightSidebar.terminal.spawnFailed');
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
  });

  it('does not restart a saved ended shell after Main has restarted', async () => {
    const raw = saved();raw.panes['pane-1'].exited = { code: 0, signal: null };
    const state = hydrateTerminalState(raw);
    expect(state.panes['pane-1'].exited).toEqual({ code: 0, signal: null });
    vi.mocked(window.electronAPI.terminal.create).mockRejectedValue(missing());
    render(<TerminalTabBody state={state} ctx={makeContext(vi.fn())} active />);
    await act(async () => {});
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rightSidebar.terminal.processExited')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.terminal.spawnFailed')).toBeNull();
  });

  it.each(['unmount', 'hidden', 'task', 'owner', 'remote'])(
    'does not recreate after %s changes while absence is in flight', async change => {
      let reject!: (e: Error) => void;
      vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
      const state = saved(), patch = vi.fn(), ctx = makeContext(patch);
      const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      if (change === 'unmount') view.unmount();
      if (change === 'hidden') view.rerender(<TerminalTabBody state={{ ...state, viewHidden: true }} ctx={ctx} active />);
      if (change === 'task') view.rerender(<TerminalTabBody state={createInitialTerminalState()} ctx={{ ...ctx, sessionId: 'other', tabId: 'other-tab' }} active />);
      if (change === 'owner') setDataOwnerGeneration('another-owner');
      if (change === 'remote') view.rerender(<TerminalTabBody state={state} ctx={{ ...ctx, remoteHostId: 'ssh' }} active />);
      await act(async () => reject(missing()));
      expect(vi.mocked(window.electronAPI.terminal.create).mock.calls.filter(([p]) => p.id === 'saved-pty')).toHaveLength(1);
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it('does not detach a newer view when an old attach finishes late', async () => {
    let finish!: (r: TerminalCreateResult) => void;
    const create = vi.mocked(window.electronAPI.terminal.create);
    create.mockImplementationOnce(() => new Promise(r => { finish = r; })).mockResolvedValue(result);
    const state = saved();
    const old = render(<TerminalTabBody state={state} ctx={makeContext(vi.fn())} active />);
    old.unmount();
    const patch = vi.fn();
    render(<TerminalTabBody state={state} ctx={makeContext(patch)} active />);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    await act(async () => finish(result));
    expect(window.electronAPI.terminal.detach).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('honors hiding immediately, before the parent has persisted the new view', async () => {
    let reject!: (e: Error) => void;
    vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const patch = vi.fn();
    render(<TerminalTabBody state={saved()} ctx={makeContext(patch)} active />);
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.hidePane' }));
    await act(async () => reject(missing()));
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls.at(-1)![0].viewHidden).toBe(true);
  });

  it('keeps a failed replacement visible without retrying it', async () => {
    vi.mocked(window.electronAPI.terminal.create).mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(new Error('[TERMINAL_SPAWN_FAILED] cannot start'));
    render(<TerminalTabBody state={saved()} ctx={makeContext(vi.fn())} active />);
    await screen.findByText('rightSidebar.terminal.spawnFailed');
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(2);
  });

  it('does not recreate if the pane closes while explicit restart is checking Main', async () => {
    const state = saved(); state.panes['pane-1'].exited = { code: 0, signal: null };
    vi.mocked(window.electronAPI.terminal.create).mockRejectedValue(missing());
    let finish!: (rows: []) => void;
    vi.mocked(window.electronAPI.terminal.list).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const patch = vi.fn();
    const view = render(<TerminalTabBody state={state} ctx={makeContext(patch)} active />);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole('button', { name: 'rightSidebar.terminal.restart' })[0]);
    view.unmount();
    await act(async () => finish([]));
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.terminal.restart).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanup();
  document.body.classList.remove('resizing-pane');
  vi.unstubAllGlobals();
});

describe('TerminalTabBody pane dragging', () => {
  it('keeps active pane actions visible and allows hiding the final pane', () => {
    const view = renderSplitWorkbench();
    const actions = document.querySelectorAll('[data-terminal-pane-actions]');
    expect(actions[1].classList.contains('opacity-100')).toBe(true);
    expect(actions[0].classList.contains('opacity-0')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'rightSidebar.terminal.hidePane' })[1]);
    const next = view.patchState.mock.calls.at(-1)![0];
    view.rerender(<TerminalTabBody state={next} ctx={view.ctx} active={false} />);
    expect(screen.getByRole('button', { name: 'rightSidebar.terminal.destroyPane' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.hidePane' }));
    expect(view.patchState.mock.calls.at(-1)![0].viewHidden).toBe(true);
    expect(actionMocks.destroy).not.toHaveBeenCalled();
  });

  it('requires confirmation before destroying a pane', async () => {
    renderSplitWorkbench();
    const button = screen.getAllByRole('button', { name: 'rightSidebar.terminal.destroyPane' })[0];
    await act(async () => { fireEvent.click(button); });
    expect(actionMocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
    expect(actionMocks.destroy).not.toHaveBeenCalled();
    actionMocks.confirm.mockResolvedValueOnce(true);
    await act(async () => { fireEvent.click(button); });
    expect(actionMocks.destroy).toHaveBeenCalledOnce();
  });
  it('hides a pane without deleting its split slot and restores the original two-pane layout', () => {
    const view = renderSplitWorkbench();
    fireEvent.click(screen.getAllByRole('button', { name: 'rightSidebar.terminal.hidePane' })[1]);
    const next = view.patchState.mock.calls.at(-1)![0];
    expect(next.layout).toEqual(view.state.layout);
    expect(next.panes['pane-2'].viewHidden).toBe(true);
    view.rerender(<TerminalTabBody state={next} ctx={view.ctx} active={false} />);
    expect(document.querySelectorAll('[data-terminal-pane-id]')).toHaveLength(1);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(window.electronAPI.terminal.dispose).not.toHaveBeenCalled();
    const restored = { ...next, panes: { ...next.panes, 'pane-2': { ...next.panes['pane-2'], viewHidden: false } } };
    view.rerender(<TerminalTabBody state={restored} ctx={view.ctx} active={false} />);
    expect(document.querySelectorAll('[data-terminal-pane-id]')).toHaveLength(2);
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('offers terminal search and maximize/restore in the pane header context menu', () => {
    renderSplitWorkbench('horizontal', true);
    const header = document.querySelectorAll('[data-terminal-pane-header]')[1];
    fireEvent.contextMenu(header);
    fireEvent.click(screen.getByRole('menuitem', { name: 'rightSidebar.workbench.searchOutput' }));
    expect(screen.getByRole('textbox', { name: 'rightSidebar.workbench.searchOutput' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.closeSearch' }));
    fireEvent.contextMenu(header);
    fireEvent.click(screen.getByRole('menuitem', { name: 'rightSidebar.workbench.zoomPane' }));
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.contextMenu(header);
    fireEvent.click(screen.getByRole('menuitem', { name: 'rightSidebar.workbench.restorePane' }));
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('routes directory links to the file tree and files with line numbers to content tabs', async () => {
    renderSplitWorkbench();
    vi.mocked(window.electronAPI.terminal.resolveFile).mockResolvedValueOnce({ workdir: '/project', path: 'src', kind: 'directory' });
    await act(async () => linkMocks.activate!({ path: './src/' }));
    expect(linkMocks.openDirectory).toHaveBeenCalledExactlyOnceWith('session-1', 'src');
    expect(linkMocks.openFile).not.toHaveBeenCalled();
    vi.mocked(window.electronAPI.terminal.resolveFile).mockResolvedValueOnce({ workdir: '/project', path: 'src/a.ts', kind: 'file' });
    await act(async () => linkMocks.activate!({ path: './src/a.ts', line: 12, column: 3 }));
    expect(linkMocks.openFile).toHaveBeenCalledWith('session-1', expect.objectContaining({ path: 'src/a.ts', reveal: expect.objectContaining({ line: 12, column: 3 }) }));
  });

  it('ignores link resolution that finishes after its pane was unmounted', async () => {
    let resolve!: (value: { workdir: string; path: string; kind: 'directory' }) => void;
    vi.mocked(window.electronAPI.terminal.resolveFile).mockReturnValue(new Promise(done => { resolve = done; }));
    const view = renderSplitWorkbench();
    act(() => linkMocks.activate!({ path: './src/' }));
    view.unmount();
    await act(async () => resolve({ workdir: '/project', path: 'src', kind: 'directory' }));
    expect(linkMocks.openDirectory).not.toHaveBeenCalled();
    expect(linkMocks.openFile).not.toHaveBeenCalled();
  });
  it('retains a late-created PTY when navigation unmounts the view and its bucket is absent', async () => {
    let finish!: (value: TerminalCreateResult) => void;
    vi.mocked(window.electronAPI.terminal.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const state = createInitialTerminalState();
    const view = render(<TerminalTabBody state={state} ctx={makeContext(vi.fn())} active />);
    view.unmount();
    await act(async () => {
      finish({
        shellId: 'bash',
        shellDisplayName: 'Bash',
        pid: 1,
        profile: 'shell',
        profileDisplayName: 'Bash',
        exit: null,
      });
    });
    expect(window.electronAPI.terminal.dispose).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.detach).toHaveBeenCalledWith('terminal-tab:pane-1');
    expect(xtermMocks.disposeXterm).not.toHaveBeenCalled();
  });

  it('keeps the top drag area accessible without an overlaid badge or native tooltip', () => {
    renderSplitWorkbench();
    const handles = screen.getAllByRole('button', { name: 'rightSidebar.terminal.movePane' });
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.textContent).toBe('');
      expect(handle.childElementCount).toBe(0);
      expect(handle.hasAttribute('title')).toBe(false);
      expect(handle.tabIndex).toBe(0);
    }
    expect(
      screen.getAllByRole('button', { name: 'rightSidebar.terminal.splitHorizontal' }),
    ).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'rightSidebar.terminal.hidePane' })).toHaveLength(
      2,
    );
  });

  function setupDrag(active = false) {
    const view = renderSplitWorkbench('horizontal', active);
    const root = view.container.querySelector<HTMLElement>('[data-terminal-workbench]')!;
    const panes = [...view.container.querySelectorAll<HTMLElement>('[data-terminal-pane-id]')];
    const rect = (left: number, width: number) => ({
      left,
      top: 0,
      right: left + width,
      bottom: 500,
      width,
      height: 500,
      x: left,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 1004));
    vi.spyOn(panes[0], 'getBoundingClientRect').mockReturnValue(rect(0, 500));
    vi.spyOn(panes[1], 'getBoundingClientRect').mockReturnValue(rect(504, 500));
    const handle = screen.getAllByRole('button', { name: 'rightSidebar.terminal.movePane' })[0];
    const start = () =>
      fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 12, pointerId: 7 });
    const move = () => fireEvent.pointerMove(window, { clientX: 750, clientY: 480, pointerId: 7 });
    const drop = () => fireEvent.pointerUp(window, { clientX: 750, clientY: 480, pointerId: 7 });
    return { ...view, handle, panes, start, move, drop };
  }

  it('shows the target half while dragging and persists once on release', () => {
    const view = setupDrag();
    act(() => {
      view.start();
      view.move();
    });
    const target = view.container.querySelector<HTMLElement>('[data-terminal-drop-target]')!;
    expect(target.dataset.terminalDropTarget).toBe('pane-2');
    expect(target.dataset.terminalDropZone).toBe('bottom');
    expect(target.style.top).toBe('250px');
    expect(target.style.height).toBe('250px');
    expect(view.patchState).not.toHaveBeenCalled();
    act(view.drop);
    expect(view.patchState).toHaveBeenCalledTimes(1);
    expect(view.patchState.mock.calls[0][0].layout).toMatchObject({
      direction: 'vertical',
      first: { paneId: 'pane-2' },
      second: { paneId: 'pane-1' },
    });
    expect(view.container.querySelector('[data-terminal-drag-overlay]')).toBeNull();
    fireEvent.click(view.handle);
    expect(view.patchState).toHaveBeenCalledTimes(1);
  });

  it('ignores small motions, other pointers, controls and non-primary presses', () => {
    const view = setupDrag();
    act(() => {
      view.start();
      fireEvent.pointerMove(window, { clientX: 103, clientY: 13, pointerId: 7 });
    });
    expect(view.container.querySelector('[data-terminal-drag-overlay]')).toBeNull();
    fireEvent.pointerMove(window, { clientX: 750, clientY: 480, pointerId: 8 });
    expect(view.container.querySelector('[data-terminal-drag-overlay]')).toBeNull();
    act(view.drop);
    expect(view.patchState).not.toHaveBeenCalled();
    for (const extra of [{ button: 2 }, { button: 0, ctrlKey: true }]) {
      fireEvent.pointerDown(view.handle, { ...extra, pointerId: 7, clientX: 100, clientY: 12 });
      act(() => {
        view.move();
        view.drop();
      });
    }
    fireEvent.pointerDown(
      screen.getAllByRole('button', { name: 'rightSidebar.terminal.splitVertical' })[0],
      { button: 0, pointerId: 7 },
    );
    act(() => {
      view.move();
      view.drop();
    });
    expect(view.patchState).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-terminal-drag-overlay]')).toBeNull();
  });

  it.each(['escape', 'blur', 'pointercancel', 'lostpointercapture', 'hidden', 'unmount'])(
    'cancels safely on %s',
    (reason) => {
      const view = setupDrag();
      act(() => {
        view.start();
        view.move();
      });
      expect(view.container.querySelector('[data-terminal-drop-target]')).not.toBeNull();
      act(() => {
        if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
        if (reason === 'blur') fireEvent.blur(window);
        if (reason === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 7 });
        if (reason === 'lostpointercapture')
          fireEvent.lostPointerCapture(view.handle, { pointerId: 7 });
        if (reason === 'hidden') {
          const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
          fireEvent(document, new Event('visibilitychange'));
          visibility.mockRestore();
        }
        if (reason === 'unmount') view.unmount();
        view.drop();
      });
      expect(view.patchState).not.toHaveBeenCalled();
      expect(view.container.querySelector('[data-terminal-drag-overlay]')).toBeNull();
    },
  );

  it('does not swallow the next real button click after a cancelled drag', () => {
    const view = setupDrag();
    act(() => {
      view.start();
      view.move();
      fireEvent.blur(window);
    });
    const close = screen.getAllByRole('button', { name: 'rightSidebar.terminal.hidePane' })[1];
    fireEvent.pointerDown(close, { button: 0, pointerId: 7 });
    fireEvent.click(close);
    expect(view.patchState).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.terminal.detach).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.terminal.dispose).not.toHaveBeenCalled();
    expect(xtermMocks.disposeXterm).not.toHaveBeenCalled();
  });

  it.each(['acquire', 'release'])('cleans up even if pointer capture fails to %s', (stage) => {
    const view = setupDrag();
    const failCapture = () => {
      throw new Error('capture lost');
    };
    Object.assign(view.handle, {
      setPointerCapture: stage === 'acquire' ? failCapture : vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: stage === 'release' ? failCapture : vi.fn(),
    });
    act(() => {
      view.start();
      view.move();
      view.drop();
    });
    expect(view.patchState).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-terminal-drag-overlay]')).toBeNull();
  });

  it('does not use a stale target when released outside the workbench', () => {
    const view = setupDrag();
    act(() => {
      view.start();
      view.move();
    });
    fireEvent.pointerUp(window, { clientX: 1200, clientY: 500, pointerId: 7 });
    expect(view.patchState).not.toHaveBeenCalled();
  });

  it('does not reset a same-position split ratio', () => {
    const view = setupDrag();
    act(() => {
      view.start();
      fireEvent.pointerMove(window, { clientX: 510, clientY: 250, pointerId: 7 });
      fireEvent.pointerUp(window, { clientX: 510, clientY: 250, pointerId: 7 });
    });
    expect(view.patchState).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-terminal-drop-target]')).toBeNull();
  });

  it('keeps pane DOM, xterm subscriptions and pending PTY creation alive across a move', async () => {
    let resolveCreation!: (value: TerminalCreateResult) => void;
    vi.mocked(window.electronAPI.terminal.create).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const view = setupDrag();
    view.rerender(<TerminalTabBody state={view.state} ctx={view.ctx} active={true} />);
    const pendingResolve = resolveCreation;
    const previousPanes = view.panes;
    const subscriptions = vi.mocked(window.electronAPI.terminal.onData).mock.calls.length;
    act(() => {
      view.start();
      view.move();
      view.drop();
    });
    const nextState = view.patchState.mock.calls.at(-1)![0];
    view.rerender(<TerminalTabBody state={nextState} ctx={view.ctx} active={true} />);
    expect(view.container.querySelector('[data-terminal-pane-id="pane-1"]')).toBe(previousPanes[0]);
    expect(view.container.querySelector('[data-terminal-pane-id="pane-2"]')).toBe(previousPanes[1]);
    expect(xtermMocks.getOrCreateXterm).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.terminal.onData).toHaveBeenCalledTimes(subscriptions);
    expect(window.electronAPI.terminal.create).toHaveBeenCalledTimes(2);
    await act(async () => {
      pendingResolve({
        pid: 123,
        profile: 'shell',
        profileDisplayName: 'PowerShell',
        shellId: 'pwsh',
        shellDisplayName: 'PowerShell',
        exit: null,
      });
    });
    expect(window.electronAPI.terminal.dispose).not.toHaveBeenCalled();
    expect(xtermMocks.disposeXterm).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.restart).not.toHaveBeenCalled();
  });
});

describe('TerminalTabBody split resizing', () => {
  it.each([
    ['splitHorizontal', 'columns2', 'horizontal'],
    ['splitVertical', 'rows2', 'vertical'],
  ] as const)('uses a split-layout icon for %s and still creates a new pane', (label, icon, direction) => {
    const state = createInitialTerminalState();
    const patchState = vi.fn();
    render(<TerminalTabBody state={state} ctx={makeContext(patchState)} active={false} />);
    const button = screen.getByRole('button', { name: 'rightSidebar.terminal.' + label });
    expect(button.querySelector('.lucide-' + icon)).toBeTruthy();
    expect(button.querySelector('.lucide-arrow-left-right, .lucide-arrow-up-down')).toBeNull();
    fireEvent.click(button);
    const next = patchState.mock.calls.at(-1)![0];
    expect(next.layout).toMatchObject({ type: 'split', direction, first: { type: 'leaf', paneId: 'pane-1' } });
    expect(Object.keys(next.panes)).toHaveLength(2);
    expect(next.panes['pane-1']).toEqual(state.panes['pane-1']);
  });
  it('uses pane-local split controls and does not render a secondary pane tab bar', () => {
    const { patchState } = renderSplitWorkbench();

    expect(xtermMocks.updateXtermTheme).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /focusPane/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'rightSidebar.terminal.launchAgent' })).toBeNull();
    expect(
      screen.getAllByRole('button', { name: 'rightSidebar.terminal.splitHorizontal' }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole('button', { name: 'rightSidebar.terminal.splitVertical' }),
    ).toHaveLength(2);

    act(() => {
      screen.getAllByRole('button', { name: 'rightSidebar.terminal.splitVertical' })[1]?.click();
    });

    expect(patchState).toHaveBeenCalledTimes(1);
    const persisted = patchState.mock.calls[0]?.[0];
    expect(persisted.layout.type).toBe('split');
    expect(persisted.layout.direction).toBe('horizontal');
    expect(persisted.layout.second.type).toBe('split');
    expect(persisted.layout.second.direction).toBe('vertical');
  });

  it('previews pointer resizing without persistence and commits once on release', () => {
    const { container, patchState } = renderSplitWorkbench();
    const separator = screen.getByRole('separator', {
      name: 'rightSidebar.terminal.resizePanes',
    });
    const branch = separator.closest('[data-terminal-split-path="root"]');
    if (!(branch instanceof HTMLElement)) throw new Error('root split missing');
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1004,
      top: 0,
      bottom: 500,
      width: 1004,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const [first, , second] = Array.from(branch.children) as HTMLElement[];

    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: 700, pointerId: 1 });
    });

    expect(document.body.classList.contains('resizing-pane')).toBe(true);
    expect(Number(first.style.flexGrow)).toBeCloseTo(0.7, 5);
    expect(Number(second.style.flexGrow)).toBeCloseTo(0.3, 5);
    expect(separator.getAttribute('aria-valuenow')).toBe('70');
    expect(patchState).not.toHaveBeenCalled();

    act(() => fireEvent.pointerUp(document, { pointerId: 1 }));

    expect(document.body.classList.contains('resizing-pane')).toBe(false);
    expect(patchState).toHaveBeenCalledTimes(1);
    const persisted = patchState.mock.calls[0]?.[0];
    expect(persisted.layout.ratio).toBeCloseTo(0.7, 5);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('supports directional arrows and Home/End with bounded ARIA values', () => {
    const { patchState } = renderSplitWorkbench();
    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuemin')).toBe('20');
    expect(separator.getAttribute('aria-valuemax')).toBe('80');

    act(() => fireEvent.keyDown(separator, { key: 'ArrowRight' }));
    expect(separator.getAttribute('aria-valuenow')).toBe('55');
    act(() => fireEvent.keyDown(separator, { key: 'ArrowUp' }));
    expect(patchState).toHaveBeenCalledTimes(1);
    act(() => fireEvent.keyDown(separator, { key: 'Home' }));
    expect(separator.getAttribute('aria-valuenow')).toBe('20');
    act(() => fireEvent.keyDown(separator, { key: 'End' }));
    expect(separator.getAttribute('aria-valuenow')).toBe('80');
    expect(patchState).toHaveBeenCalledTimes(3);
  });

  it('maps a top-and-bottom split to vertical pointer movement and horizontal ARIA', () => {
    const { patchState } = renderSplitWorkbench('vertical');
    const separator = screen.getByRole('separator');
    const branch = separator.closest('[data-terminal-split-path="root"]');
    if (!(branch instanceof HTMLElement)) throw new Error('root split missing');
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 500,
      top: 0,
      bottom: 504,
      width: 500,
      height: 504,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientY: 250, pointerId: 1 });
      fireEvent.pointerMove(document, { clientY: 350, pointerId: 1 });
      fireEvent.pointerUp(document, { pointerId: 1 });
    });

    const persisted = patchState.mock.calls[0]?.[0];
    expect(persisted.layout.ratio).toBeCloseTo(0.7, 5);
  });

  it('commits at most once when the window loses focus during a drag', () => {
    const { patchState } = renderSplitWorkbench();
    const separator = screen.getByRole('separator');
    const branch = separator.closest('[data-terminal-split-path="root"]');
    if (!(branch instanceof HTMLElement)) throw new Error('root split missing');
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1004,
      top: 0,
      bottom: 500,
      width: 1004,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
      fireEvent.blur(window);
      fireEvent.pointerUp(document, { pointerId: 1 });
      fireEvent.blur(window);
    });

    expect(document.body.classList.contains('resizing-pane')).toBe(false);
    expect(patchState).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-progress preview without persistence when the split unmounts', () => {
    const view = renderSplitWorkbench();
    const separator = screen.getByRole('separator');
    const branch = separator.closest('[data-terminal-split-path="root"]');
    if (!(branch instanceof HTMLElement)) throw new Error('root split missing');
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1004,
      top: 0,
      bottom: 500,
      width: 1004,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(document, { clientX: 600, pointerId: 1 });
    });
    expect(document.body.classList.contains('resizing-pane')).toBe(true);

    view.unmount();

    expect(document.body.classList.contains('resizing-pane')).toBe(false);
    expect(view.patchState).not.toHaveBeenCalled();
  });
});

describe('TerminalTabBody remote ownership', () => {
  it('continues to create a PTY for a confirmed local session', async () => {
    render(
      <TerminalTabBody
        state={createInitialTerminalState()}
        ctx={makeContext(vi.fn())}
        active
      />,
    );

    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: 'C:\\project' }),
    ));
  });

  it('creates the local PTY after device-link ownership resolves from unknown to local', async () => {
    const unresolvedContext = makeContext(vi.fn(), { deviceLinkDeviceId: undefined });
    const state = createInitialTerminalState();
    const view = render(<TerminalTabBody state={state} ctx={unresolvedContext} active />);

    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();

    view.rerender(
      <TerminalTabBody
        state={state}
        ctx={{ ...unresolvedContext, deviceLinkDeviceId: null }}
        active
      />,
    );

    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: 'C:\\project' }),
    ));
    expect(screen.queryByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeNull();
  });

  it.each([
    ['an SSH session', { remoteHostId: 'ssh-host-1', deviceLinkDeviceId: null }],
    ['a device-link session', { remoteHostId: null, deviceLinkDeviceId: 'device-1' }],
    ['unresolved device-link ownership', { remoteHostId: null, deviceLinkDeviceId: undefined }],
  ])('fails closed for %s without creating a local PTY', (_label, ownership) => {
    const ctx = makeContext(vi.fn(), ownership);
    render(
      <TerminalTabBody
        state={createInitialTerminalState()}
        ctx={ctx}
        active
      />,
    );

    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeTruthy();
    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableDescription')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
    expect(xtermMocks.getOrCreateXterm).not.toHaveBeenCalled();
  });
});

describe('destroy confirmation and attachment admission', () => {
  const result: TerminalCreateResult = { shellId: 'pwsh', shellDisplayName: 'PowerShell',
    profile: 'shell', profileDisplayName: 'PowerShell', pid: 42, exit: null };
  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function fixture() {
    const raw = splitTerminalPane(createInitialTerminalState(), 'pane-1', 'horizontal', createPaneState('pane-2'))!;
    for (const pane of Object.values(raw.panes)) Object.assign(pane, { terminalId: `saved-${pane.id}`, runtimeStarted: true, shellId: 'pwsh', shellPref: 'pwsh' });
    raw.activePaneId = 'pane-1';
    const initial = hydrateTerminalState(raw);
    const attach = deferred<TerminalCreateResult>(), confirm = deferred<boolean>();
    actionMocks.confirm.mockReturnValue(confirm.promise);
    const create = vi.mocked(window.electronAPI.terminal.create);
    create.mockImplementationOnce(() => attach.promise).mockResolvedValue(result);
    let publish!: (state: typeof initial) => void;
    let replaceContext!: (context: TabKindHostContext) => void;
    const patch = vi.fn((next: typeof initial) => publish(next));
    const ctx = makeContext(patch);
    function Host() {
      const [state, setState] = useState(initial); publish = setState;
      const [context, setContext] = useState(ctx); replaceContext = setContext;
      return <TerminalTabBody state={state} ctx={context} active />;
    }
    const view = render(<Host />);
    const open = (id: string) => fireEvent.click(view.container.querySelector(`[data-terminal-pane-id="${id}"] [aria-label="rightSidebar.terminal.destroyPane"]`)!);
    return { ...view, attach, confirm, create, patch, ctx, initial, publish: (state: typeof initial) => publish(state), replaceContext: (context: TabKindHostContext) => replaceContext(context), open };
  }
  it.each([
    ['pane-1', 'missing'], ['pane-1', 'live'], ['pane-2', 'missing'], ['pane-2', 'live'],
  ])('keeps %s cancellation independent from a pending %s attach', async (target, completion) => {
    const f = fixture(); await act(async () => {}); f.open(target);
    await act(async () => {
      if (completion === 'missing') f.attach.reject(new Error('[TERMINAL_NOT_FOUND] terminal is no longer available'));
      else f.attach.resolve(result);
    });
    await act(async () => f.confirm.resolve(false));
    expect(f.patch.mock.calls.at(-1)![0].panes['pane-1'].created).toBe(true);
    expect(f.create.mock.calls.filter(([p]) => p.id === 'saved-pane-1')).toHaveLength(completion === 'missing' ? 2 : 1);
    expect(window.electronAPI.terminal.detach).not.toHaveBeenCalled();
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
    expect(actionMocks.destroy).not.toHaveBeenCalled();
    expect(screen.queryByText('rightSidebar.terminal.spawnFailed')).toBeNull();
  });
  it.each([['pane-1', 'missing'], ['pane-1', 'live'], ['pane-2', 'missing'], ['pane-2', 'live']])('fences only confirmed %s, including a late %s reply', async (target, completion) => {
    const f = fixture(), destroying = deferred<void>();
    actionMocks.destroy.mockReturnValue(destroying.promise);
    await act(async () => {}); f.open(target);
    await act(async () => f.confirm.resolve(true));
    await act(async () => {
      if (completion === 'missing') f.attach.reject(new Error('[TERMINAL_NOT_FOUND] terminal is no longer available'));
      else f.attach.resolve(result);
    });
    expect(actionMocks.destroy).toHaveBeenCalledExactlyOnceWith('session-1', `saved-${target}`);
    expect(f.create.mock.calls.filter(([p]) => p.id === 'saved-pane-1')).toHaveLength(target !== 'pane-1' && completion === 'missing' ? 2 : 1);
    expect(f.patch.mock.calls.some(([s]) => s.panes['pane-1'].created)).toBe(target !== 'pane-1');
    await act(async () => destroying.resolve());
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
  });
  it.each(['owner', 'hidden', 'identity', 'task', 'tab', 'unmount'])('does not apply a confirmation after %s changed', async boundary => {
    const f = fixture(); await act(async () => {}); f.open('pane-1');
    if (boundary === 'owner') setDataOwnerGeneration('new-owner');
    if (boundary === 'unmount') f.unmount();
    if (boundary === 'hidden') await act(async () => f.publish({ ...f.initial, viewHidden: true }));
    if (boundary === 'identity') await act(async () => f.publish({ ...f.initial, panes: { ...f.initial.panes, 'pane-1': { ...f.initial.panes['pane-1'], terminalId: 'replacement' } } }));
    if (boundary === 'task') await act(async () => f.replaceContext({ ...f.ctx, sessionId: 'other-task' }));
    if (boundary === 'tab') await act(async () => f.replaceContext({ ...f.ctx, tabId: 'other-tab' }));
    await act(async () => f.confirm.resolve(true));
    expect(actionMocks.destroy).not.toHaveBeenCalled();
    await act(async () => f.attach.resolve(result));
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
  });
  it('shows a failed confirmed destroy without replaying its invalidated attach', async () => {
    const f = fixture(), destroying = deferred<void>(); actionMocks.destroy.mockReturnValue(destroying.promise);
    await act(async () => {}); f.open('pane-1'); await act(async () => f.confirm.resolve(true));
    await act(async () => f.attach.resolve(result));
    await act(async () => destroying.reject(new Error('destroy result unknown')));
    expect(screen.getByText('rightSidebar.terminal.actionFailed')).toBeTruthy();
    expect(f.create.mock.calls.filter(([p]) => p.id === 'saved-pane-1')).toHaveLength(1);
    expect(f.patch.mock.calls.some(([s]) => s.panes['pane-1'].created)).toBe(false);
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
    // An explicit retry remains usable, after a fresh authoritative list.
    fireEvent.click(screen.getByText('rightSidebar.terminal.restart'));
    await act(async () => {});
    expect(window.electronAPI.terminal.list).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(f.create.mock.calls.filter(([p]) => p.id === 'saved-pane-1')).toHaveLength(2);
    expect(f.patch.mock.calls.at(-1)![0].panes['pane-1'].created).toBe(true);
    expect(screen.queryByText('rightSidebar.terminal.actionFailed')).toBeNull();
    expect(window.electronAPI.terminal.write).not.toHaveBeenCalled();
  });
});
