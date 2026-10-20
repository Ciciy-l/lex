import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import type { IPty } from 'node-pty';
import { AgentPresentationRuntime } from '@cindy/maker-core';
import { AgentTerminalPtyDriver } from '../agentTerminalDriver.js';
import { TerminalEscapeTail } from '../terminalEscapeTail.js';

const ESC = String.fromCharCode(27), ST = ESC + String.fromCharCode(92);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  let output!: (data: string) => void, exit!: (event: { exitCode: number }) => void;
  const pty = { pid: 42, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: (fn: typeof output) => { output = fn; return { dispose: vi.fn() }; },
    onExit: (fn: typeof exit) => { exit = fn; return { dispose: vi.fn() }; },
  };
  const spawn = vi.fn(() => pty as unknown as IPty);
  pty.kill.mockImplementation(() => exit({ exitCode: 0 }));
  const driver = new AgentTerminalPtyDriver({ executable: 'owned-runtime', args: ['native'], cwd: 'owned-dir', env: { FIXTURE: '1' }, cols: 40, rows: 8 }, spawn);
  cleanup.push(() => driver.close());
  const seen: string[] = []; driver.onData((data) => seen.push(data));
  async function send(data: string) { const count = seen.length; output(data); await vi.waitFor(() => expect(seen.length).toBe(count + 1)); }
  return { driver, pty, spawn, seen, send, output, exit };
}
function restored(snapshot: { data: string; cols: number; rows: number }) {
  const terminal = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true, scrollback: 500 });
  cleanup.push(() => terminal.dispose());
  return { terminal, ready: new Promise<void>((resolve) => terminal.write(snapshot.data, resolve)) };
}

describe('task-owned native PTY screen', () => {
  it('restores the native alternate screen, colors and cursor without another process', async () => {
    const f = fixture();
    await f.send('normal history' + ESC + '[?1049h' + ESC + '[2J' + ESC + '[H' + ESC + '[31mNative Claude' + ESC + '[0m' + ESC + '[3;5Hdraft');
    const copy = restored(f.driver.snapshot()); await copy.ready;
    expect(copy.terminal.buffer.active.type).toBe('alternate');
    expect(copy.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Native Claude');
    expect(copy.terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('    draft');
    expect(copy.terminal.buffer.active.cursorX).toBe(9);
    expect(copy.terminal.buffer.active.cursorY).toBe(2);
    expect(copy.terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('answers native queries with no attached view', async () => {
    const f = fixture(); await f.send('hello' + ESC + '[6n' + ESC + '[c');
    expect(f.pty.write).toHaveBeenCalledWith(ESC + '[1;6R');
    expect(f.pty.write).toHaveBeenCalledWith(ESC + '[?1;2c');
  });

  it('recovers lost output using a screen and continues a split ANSI sequence', async () => {
    const f = fixture();
    const runtime = new AgentPresentationRuntime('native', f.driver, { cols: 40, rows: 8, maxReplayBytes: 3 });
    const view = runtime.attach('local', vi.fn());
    await f.send('before' + ESC + '[3');
    const replay = view.read();
    expect(replay.gap).toBe(false); expect(replay.snapshot).toBeDefined();
    const copy = restored(replay.snapshot!); await copy.ready;
    await f.send('1mRED' + ESC + '[0m');
    await new Promise<void>((resolve) => copy.terminal.write('1mRED' + ESC + '[0m', resolve));
    expect(copy.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('beforeRED');
    expect(copy.terminal.buffer.active.getLine(0)?.getCell(6)?.getFgColor()).toBe(1);
    view.detach(); expect(f.pty.kill).not.toHaveBeenCalled();
    await runtime.close(); expect(f.pty.kill).toHaveBeenCalledOnce();
  });

  it('preserves output/resize/exit order and drains before reporting exit', async () => {
    const f = fixture(), events: unknown[] = [];
    f.driver.onData((data, size) => events.push({ data, size }));
    f.driver.onExit((exit) => events.push({ exit }));
    f.output('before'); f.driver.resize(60, 12); f.output('after'); f.exit({ exitCode: 0 });
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events).toEqual([{ data: 'before', size: { cols: 40, rows: 8 } },
      { data: '', size: { cols: 60, rows: 12 } }, { data: 'after', size: { cols: 60, rows: 12 } }, { exit: { code: 0 } }]);
    expect(f.driver.snapshot()).toMatchObject({ cols: 60, rows: 12 });
    await f.driver.close(); expect(f.pty.kill).not.toHaveBeenCalled();
  });

  it('does not replay cursor effects already executed inside an unfinished CSI', async () => {
    const f = fixture();
    await f.send('before' + ESC + '[3' + String.fromCharCode(10));
    const copy = restored(f.driver.snapshot()); await copy.ready;
    const suffix = '1mRED' + ESC + '[0m';
    await f.send(suffix);
    await new Promise<void>(resolve => copy.terminal.write(suffix, resolve));
    const final = restored(f.driver.snapshot()); await final.ready;
    expect(copy.terminal.buffer.active.cursorY).toBe(final.terminal.buffer.active.cursorY);
    expect(copy.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('      RED');
    expect(copy.terminal.buffer.active.getLine(1)?.getCell(6)?.getFgColor()).toBe(1);
  });

  it('pauses the PTY while its parser is behind, independently of slow viewers', async () => {
    const f = fixture(); f.output('x'.repeat(300_000));
    expect(f.pty.pause).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.pty.resume).toHaveBeenCalledOnce());
    await f.driver.close(); await f.driver.close(); expect(f.pty.kill).toHaveBeenCalledOnce();
  });

  it('keeps only unfinished control sequences, including split ST and cancellations', () => {
    const tail = new TerminalEscapeTail();
    tail.accept('text' + ESC + ']8;;https://example.test'); expect(tail.pending()).toBe(ESC + ']8;;https://example.test');
    tail.accept(ESC); expect(tail.pending().endsWith(ESC)).toBe(true);
    tail.accept(String.fromCharCode(92) + 'label'); expect(tail.pending()).toBe('');
    tail.accept(ESC + '[38;2;255'); tail.accept(String.fromCharCode(24) + 'plain'); expect(tail.pending()).toBe('');
    tail.accept(ESC + '(B'); expect(tail.pending()).toBe('');
    tail.accept(ESC + 'Pdata'); expect(tail.pending()).toBe(ESC + 'Pdata');
    tail.accept(ST); expect(tail.pending()).toBe('');
  });
});
