// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import type { TerminalCreateResult } from '../../../../../../shared/terminal-bridge';
import { createInitialTerminalState, createPaneState, splitTerminalPane } from '../terminal-layout';

const xtermMocks = vi.hoisted(() => ({
  disposeXterm: vi.fn(),
  getOrCreateXterm: vi.fn(),
  updateXtermTheme: vi.fn(),
}));
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

function makeContext(patchState: ReturnType<typeof vi.fn>): TabKindHostContext {
  return {
    tabId: 'terminal-tab',
    sessionId: 'session-1',
    workdir: 'C:\\project',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState,
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
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

afterEach(() => {
  cleanup();
  document.body.classList.remove('resizing-pane');
  vi.unstubAllGlobals();
});

describe('TerminalTabBody pane dragging', () => {
  it('hides a pane without deleting its split slot and restores the original two-pane layout', () => {
    const view = renderSplitWorkbench();
    fireEvent.click(screen.getAllByRole('button', { name: 'rightSidebar.terminal.closePane' })[1]);
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
    expect(screen.getAllByRole('button', { name: 'rightSidebar.terminal.closePane' })).toHaveLength(
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
    const close = screen.getAllByRole('button', { name: 'rightSidebar.terminal.closePane' })[1];
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
