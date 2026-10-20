// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNativeTerminal } from '../AgentNativeTerminal';
import type { AgentTerminalReplay } from '../../../../shared/agentPresentation';

const mock = vi.hoisted(() => ({ terminals: [] as any[], themes: new Set<() => void>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/themes/theme-service', () => ({ themeService: { onDidChangeTheme: (fn: () => void) => { mock.themes.add(fn); return () => mock.themes.delete(fn); } } }));
vi.mock('../../right-sidebar/plugins/terminal/lib/xtermPool', () => ({ getTerminalTheme: () => ({}), openTerminalExternalLink: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: any; cols = 80; rows = 24; input?: (data: string) => void;
  parser = { registerCsiHandler: () => ({ dispose() {} }), registerOscHandler: () => ({ dispose() {} }), registerDcsHandler: () => ({ dispose() {} }) };
  constructor(options: any) { this.options = options; mock.terminals.push(this); }
  loadAddon() {} open() {} focus = vi.fn(); reset = vi.fn(); dispose = vi.fn();
  resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
  write = vi.fn((_text: string, callback: () => void) => callback());
  onData(fn: (data: string) => void) { this.input = fn; return { dispose() {} }; }
  attachCustomKeyEventHandler() {} hasSelection() { return false; }
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
beforeEach(() => { mock.terminals.length = 0; vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('native task view', () => {
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
    act(() => { terminal.input('message'); terminal.input('\r'); });
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'write', sequence: 1 })));
    ui.rerender(<AgentNativeTerminal sessionId="task" active={false} invoke={f.invoke} />);
    expect(terminal.options.disableStdin).toBe(true);
    act(() => terminal.input('hidden input'));
    expect(f.invoke.mock.calls.filter(([r]) => r.action === 'release')).toHaveLength(0);
    await act(async () => { firstWrite.resolve(); });
    const calls = f.invoke.mock.calls.map(([request]) => request);
    expect(calls.filter(r => r.action === 'write').map(r => [r.sequence, r.data])).toEqual([[1, 'message'], [2, '\r']]);
    expect(calls.filter(r => r.action === 'release')).toHaveLength(1);
    expect(calls.findIndex(r => r.action === 'release')).toBeGreaterThan(calls.findIndex(r => r.action === 'write' && r.sequence === 2));
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
