// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNativeTerminal } from '../AgentNativeTerminal';
import { useDisableTab } from '@/hooks/useDisableTab';
import { FindInPageBar } from '@/components/find-in-page/FindInPageBar';
import { getAppShortcutCombos } from '@/lib/appShortcutStore';
import type { AppShortcutOverrides } from '../../../../shared/appShortcuts';
import type { AgentTerminalReplay } from '../../../../shared/agentPresentation';

const mock = vi.hoisted(() => ({ terminals: [] as any[], themes: new Set<() => void>(), searches: [] as any[],
  shortcutsChanged: undefined as undefined | ((payload: { overrides: AppShortcutOverrides }) => void),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/themes/theme-service', () => ({ themeService: { onDidChangeTheme: (fn: () => void) => { mock.themes.add(fn); return () => mock.themes.delete(fn); } } }));
vi.mock('../../right-sidebar/plugins/terminal/lib/xtermPool', () => ({ getTerminalTheme: () => ({}), openTerminalExternalLink: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  constructor() { mock.searches.push(this); }
  findPrevious = vi.fn(); findNext = vi.fn(); clearDecorations = vi.fn();
} }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: any; cols = 80; rows = 24; input?: (data: string) => void;
  parser = { registerCsiHandler: () => ({ dispose() {} }), registerOscHandler: () => ({ dispose() {} }), registerDcsHandler: () => ({ dispose() {} }) };
  constructor(options: any) { this.options = options; mock.terminals.push(this); }
  textarea?: HTMLTextAreaElement;
  loadAddon() {} open(host: HTMLElement) { this.textarea = document.createElement('textarea'); this.textarea.className = 'xterm-helper-textarea'; this.textarea.setAttribute('aria-label', 'Native input'); host.append(this.textarea); }
  focus = vi.fn(() => this.textarea?.focus()); reset = vi.fn(); dispose = vi.fn();
  resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
  write = vi.fn((_text: string, callback: () => void) => callback());
  onData(fn: (data: string) => void) { this.input = fn; return { dispose() {} }; }
  key?: (event: KeyboardEvent) => boolean;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.key = handler; } hasSelection() { return false; }
} }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const lease = { generation: 'runtime', lease: 'lease' };
function replay(overrides: Partial<AgentTerminalReplay> = {}): AgentTerminalReplay {
  return { state: { generation: 'runtime', nativeSessionId: 'native', status: 'running', controller: null, cols: 80, rows: 24, sequence: 0 }, frames: [], gap: false, controlling: true, ...overrides };
}
function fixture() {
  const read = deferred<AgentTerminalReplay>();
  const invoke = vi.fn(async (request: any): Promise<unknown> => {
    if (request.action === 'attach') return { attachmentId: 'view', replay: replay() };
    if (request.action === 'control') return lease;
    if (request.action === 'read') return read.promise;
  });
  return { invoke, read };
}
beforeEach(() => {
  mock.terminals.length = 0; mock.searches.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  // Only the preload transport is fake; the shortcut store/matcher stays real.
  vi.stubGlobal('electronAPI', { appShortcuts: {
    getState: () => ({ platform: 'win32', overrides: {} }),
    onChanged: (listener: typeof mock.shortcutsChanged) => { mock.shortcutsChanged = listener; return () => {}; },
  } });
  getAppShortcutCombos('find-in-page');
  mock.shortcutsChanged?.({ overrides: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function AppFindGate() { useDisableTab(); return <FindInPageBar />; }

describe.each(['ctrlKey', 'metaKey'] as const)('find ownership with %s+F', modifier => {
  beforeEach(() => mock.shortcutsChanged?.({ overrides: { 'find-in-page': {
    code: 'KeyF', ctrl: modifier === 'ctrlKey', meta: modifier === 'metaKey', alt: false, shift: false,
  } } }));
  const find = (target: Element) => fireEvent.keyDown(target, { key: 'f', code: 'KeyF', [modifier]: true });
  it.each(['blur', 'settled blur', 'removed dismiss', 'outside input', 'hidden', 'unmount'])('returns find to the App after %s', async reason => {
    const f = fixture();
    const app = (active: boolean, mounted = true) => <><AppFindGate /><input aria-label="Other panel" />
      {mounted && <AgentNativeTerminal sessionId="task" active={active} invoke={f.invoke} />}</>;
    const ui = render(app(true));
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    const terminal = mock.terminals[0], native = screen.getByLabelText('Native input');
    native.focus();
    if (reason.includes('blur')) {
      native.blur();
      if (reason === 'settled blur') await act(async () => {});
    } else if (reason === 'removed dismiss') {
      act(() => terminal.input('x'.repeat(1_048_577)));
      const dismiss = screen.getByRole('button', { name: 'common.dismiss' });
      dismiss.focus(); fireEvent.click(dismiss);
      expect(dismiss.isConnected).toBe(false);
    } else if (reason === 'outside input') screen.getByLabelText('Other panel').focus();
    else if (reason === 'hidden') ui.rerender(app(false));
    else ui.rerender(app(true, false));
    if (reason !== 'outside input' && reason !== 'hidden') expect(document.activeElement).toBe(document.body);
    terminal.focus.mockClear();
    expect(find(document.activeElement!)).toBe(false);
    const globalSearch = screen.getByRole('searchbox');
    await waitFor(() => expect(document.activeElement).toBe(globalSearch));
    expect(screen.queryByRole('textbox', { name: 'ccAgent.presentation.search' })).toBeNull();
    fireEvent.keyDown(globalSearch, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toEqual([]);
  });

  it('lets only the focused terminal search and returns focus locally on Escape', async () => {
    const first = fixture(), second = fixture();
    render(<><AppFindGate /><input aria-label="Other panel" />
      <section aria-label="First terminal"><AgentNativeTerminal sessionId="first" active invoke={first.invoke} /></section>
      <section aria-label="Second terminal"><AgentNativeTerminal sessionId="second" active invoke={second.invoke} /></section></>);
    await waitFor(() => expect(mock.terminals.every(t => !t.options.disableStdin)).toBe(true));
    for (const [index, label] of ['First terminal', 'Second terminal', 'First terminal'].entries()) {
      const pane = within(screen.getByRole('region', { name: label }));
      const terminal = mock.terminals[index % 2], other = mock.terminals[(index + 1) % 2];
      const native = pane.getByLabelText('Native input'); native.focus();
      terminal.focus.mockClear(); other.focus.mockClear();
      expect(find(native)).toBe(false);
      expect(screen.queryByRole('searchbox')).toBeNull();
      expect(screen.getAllByRole('textbox', { name: 'ccAgent.presentation.search' })).toHaveLength(1);
      const search = pane.getByRole('textbox', { name: 'ccAgent.presentation.search' });
      expect(document.activeElement).toBe(search);
      expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true);
      expect(fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })).toBe(true);
      fireEvent.keyDown(search, { key: 'Escape', isComposing: true });
      expect(document.activeElement).toBe(search);
      fireEvent.keyDown(search, { key: 'Escape' });
      expect(screen.queryByRole('textbox', { name: 'ccAgent.presentation.search' })).toBeNull();
      expect(document.activeElement).toBe(native);
      expect(terminal.focus).toHaveBeenCalledOnce();
      expect(other.focus).not.toHaveBeenCalled();
    }
    for (const f of [first, second]) {
      expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write' || r.action === 'detach' || r.action === 'release')).toEqual([]);
      expect(f.invoke.mock.calls.filter(([r]) => r.action === 'control')).toHaveLength(1);
    }
    screen.getByLabelText('Other panel').focus();
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(false);
  });
});

describe('native task view', () => {
  it('claims the real App find shortcut only while focus is in the active terminal', async () => {
    const f = fixture();
    const ui = render(<><FindInPageBar /><input aria-label="Other panel" /><AgentNativeTerminal sessionId="task" active invoke={f.invoke} /></>);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    screen.getByLabelText('Native input').focus();
    fireEvent.keyDown(screen.getByLabelText('Native input'), { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'ccAgent.presentation.search' })).toBe(document.activeElement);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    screen.getByLabelText('Other panel').focus();
    fireEvent.keyDown(screen.getByLabelText('Other panel'), { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(screen.getByRole('searchbox')).toBeTruthy();
    ui.unmount();
  });
  it('bounds queued event overhead without dropping earlier accepted keystrokes', async () => {
    const f = fixture(), first = deferred<void>(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(r => r.action === 'write' && r.sequence === 1 ? first.promise : original(r));
    render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => { for (let i = 0; i < 256; i++) mock.terminals[0].input('x'); mock.terminals[0].input('rejected'); });
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => first.resolve());
    await waitFor(() => expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(256));
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write').map(([r]) => r.data).join('')).toBe('x'.repeat(256));
    expect(mock.terminals[0].options.disableStdin).toBe(false);
  });

  it.each(['hidden', 'observer'])('closing search in a %s view does not take focus or control', async mode => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    if (mode === 'observer') f.invoke.mockImplementation(r => r.action === 'control' ? Promise.resolve(null) : original(r));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await screen.findByText('ccAgent.presentation.' + (mode === 'observer' ? 'viewing' : 'controlling'));
    fireEvent.click(screen.getByLabelText('ccAgent.presentation.search'));
    if (mode === 'hidden') ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    mock.terminals[0].focus.mockClear();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'ccAgent.presentation.search' }), { key: 'Escape' });
    await act(async () => {});
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'control').every(([r]) => !r.takeOver)).toBe(true);
  });

  it('does not steal focus moved during the initial attach', async () => {
    const f = fixture(), attached = deferred<unknown>(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(r => r.action === 'attach' ? attached.promise : original(r));
    render(<><input aria-label="Other panel" /><AgentNativeTerminal sessionId="task" active invoke={f.invoke} /></>);
    screen.getByLabelText('Other panel').focus();
    await act(async () => attached.resolve({ attachmentId: 'view', replay: replay() }));
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(65536), 'a'.repeat(65537), '汉'.repeat(21846), '😀'.repeat(16385), '\uFEFF' + 'a'.repeat(65533) + '\uFEFFtail'])('sends a bounded paste in UTF-8 safe ordered packets (%#)', async text => {
    const f = fixture();
    render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => mock.terminals[0].input(text));
    await waitFor(() => expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write').map(([r]) => r.data).join('')).toBe(text));
    const writes = f.invoke.mock.calls.filter(([r]) => r.action === 'write').map(([r]) => r);
    expect(writes.every(r => new TextEncoder().encode(r.data).length <= 65536)).toBe(true);
    expect(writes.map(r => r.sequence)).toEqual(writes.map((_, i) => i + 1));
    expect(mock.terminals[0].options.disableStdin).toBe(false);
  });

  it('rejects only a new over-budget paste, preserving accepted input and the healthy lease', async () => {
    const f = fixture(), first = deferred<void>(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(r => r.action === 'write' && r.sequence === 1 ? first.promise : original(r));
    render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    const accepted = 'a'.repeat(1_048_576);
    act(() => mock.terminals[0].input(accepted));
    await waitFor(() => expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1));
    act(() => mock.terminals[0].input('rejected'));
    expect(screen.getByRole('alert').textContent).toContain('ccAgent.presentation.inputRejected');
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'release')).toHaveLength(0);
    expect(mock.terminals[0].options.disableStdin).toBe(false);
    await act(async () => first.resolve());
    await waitFor(() => expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(16));
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write').map(([r]) => r.data).join('')).toBe(accepted);
    act(() => mock.terminals[0].input('next'));
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write', sequence: 17, data: 'next' })));
  });

  it.each(['revoked', 'owner changed', 'failed'])('does not dispatch the rest of a split paste after %s', async reason => {
    const f = fixture(), first = deferred<void>(), original = f.invoke.getMockImplementation()!;
    let reject!: (error: Error) => void;
    const failure = new Promise<void>((_, r) => { reject = r; });
    f.invoke.mockImplementation(r => r.action === 'write' ? reason === 'failed' ? failure : first.promise : original(r));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => mock.terminals[0].input('汉'.repeat(21846)));
    await waitFor(() => expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1));
    if (reason === 'revoked') await act(async () => f.read.resolve(replay({ controlling: false, state: { ...replay().state, status: 'exited' } })));
    if (reason === 'owner changed') ui.unmount();
    await act(async () => reason === 'failed' ? reject(new Error('unknown receipt')) : first.resolve());
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1);
  });

  it('reacquires once after GUI/TUI switches invalidate an unfinished control request', async () => {
    const f = fixture(), firstControl = deferred<unknown>(), staleRelease = deferred<void>();
    const original = f.invoke.getMockImplementation()!;
    let acquisitions = 0;
    f.invoke.mockImplementation(request => request.action === 'release' ? staleRelease.promise
      : request.action === 'control' && ++acquisitions === 1 ? firstControl.promise : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(acquisitions).toBe(1));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    ui.rerender(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await act(async () => { firstControl.resolve({ generation: 'runtime', lease: 'stale-lease' }); });
    expect(acquisitions).toBe(1);
    expect(mock.terminals[0].options.disableStdin).toBe(true);
    await act(async () => { staleRelease.resolve(); });
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    expect(acquisitions).toBe(2);
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'release', control: { generation: 'runtime', lease: 'stale-lease' } }));
    act(() => mock.terminals[0].input('new draft'));
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write', control: lease, data: 'new draft' })));
  });

  it.each(['search', 'another panel'])('does not steal %s focus when a control request finishes late', async target => {
    const f = fixture(), control = deferred<unknown>(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(request => request.action === 'control' ? control.promise : original(request));
    render(<><input aria-label="Other panel" /><AgentNativeTerminal sessionId="task" active invoke={f.invoke} /></>);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'control' })));
    if (target === 'search') fireEvent.click(screen.getByLabelText('ccAgent.presentation.search'));
    const input = screen.getByRole('textbox', { name: target === 'search' ? 'ccAgent.presentation.search' : 'Other panel' });
    input.focus();
    expect(document.activeElement).toBe(input);
    await act(async () => { control.resolve(lease); });
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it('stays an observer if another window owns the replacement lease after a fast switch', async () => {
    const f = fixture(), first = deferred<unknown>(), original = f.invoke.getMockImplementation()!;
    let acquisitions = 0;
    f.invoke.mockImplementation(request => request.action === 'control'
      ? ++acquisitions === 1 ? first.promise : Promise.resolve(null) : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(acquisitions).toBe(1));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    ui.rerender(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await act(async () => { first.resolve(lease); });
    await screen.findByText('ccAgent.presentation.viewing');
    expect(acquisitions).toBe(2);
    expect(mock.terminals[0].options.disableStdin).toBe(true);
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'control').every(([r]) => r.takeOver === false)).toBe(true);
    act(() => mock.terminals[0].input('observer text'));
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toEqual([]);
  });

  it('restores the query highlight on reopen and allows Tab across search controls', async () => {
    const f = fixture(), parentKeyDown = vi.fn();
    function AppGate() { useDisableTab(); return <div onKeyDown={parentKeyDown}><input aria-label="outside" /><AgentNativeTerminal sessionId="task" active invoke={f.invoke} /></div>; }
    render(<AppGate />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    expect(fireEvent.keyDown(screen.getByLabelText('outside'), { key: 'Tab' })).toBe(false);
    fireEvent.click(screen.getByLabelText('ccAgent.presentation.search'));
    fireEvent.change(screen.getByRole('textbox', { name: 'ccAgent.presentation.search' }), { target: { value: 'saved query' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'ccAgent.presentation.search' }), { key: 'Escape' });
    mock.searches[0].findNext.mockClear();
    fireEvent.click(screen.getByLabelText('ccAgent.presentation.search'));
    const searchInput = screen.getByRole('textbox', { name: 'ccAgent.presentation.search' });
    expect((searchInput as HTMLInputElement).value).toBe('saved query');
    expect(mock.searches[0].findNext).toHaveBeenCalledWith('saved query');
    parentKeyDown.mockClear();
    const next = screen.getByRole('button', { name: 'ccAgent.presentation.nextMatch' });
    expect(fireEvent.keyDown(next, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(searchInput, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(parentKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });
    expect(mock.searches[0].findPrevious).toHaveBeenLastCalledWith('saved query');
    parentKeyDown.mockClear();
    mock.terminals[0].focus.mockClear();
    fireEvent.keyDown(next, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'ccAgent.presentation.search' })).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(mock.terminals[0].focus).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toEqual([]);
  });

  it('batches adjacent output without losing text, resize order or the authoritative cursor', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    const frames = Array.from({ length: 1000 }, (_, index) => ({ sequence: index + 1, data: 'row-' + index + '\r\n' }));
    f.invoke.mockImplementation(request => request.action === 'attach'
      ? Promise.resolve({ attachmentId: 'view', replay: replay({ frames }) }) : original(request));
    render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'read', afterSequence: 1000 })));
    expect(mock.terminals[0].write.mock.calls.map((args: any[]) => args[0]).join('')).toBe(frames.map(frame => frame.data).join(''));
    expect(mock.terminals[0].write).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls.filter(([request]) => request.action === 'write')).toEqual([]);
  });

  it('keeps search and font changes local and does not consume IME composition keys', async () => {
    const f = fixture(), parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><AgentNativeTerminal sessionId="task" active invoke={f.invoke} /></div>);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    const terminal = mock.terminals[0];
    const composition = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true });
    expect(terminal.key(composition)).toBe(true);
    fireEvent.click(screen.getByLabelText('ccAgent.presentation.search'));
    const search = screen.getByRole('textbox', { name: 'ccAgent.presentation.search' });
    fireEvent.change(search, { target: { value: '中文' } });
    expect(mock.searches[0].findNext).toHaveBeenLastCalledWith('中文');
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(mock.searches[0].findNext).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText('ccAgent.presentation.largerFont'));
    expect(terminal.options.fontSize).toBe(14);
    fireEvent.click(screen.getByLabelText('ccAgent.presentation.smallerFont'));
    expect(terminal.options.fontSize).toBe(13);
    parentKeyDown.mockClear();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'ccAgent.presentation.search' })).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.filter(([request]) => request.action === 'write')).toEqual([]);
  });

  it('stops remaining replay frames when disposed during an asynchronous batch before resize', async () => {
    const f = fixture(), attached = deferred<unknown>();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(request => request.action === 'attach' ? attached.promise : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    const terminal = mock.terminals[0];
    terminal.write.mockImplementation(() => {}); // xterm parsing callback is still pending at unmount.
    await act(async () => { attached.resolve({ attachmentId: 'view', replay: replay({ frames: [
      { sequence: 1, data: 'before-resize' },
      { sequence: 2, data: 'after-resize', size: { cols: 100, rows: 30 } },
    ] }) }); });
    expect(terminal.write).toHaveBeenCalledOnce();
    await act(async () => { ui.unmount(); });
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.resize).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'detach' }));
  });

  it('throttles only hidden presentation reads and wakes immediately on reveal', async () => {
    const f = fixture();
    const ui = render(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'attach' })));
    expect(f.invoke.mock.calls.filter(([request]) => request.action === 'control')).toEqual([]);
    expect(f.invoke.mock.calls.filter(([request]) => request.action === 'read')).toEqual([]);
    ui.rerender(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'read' })));
    expect(mock.terminals).toHaveLength(1);
  });
  it('keeps the same terminal mounted while changing presentation, without launching a task', async () => {
    const f = fixture(); const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    const terminal = mock.terminals[0];
    act(() => terminal.input('draft'));
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write', data: 'draft', sequence: 1 })));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    expect(terminal.options.disableStdin).toBe(true);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'release' })));
    expect(terminal.dispose).not.toHaveBeenCalled(); expect(mock.terminals).toHaveLength(1);
    ui.unmount(); expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenCalledWith({ action: 'detach', attachmentId: 'view', sessionId: 'task' });
  });

  it('releases a late lease if the user switches back to GUI during acquisition', async () => {
    const f = fixture(), acquire = deferred<unknown>();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((request) => request.action === 'control' ? acquire.promise : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'control' })));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    await act(async () => { acquire.resolve(lease); });
    expect(mock.terminals[0].options.disableStdin).toBe(true);
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'release', control: lease }));
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
  });

  it('does not replay an uncertain write or continue queued input', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((request) => request.action === 'write' ? Promise.reject(new Error('link lost')) : original(request));
    render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => { mock.terminals[0].input('one'); mock.terminals[0].input('two'); });
    await screen.findByText('ccAgent.presentation.unavailable');
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1);
    expect(mock.terminals[0].options.disableStdin).toBe(true);
  });

  it('finishes accepted text and Enter exactly once before releasing a hidden terminal', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    const firstWrite = deferred<void>();
    f.invoke.mockImplementation(request => request.action === 'write' && request.sequence === 1
      ? firstWrite.promise : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    const terminal = mock.terminals[0];
    const text = '😀'.repeat(16385);
    act(() => { terminal.input(text); terminal.input('\r'); });
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write', sequence: 1 })));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    expect(terminal.options.disableStdin).toBe(true);
    act(() => terminal.input('hidden input'));
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'release')).toHaveLength(0);
    await act(async () => { firstWrite.resolve(); });
    const calls = f.invoke.mock.calls.map(([request]) => request);
    expect(calls.filter(r => r.action === 'write').map(r => [r.sequence, r.data])).toEqual([[1, text.slice(0, 32768)], [2, text.slice(32768)], [3, '\r']]);
    expect(calls.filter(r => r.action === 'release')).toHaveLength(1);
    expect(calls.findIndex(r => r.action === 'release')).toBeGreaterThan(calls.findIndex(r => r.action === 'write' && r.sequence === 3));
  });

  it('keeps the same lease while switching back during an unfinished input write', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    const firstWrite = deferred<void>();
    f.invoke.mockImplementation(request => request.action === 'write' && request.sequence === 1
      ? firstWrite.promise : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => { mock.terminals[0].input('message'); mock.terminals[0].input('\r'); });
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write' })));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    ui.rerender(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'control')).toHaveLength(1);
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    await act(async () => { firstWrite.resolve(); });
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write').map(([r]) => [r.sequence, r.data])).toEqual([[1, 'message'], [2, '\r']]);
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'release')).toHaveLength(1);
  });

  it('drops queued Enter after an uncertain write even when the view is already hidden', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    let rejectWrite!: (error: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    f.invoke.mockImplementation(request => request.action === 'write' ? firstWrite : original(request));
    const ui = render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => { mock.terminals[0].input('message'); mock.terminals[0].input('\r'); });
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write' })));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    await act(async () => { rejectWrite(new Error('receipt lost')); });
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1);
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'release')).toHaveLength(1);
    expect(mock.terminals[0].options.disableStdin).toBe(true);
    await screen.findByText('ccAgent.presentation.unavailable');
  });

  it('restores a snapshot before subsequent frames and uses the original dimensions', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((request) => request.action === 'attach' ? Promise.resolve({ attachmentId: 'view', replay: replay({
      snapshot: { sequence: 40, data: 'screen', cols: 90, rows: 30 }, frames: [{ sequence: 41, data: 'tail' }],
    }) }) : original(request));
    render(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'read', afterSequence: 41 })));
    expect(mock.terminals[0].resize).toHaveBeenCalledWith(90, 30);
    expect(mock.terminals[0].write.mock.calls.map((call: any[]) => call[0])).toEqual(['screen', 'tail']);
  });

  it('retries only the view after an uncertain input and ignores the old pending read', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    const newRead = deferred<AgentTerminalReplay>();
    let attachments = 0;
    f.invoke.mockImplementation(async (request) => {
      if (request.action === 'attach') return { attachmentId: 'view-' + ++attachments, replay: replay() };
      if (request.action === 'read' && request.attachmentId === 'view-2') return newRead.promise;
      if (request.action === 'write') throw new Error('receipt lost');
      return original(request);
    });
    const recover = vi.fn(async () => {});
    render(<AgentNativeTerminal sessionId="task" active invoke={f.invoke} onReconnect={recover} />);
    await waitFor(() => expect(mock.terminals[0].options.disableStdin).toBe(false));
    act(() => mock.terminals[0].input('uncertain'));
    await screen.findByText('ccAgent.presentation.unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.presentation.retry' }));
    expect(recover).toHaveBeenCalledOnce();
    await waitFor(() => expect(mock.terminals[1].options.disableStdin).toBe(false));
    expect(mock.terminals[0].dispose).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenCalledWith({ action: 'detach', attachmentId: 'view-1', sessionId: 'task' });
    await act(async () => { f.read.resolve(replay({ frames: [{ sequence: 1, data: 'old output' }] })); });
    expect(mock.terminals[1].write).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1);
    expect(f.invoke.mock.calls.every(([r]) => ['attach', 'control', 'read', 'write', 'release', 'detach'].includes(r.action))).toBe(true);
  });

  it('waits for explicit same-task recovery before reattaching an exited native process', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    const ready = deferred<void>();
    const recover = vi.fn(() => ready.promise);
    let attachments = 0;
    f.invoke.mockImplementation(request => request.action === 'attach' && ++attachments === 1
      ? Promise.resolve({ attachmentId: 'old-view', replay: replay({
        state: { ...replay().state, status: 'exited' },
      }) }) : original(request));
    render(<AgentNativeTerminal sessionId="original-task" active invoke={f.invoke} onReconnect={recover} />);
    await screen.findByText('ccAgent.presentation.exited');
    expect(recover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.presentation.retry' }));
    expect(recover).toHaveBeenCalledOnce();
    expect(attachments).toBe(1);
    await act(async () => { ready.resolve(); });
    await waitFor(() => expect(mock.terminals[1].options.disableStdin).toBe(false));
    expect(attachments).toBe(2);
    expect(f.invoke.mock.calls.every(([request]) => request.sessionId === 'original-task')).toBe(true);
    expect(f.invoke.mock.calls.filter(([request]) => request.action === 'write')).toEqual([]);
  });
});
