// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import { createInitialTerminalState, createPaneState, splitTerminalPane } from '../terminal-layout';

const xtermMocks = vi.hoisted(() => ({
  disposeXterm: vi.fn(),
  getOrCreateXterm: vi.fn(),
}));

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

function renderSplitWorkbench(direction: 'horizontal' | 'vertical' = 'horizontal') {
  const state = splitTerminalPane(
    createInitialTerminalState(),
    'pane-1',
    direction,
    createPaneState('pane-2'),
  );
  if (!state) throw new Error('split state missing');
  const patchState = vi.fn();
  const view = render(
    <TerminalTabBody state={state} ctx={makeContext(patchState)} active={false} />,
  );
  return { ...view, patchState };
}

beforeEach(() => {
  const entries = new Map<string, ReturnType<typeof makeEntry>>();
  xtermMocks.disposeXterm.mockReset();
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
        create: vi.fn(() => new Promise(() => undefined)),
        dispose: vi.fn(async () => undefined),
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

describe('TerminalTabBody split resizing', () => {
  it('previews pointer resizing without persistence and commits once on release', () => {
    const { container, patchState } = renderSplitWorkbench();
    const separator = screen.getByRole('separator', {
      name: 'rightSidebar.terminal.resizePanes',
    });
    const branch = separator.closest('[data-terminal-split-path="root"]');
    if (!(branch instanceof HTMLElement)) throw new Error('root split missing');
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1006,
      top: 0,
      bottom: 500,
      width: 1006,
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
      bottom: 506,
      width: 500,
      height: 506,
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
      right: 1006,
      top: 0,
      bottom: 500,
      width: 1006,
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
      right: 1006,
      top: 0,
      bottom: 500,
      width: 1006,
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
