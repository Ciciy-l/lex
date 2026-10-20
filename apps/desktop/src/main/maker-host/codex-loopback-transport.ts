import WebSocket from 'ws';
import type {
  CodexAppServerTransport as Transport, CodexAppServerLineHandler as LineHandler,
  CodexAppServerCloseHandler as CloseHandler,
} from '@cindy/maker-core';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WRITES = 256;

export interface CodexLoopbackTransportOptions {
  /** Main's owned native listener, never a renderer-supplied URL. */
  url: string;
  /** High-entropy per-service credential. Never log it or pass it in argv. */
  token: string;
  connectTimeoutMs?: number;
}

/**
 * One authenticated GUI connection to a Main-owned app-server. Closing this
 * connection does not own the shared service or another TUI client. The host
 * controls service lifetime separately. No reconnect or uncertain-write replay.
 */
export function createCodexLoopbackTransport(options: CodexLoopbackTransportOptions): Transport {
  let url: URL;
  try { url = new URL(options.url); }
  catch { throw new Error('Codex native listener must be an owned loopback endpoint'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Codex native listener must be an owned loopback endpoint');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(options.token)) throw new Error('Invalid native Codex capability');
  const timeout = options.connectTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid native Codex connection deadline');

  const lines = new Set<LineHandler>(), closes = new Set<CloseHandler>();
  const buffered: string[] = [];
  let bufferedBytes = 0, armed = false, reason: string | undefined;
  let pendingBytes = 0;
  const pending = new Set<(error: Error) => void>();
  let closing: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const socket = new WebSocket(url, {
    headers: { Authorization: 'Bearer ' + options.token }, handshakeTimeout: timeout,
    followRedirects: false, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES,
  });
  const finish = (why: string) => {
    if (reason !== undefined) return;
    reason = why; buffered.length = 0; bufferedBytes = 0;
    const error = new Error(why); rejectReady(error);
    for (const reject of [...pending]) reject(error);
    for (const listener of closes) { try { listener({ reason: why }); } catch { /* Isolate observers. */ } }
  };
  const terminate = (why: string) => {
    finish(why);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  };
  socket.on('open', () => { if (reason === undefined) resolveReady(); else socket.terminate(); });
  socket.on('message', (raw, binary) => {
    if (reason !== undefined) return;
    if (binary) { terminate('Codex native transport received a binary frame'); return; }
    const line = raw.toString(), bytes = Buffer.byteLength(line);
    if (!armed) {
      if (bufferedBytes + bytes > MAX_FRAME_BYTES || buffered.length >= 256) {
        terminate('Codex native transport receive buffer exceeded'); return;
      }
      buffered.push(line); bufferedBytes += bytes; return;
    }
    for (const handler of lines) {
      if (reason !== undefined) break;
      try { handler(line); } catch { terminate('Codex native protocol consumer failed'); }
    }
  });
  // Error details can contain upstream headers; only expose a stable category.
  socket.on('error', () => terminate('Codex native transport connection failed'));
  socket.on('close', () => { finish('Codex native transport disconnected'); resolveExit(); });

  return {
    writeLine(line) {
      if (reason !== undefined) return Promise.reject(new Error(reason));
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_FRAME_BYTES || pendingBytes + bytes > MAX_FRAME_BYTES || pending.size >= MAX_PENDING_WRITES) {
        return Promise.reject(new Error('Codex native transport send buffer exceeded'));
      }
      // Reserve before waiting for the handshake; callers cannot create an
      // unbounded set of writes while the listener is unavailable.
      pendingBytes += bytes;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true; pending.delete(fail); pendingBytes -= bytes;
          if (error) reject(error); else resolve();
        };
        const fail = (error: Error) => settle(error); pending.add(fail);
        void ready.then(() => {
          if (settled) return;
          if (reason !== undefined || socket.readyState !== WebSocket.OPEN) {
            settle(new Error(reason ?? 'Codex native transport is not open')); return;
          }
          try { socket.send(line, { binary: false, compress: false }, error => {
            settle(error ? new Error('Codex native transport write unconfirmed') : undefined);
            if (error) terminate('Codex native transport write unconfirmed');
          }); } catch { settle(new Error('Codex native transport write unconfirmed')); terminate('Codex native transport write unconfirmed'); }
        }, fail);
      });
    },
    onLine(handler) {
      lines.add(handler);
      if (!armed) {
        armed = true; const queued = buffered.splice(0); bufferedBytes = 0;
        for (const line of queued) {
          if (reason !== undefined) break;
          try { handler(line); } catch { terminate('Codex native protocol consumer failed'); }
        }
      }
      return () => { lines.delete(handler); };
    },
    onClose(handler) {
      closes.add(handler);
      if (reason !== undefined) queueMicrotask(() => { if (closes.has(handler)) handler({ reason: reason! }); });
      return () => { closes.delete(handler); };
    },
    close(why = 'Codex native transport closed') {
      if (closing) return closing;
      // Revoke the writer before closing the socket. No queued input may escape.
      terminate(why);
      closing = exited.then(() => { lines.clear(); closes.clear(); });
      return closing;
    },
  };
}
