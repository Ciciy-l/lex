import { createServer, type Server, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexLoopbackTransport } from '../codex-loopback-transport.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const token = randomBytes(32).toString('base64url');
  const http = createServer();
  const server = new WebSocketServer({ server: http, verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.authorization === 'Bearer ' + token });
  const connections: WebSocket[] = []; const received: string[] = [];
  server.on('connection', socket => { connections.push(socket); socket.on('message', value => received.push(value.toString())); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  cleanup.push(async () => { for (const s of server.clients) s.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address() as { port: number };
  const url = 'ws://127.0.0.1:' + address.port;
  const transport = createCodexLoopbackTransport({ url, token });
  cleanup.push(() => transport.close());
  return { transport, http, server, token, url, connections, received };
}
describe('owned native Codex WebSocket connection', () => {
  it('authenticates, sends exactly one text frame per line, and preserves delivery order', async () => {
    const f = await fixture(); const lines: string[] = []; f.transport.onLine(line => lines.push(line));
    await Promise.all([f.transport.writeLine('{"id":1}'), f.transport.writeLine('{"id":2}')]);
    await vi.waitFor(() => expect(f.received).toEqual(['{"id":1}', '{"id":2}']));
    f.connections[0]!.send('{"id":1,"result":{}}'); f.connections[0]!.send('{"id":2,"result":{}}');
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(lines).toEqual(['{"id":1,"result":{}}', '{"id":2,"result":{}}']);
  });

  it('buffers early input only until the first subscriber and refuses binary protocol input', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    f.connections[0]!.send('first'); await new Promise(resolve => setTimeout(resolve, 20));
    const lines: string[] = [], close = vi.fn(); f.transport.onClose(close); f.transport.onLine(line => lines.push(line));
    expect(lines).toEqual(['first']);
    f.connections[0]!.send(Buffer.from('not a text frame'));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(close.mock.calls[0]?.[0].reason).toContain('binary');
    await expect(f.transport.writeLine('later')).rejects.toThrow('binary');
  });

  it('does not close the native service or another frontend when this GUI connection closes', async () => {
    const f = await fixture(); const other = new WebSocket(f.url, { headers: { Authorization: 'Bearer ' + f.token } });
    cleanup.push(async () => { other.terminate(); }); await once(other, 'open');
    await f.transport.close(); expect(other.readyState).toBe(WebSocket.OPEN);
    other.send('other frontend is alive');
    await vi.waitFor(() => expect(f.received).toContain('other frontend is alive'));
    expect(f.http.listening).toBe(true);
  });

  it('reports authentication rejection without credentials and never reconnects or replays input', async () => {
    const f = await fixture(); const wrong = createCodexLoopbackTransport({ url: f.url, token: randomBytes(32).toString('base64url') });
    cleanup.push(() => wrong.close()); const closed = vi.fn(); wrong.onClose(closed);
    await expect(wrong.writeLine('must not arrive')).rejects.toThrow('connection failed');
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(JSON.stringify(closed.mock.calls)).not.toContain(f.token);
    expect(f.received).toEqual([]);
    await expect(wrong.writeLine('never retry')).rejects.toThrow('connection failed');
  });

  it('revokes pending writes on explicit close before the handshake completes', async () => {
    const server: Server = createServer(); server.on('upgrade', (_request, socket) => { socket.on('error', () => {}); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const url = 'ws://127.0.0.1:' + (server.address() as { port: number }).port;
    const transport = createCodexLoopbackTransport({ url, token: randomBytes(32).toString('base64url') });
    const sent = transport.writeLine('must not arrive'); const rejected = expect(sent).rejects.toThrow('closed');
    await transport.close(); await rejected;
  });

  it('bounds unsent writes before connecting without dropping accepted earlier writes', async () => {
    const f = await fixture();
    const writes = Array.from({ length: 256 }, (_, i) => f.transport.writeLine(String(i)));
    await expect(f.transport.writeLine('overflow')).rejects.toThrow('buffer exceeded');
    await Promise.all(writes); await vi.waitFor(() => expect(f.received).toHaveLength(256));
    expect(f.received).toEqual(Array.from({ length: 256 }, (_, i) => String(i)));
  });

  it('requires Main-owned loopback routing and a nonempty credential', () => {
    const token = randomBytes(32).toString('base64url');
    for (const url of ['not a url with private input', 'wss://127.0.0.1:1234', 'ws://localhost:1234', 'ws://192.168.1.1:1234',
      'ws://127.0.0.1:1234/other', 'ws://127.0.0.1:1234/?token=secret', 'ws://user:pass@127.0.0.1:1234']) {
      expect(() => createCodexLoopbackTransport({ url, token })).toThrow('loopback');
    }
    expect(() => createCodexLoopbackTransport({ url: 'ws://127.0.0.1:1234', token: '' })).toThrow('capability');
  });
});
