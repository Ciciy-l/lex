import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { CodexAppServerTransport as Transport, CodexAppServerLineHandler as LineHandler, CodexAppServerCloseHandler as CloseHandler } from '@cindy/maker-core';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 256;
export interface CodexNativeGateway {
  /** Per-task TUI-only capability, distinct from the native service credential. */
  readonly endpoint: { url: string; token: string };
  close(): Promise<void>;
}

/** Main-only listener. This capability is passed to the native PTY, never IPC. */
export async function createCodexNativeGateway(options: {
  isCurrent(): boolean;
  attach(frontend: Transport): { close(): Promise<void> };
}): Promise<CodexNativeGateway> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from('Bearer ' + token);
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  http.requestTimeout = 5_000; http.headersTimeout = 5_000;
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_BYTES });
  const links = new Set<{ close(): Promise<void> }>();
  let closed = false, port = 0, closing: Promise<void> | undefined;
  const current = () => { try { return !closed && options.isCurrent(); } catch { return false; } };
  const authorized = (req: IncomingMessage) => {
    if (!current() || req.url !== '/' || req.headers.origin !== undefined
      || req.headers.host !== '127.0.0.1:' + port || server.clients.size >= 4) return false;
    const auth = req.headers.authorization;
    if (typeof auth !== 'string') return false;
    const received = Buffer.from(auth);
    return received.length === expected.length && timingSafeEqual(received, expected);
  };
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!authorized(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws, req));
  });
  server.on('connection', socket => {
    if (!current()) { socket.terminate(); return; }
    const transport = acceptedSocket(socket);
    let link: { close(): Promise<void> };
    try { link = options.attach(transport); links.add(link); }
    catch { void transport.close(); return; }
    transport.onClose(() => {
      void link.close().finally(() => { links.delete(link); }).catch(() => {});
    });
  });
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      const settled = Promise.allSettled([...links].map(link => link.close()));
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
      const outcomes = await settled;
      links.clear();
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    });
    return closing;
  };
  server.on('error', () => { void close().catch(() => {}); });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => { reject(new Error('Native Codex frontend listener failed')); };
      http.once('error', failed);
      http.listen(0, '127.0.0.1', () => { http.off('error', failed); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Native Codex frontend listener unavailable');
    port = address.port;
    http.on('error', () => { void close().catch(() => {}); });
    if (!current()) throw new Error('Native Codex task changed before listener readiness');
    return { endpoint: { url: 'ws://127.0.0.1:' + port, token }, close };
  } catch (error) { await close(); throw error; }
}

/** Bounded accepted socket. Closing it never kills the task or native service. */
function acceptedSocket(socket: WebSocket): Transport {
  const lines = new Set<LineHandler>(), closes = new Set<CloseHandler>();
  const queued: string[] = [];
  const writes = new Set<(error?: Error) => void>();
  let reason: string | undefined, armed = false, bytes = 0, closing: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const finish = (why: string) => {
    if (reason !== undefined) return;
    reason = why; queued.length = 0; bytes = 0;
    for (const settle of [...writes]) settle(new Error(why));
    for (const fn of [...closes]) { try { fn({ reason: why }); } catch { /* Observer isolation. */ } }
  };
  const terminate = (why: string) => { finish(why); socket.terminate(); };
  socket.on('error', () => terminate('Native Codex frontend socket failed'));
  socket.on('close', () => { finish('Native Codex frontend disconnected'); resolveExit(); });
  socket.on('message', (raw, binary) => {
    if (reason !== undefined) return;
    if (binary) { terminate('Native Codex frontend requires text frames'); return; }
    const line = raw.toString();
    if (!armed) {
      if (queued.length >= MAX_PENDING || bytes + Buffer.byteLength(line) > MAX_BYTES) {
        terminate('Native Codex frontend receive buffer exceeded'); return;
      }
      queued.push(line); bytes += Buffer.byteLength(line); return;
    }
    for (const fn of [...lines]) { try { fn(line); } catch { terminate('Native Codex frontend protocol failed'); break; } }
  });
  return {
    writeLine(line) {
      if (reason !== undefined || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Native Codex frontend closed'));
      if (writes.size >= MAX_PENDING || Buffer.byteLength(line) + socket.bufferedAmount > MAX_BYTES) {
        terminate('Native Codex frontend send buffer exceeded'); return Promise.reject(new Error('Native Codex frontend send buffer exceeded'));
      }
      return new Promise((resolve, reject) => {
        const settle = (error?: Error) => {
          if (!writes.delete(settle)) return;
          if (error) reject(error); else resolve();
        };
        writes.add(settle);
        try { socket.send(line, { binary: false, compress: false }, error => {
          settle(error ? new Error('Native Codex frontend write unconfirmed') : undefined);
          if (error) terminate('Native Codex frontend write unconfirmed');
        }); } catch { settle(new Error('Native Codex frontend write unconfirmed')); terminate('Native Codex frontend write unconfirmed'); }
      });
    },
    onLine(fn) {
      lines.add(fn);
      if (!armed) {
        armed = true; const prior = queued.splice(0); bytes = 0;
        for (const line of prior) { if (reason !== undefined) break; try { fn(line); } catch { terminate('Native Codex frontend protocol failed'); } }
      }
      return () => { lines.delete(fn); };
    },
    onClose(fn) {
      closes.add(fn);
      if (reason !== undefined) queueMicrotask(() => { if (closes.has(fn)) fn({ reason: reason! }); });
      return () => { closes.delete(fn); };
    },
    close(why = 'Native Codex frontend closed') {
      if (closing) return closing;
      closing = exited.then(() => { lines.clear(); closes.clear(); });
      terminate(why); return closing;
    },
  };
}
