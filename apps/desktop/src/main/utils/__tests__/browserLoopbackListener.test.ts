import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { listenBrowserLoopback } from '../browserLoopbackListener.js';

// Synthetic OS allocations never bind a fixed or forbidden machine port.
function fixture(ports: number[]) {
  const server = new EventEmitter();
  let index = -1;
  const listener = Object.assign(server, {
    listen: vi.fn((_port: number, _host: string, ready: () => void) => { index++; queueMicrotask(ready); return server; }),
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port: ports[Math.min(index, ports.length - 1)]! }),
    close: vi.fn((done: (error?: Error) => void) => { queueMicrotask(() => done()); return server; }),
  });
  return { server: listener as unknown as Parameters<typeof listenBrowserLoopback>[0], listen: listener.listen, close: listener.close, events: server };
}

describe('browser loopback allocation', () => {
  it.each([6000, 6666, 10080])('releases forbidden port %i before publishing a usable allocation', async blocked => {
    const f = fixture([blocked, 49152]);
    expect(await listenBrowserLoopback(f.server)).toBe(49152);
    expect(f.listen).toHaveBeenCalledTimes(2);
    expect(f.listen).toHaveBeenNthCalledWith(1, 0, '127.0.0.1', expect.any(Function));
    expect(f.listen).toHaveBeenNthCalledWith(2, 0, '127.0.0.1', expect.any(Function));
    expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.listen.mock.invocationCallOrder[1]!);
    expect(f.events.listenerCount('error')).toBe(0);
  });
  it('keeps the first usable allocation', async () => {
    const f = fixture([49153]);
    expect(await listenBrowserLoopback(f.server)).toBe(49153);
    expect(f.listen).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  });
  it('bounds unusable allocations and closes each listener', async () => {
    const f = fixture([6000]);
    await expect(listenBrowserLoopback(f.server)).rejects.toThrow('No browser-compatible');
    expect(f.listen).toHaveBeenCalledTimes(8); expect(f.close).toHaveBeenCalledTimes(8);
    expect(f.events.listenerCount('error')).toBe(0);
  });
  it('preserves bind and close failures without continuing', async () => {
    const bind = fixture([49153]);
    bind.listen.mockImplementation(() => { queueMicrotask(() => bind.events.emit('error', new Error('bind failed'))); return bind.events; });
    await expect(listenBrowserLoopback(bind.server)).rejects.toThrow('bind failed');
    expect(bind.listen).toHaveBeenCalledOnce();
    const closing = fixture([6000, 49153]);
    closing.close.mockImplementation(done => { queueMicrotask(() => done(new Error('close failed'))); return closing.events; });
    await expect(listenBrowserLoopback(closing.server)).rejects.toThrow('close failed');
    expect(closing.listen).toHaveBeenCalledOnce();
  });
});
