import { describe, expect, it, vi } from 'vitest';
import { AgentPresentationRuntime, type AgentTerminalDriver } from './presentation.js';

function fixture(maxReplayBytes?: number) {
  let data: (data: string) => void = () => {};
  let exit: (exit: { code: number | null }) => void = () => {};
  const stopData = vi.fn();
  const stopExit = vi.fn();
  const driver: AgentTerminalDriver = {
    write: vi.fn(), resize: vi.fn(), close: vi.fn(),
    onData: (listener) => { data = listener; return stopData; },
    onExit: (listener) => { exit = listener; return stopExit; },
  };
  const runtime = new AgentPresentationRuntime('native-task', driver, { maxReplayBytes });
  return { runtime, driver, stopData, stopExit, data: (value: string) => data(value), exit: (code: number) => exit({ code }) };
}

describe('task-owned native presentation', () => {
  it('pages escaped output within the wire budget without splitting surrogate pairs', () => {
    const f = fixture(2_000_000); const view = f.runtime.attach('desktop', vi.fn());
    const data = String.fromCharCode(27).repeat(90_000) + '😀'.repeat(20_000); f.data(data);
    const first = view.read();
    expect(Buffer.byteLength(JSON.stringify(first.frames))).toBeLessThan(263_000);
    expect(first.frames.at(-1)!.sequence).toBeLessThan(first.state.sequence);
    let sequence = first.frames.at(-1)!.sequence;
    const frames = [...first.frames];
    while (sequence < first.state.sequence) {
      const next = view.read(sequence); frames.push(...next.frames); sequence = next.frames.at(-1)!.sequence;
    }
    expect(frames.map((frame) => frame.data).join('')).toBe(data);
    for (const frame of frames) expect(Buffer.from(frame.data).toString()).toBe(frame.data);
  });

  it('returns a trusted screen at the current cursor when replay has expired', () => {
    const f = fixture(3); f.driver.snapshot = () => ({ data: 'screen', cols: 40, rows: 8 });
    f.data('long output'); const view = f.runtime.attach('desktop', vi.fn());
    expect(view.read()).toMatchObject({ gap: false, frames: [], snapshot: { sequence: 1, data: 'screen', cols: 40, rows: 8 } });
  });

  it('keeps output and the same runtime alive while every view is detached', () => {
    const f = fixture();
    const view = f.runtime.attach('desktop', vi.fn());
    const generation = f.runtime.state().generation;
    view.acquireControl();
    view.detach(); view.detach();
    f.data('working without a view');
    expect(f.driver.close).not.toHaveBeenCalled();
    const reopened = f.runtime.attach('desktop', vi.fn());
    expect(reopened.read()).toMatchObject({ state: { generation, nativeSessionId: 'native-task', status: 'running' },
      frames: [{ sequence: 1, data: 'working without a view' }], gap: false });
    expect(() => view.read()).toThrow('expired');
  });

  it('fences the old writer and resizes only from the current controller', () => {
    const f = fixture();
    const local = f.runtime.attach('local', vi.fn());
    const remote = f.runtime.attach('remote', vi.fn());
    const first = local.acquireControl()!;
    expect(local.acquireControl()).toEqual(first);
    expect(remote.acquireControl()).toBeNull();
    local.write(first, 1, 'draft');
    const second = remote.acquireControl(true)!;
    expect(local.read().controlling).toBe(false);
    expect(remote.read().controlling).toBe(true);
    expect(second.lease).not.toBe(first.lease);
    expect(() => local.write(first, 2, '\r')).toThrow('expired');
    expect(() => local.resize(first, 80, 24)).toThrow('expired');
    expect(() => local.releaseControl(first)).toThrow('expired');
    remote.resize(second, 90, 28);
    remote.write(second, 1, 'remote');
    expect(f.driver.write).toHaveBeenCalledTimes(2);
    expect(f.runtime.state()).toMatchObject({ controller: 'remote', cols: 90, rows: 28 });
    remote.releaseControl(second);
    expect(f.runtime.state().controller).toBeNull();
  });

  it('does not let another attachment of the same peer use its lease', () => {
    const f = fixture();
    const a = f.runtime.attach('desktop', vi.fn());
    const b = f.runtime.attach('desktop', vi.fn());
    const lease = a.acquireControl()!;
    expect(() => b.write(lease, 1, 'x')).toThrow('expired');
    b.detach();
    a.write(lease, 1, 'a');
    expect(f.driver.write).toHaveBeenCalledWith('a');
  });

  it('rejects control from an earlier runtime with the same native identity', () => {
    const first = fixture();
    const old = first.runtime.attach('desktop', vi.fn()).acquireControl()!;
    const second = fixture();
    const view = second.runtime.attach('desktop', vi.fn());
    const current = view.acquireControl()!;
    expect(() => view.write({ ...current, generation: old.generation }, 1, 'x')).toThrow('expired');
    expect(second.driver.write).not.toHaveBeenCalled();
  });

  it('never replays a write whose failure might have occurred after native delivery', () => {
    const f = fixture();
    const view = f.runtime.attach('desktop', vi.fn());
    const lease = view.acquireControl()!;
    vi.mocked(f.driver.write).mockImplementationOnce(() => { throw new Error('connection lost after write'); });
    expect(() => view.write(lease, 1, 'do work\r')).toThrow('connection lost');
    expect(() => view.write(lease, 1, 'do work\r')).toThrow('sequence mismatch');
    expect(() => view.write(lease, 3, 'x')).toThrow('sequence mismatch');
    view.write(lease, 2, 'next');
    expect(f.driver.write).toHaveBeenCalledTimes(2);
  });

  it('retains complete UTF-8 frames and explicitly reports missing output', () => {
    const f = fixture(8);
    const view = f.runtime.attach('desktop', vi.fn());
    f.data('abc'); f.data('你好'); f.data('!');
    expect(view.read()).toMatchObject({ gap: true, frames: [{ sequence: 2, data: '你好' }, { sequence: 3, data: '!' }] });
    expect(view.read(1).gap).toBe(false);
    expect(view.read(3).frames).toEqual([]);
    f.data('oversized-frame');
    expect(view.read(3)).toMatchObject({ gap: true, frames: [] });
    f.data('😀');
    expect(view.read(4)).toMatchObject({ gap: false, frames: [{ sequence: 5, data: '😀' }] });
  });

  it('bounds frame count as well as bytes and does not expose mutable storage', () => {
    const f = fixture();
    const view = f.runtime.attach('desktop', vi.fn());
    for (let i = 0; i < 4100; i++) f.data('x');
    const read = view.read();
    expect(read.frames).toHaveLength(4096);
    expect(read.gap).toBe(true);
    read.frames[0].data = 'changed';
    read.state.cols = 2;
    expect(view.read().frames[0].data).toBe('x');
    expect(f.runtime.state().cols).toBe(120);
  });

  it('isolates a broken observer from generation and other peers', () => {
    const f = fixture();
    f.runtime.attach('broken', () => { throw new Error('renderer destroyed'); });
    const notified = vi.fn();
    const healthy = f.runtime.attach('healthy', notified);
    f.data('still streaming');
    expect(notified).toHaveBeenCalledOnce();
    expect(healthy.read().frames[0].data).toBe('still streaming');
    expect(f.runtime.state().status).toBe('running');
  });

  it('keeps exit output readable but fences every write and stale exit callback', async () => {
    const f = fixture();
    const view = f.runtime.attach('desktop', vi.fn());
    const lease = view.acquireControl()!;
    f.data('final output'); f.exit(7); f.exit(0); f.data('late data');
    expect(view.read()).toMatchObject({ state: { status: 'exited', exit: { code: 7 }, controller: null },
      frames: [{ data: 'final output' }] });
    expect(view.acquireControl()).toBeNull();
    expect(() => view.write(lease, 1, 'late')).toThrow('expired');
    expect(f.runtime.attach('new viewer', vi.fn()).read().state.exit?.code).toBe(7);
    await f.runtime.close();
    expect(f.driver.close).toHaveBeenCalledOnce();
  });

  it('closes exactly once and invalidates views before async teardown', async () => {
    const f = fixture();
    const view = f.runtime.attach('desktop', vi.fn());
    const lease = view.acquireControl()!;
    let finish!: () => void;
    vi.mocked(f.driver.close).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const closing = f.runtime.close();
    expect(f.runtime.close()).toBe(closing);
    expect(() => view.write(lease, 1, 'late')).toThrow('expired');
    expect(() => f.runtime.attach('new', vi.fn())).toThrow('unavailable');
    expect(f.stopData).toHaveBeenCalledOnce();
    expect(f.stopExit).toHaveBeenCalledOnce();
    await Promise.resolve(); finish(); await closing;
    expect(f.driver.close).toHaveBeenCalledOnce();
  });

  it('rejects malformed dimensions, cursors and oversized input before dispatch', () => {
    const f = fixture();
    const view = f.runtime.attach('desktop', vi.fn());
    const lease = view.acquireControl()!;
    for (const cursor of [-1, 1, NaN, 0.5]) expect(() => view.read(cursor)).toThrow('cursor');
    for (const cols of [1, 1001, NaN, 80.5]) expect(() => view.resize(lease, cols, 24)).toThrow('dimensions');
    expect(() => view.write(lease, 1, '中'.repeat(30_000))).toThrow('too large');
    view.write(lease, 1, 'valid');
    expect(f.driver.write).toHaveBeenCalledOnce();
    expect(f.driver.resize).not.toHaveBeenCalled();
  });
});
