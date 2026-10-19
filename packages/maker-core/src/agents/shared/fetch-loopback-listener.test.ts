import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { listenFetchLoopback } from './fetch-loopback-listener.js';

// Fake OS allocations keep blocked-port coverage deterministic without binding
// a fixed machine port or altering the system's ephemeral-port configuration.
function fixture(ports: number[]) {
  const events = new EventEmitter();
  let index = -1;
  const server = Object.assign(events, {
    listen: vi.fn((_port: number, _host: string, done: () => void) => { index++; queueMicrotask(done); return events; }),
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port: ports[Math.min(index, ports.length - 1)]! }),
    close: vi.fn((done: (error?: Error) => void) => { queueMicrotask(() => done()); return events; }),
  });
  return { server: server as unknown as Parameters<typeof listenFetchLoopback>[0], events, listen: server.listen, close: server.close };
}

describe('native Fetch loopback listener', () => {
  it('keeps the first usable OS allocation and never picks a fixed port', async () => {
    const f = fixture([49152]);
    expect(await listenFetchLoopback(f.server)).toBe(49152);
    expect(f.listen).toHaveBeenCalledExactlyOnceWith(0, '127.0.0.1', expect.any(Function));
    expect(f.close).not.toHaveBeenCalled();
    expect(f.events.listenerCount('error')).toBe(0);
  });
  it.each([6000, 6666, 10080])('closes Fetch-blocked allocation %i before requesting a new one', async blocked => {
    const f = fixture([blocked, 49153]);
    expect(await listenFetchLoopback(f.server)).toBe(49153);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.listen).toHaveBeenCalledTimes(2);
    expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.listen.mock.invocationCallOrder[1]);
  });
  it('bounds repeated unusable OS allocations and releases every listener', async () => {
    const f = fixture([10080]);
    await expect(listenFetchLoopback(f.server)).rejects.toThrow('No Fetch-compatible');
    expect(f.listen).toHaveBeenCalledTimes(8); expect(f.close).toHaveBeenCalledTimes(8);
    expect(f.events.listenerCount('error')).toBe(0);
  });
  it('reports bind failures without starting another listener', async () => {
    const f = fixture([49152]);
    f.listen.mockImplementation(() => { queueMicrotask(() => f.events.emit('error', new Error('fixture bind failure'))); return f.events as never; });
    await expect(listenFetchLoopback(f.server)).rejects.toThrow('fixture bind failure');
    expect(f.listen).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
    expect(f.events.listenerCount('error')).toBe(0);
  });
  it('does not rebind if closing an unusable listener fails', async () => {
    const f = fixture([10080, 49152]);
    f.close.mockImplementation(done => { queueMicrotask(() => done(new Error('fixture close failure'))); return f.events as never; });
    await expect(listenFetchLoopback(f.server)).rejects.toThrow('fixture close failure');
    expect(f.listen).toHaveBeenCalledOnce();
  });
});
