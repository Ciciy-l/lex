import { createHash, randomBytes } from 'node:crypto';
import { createStdioTransport, type StdioTransportOptions } from './app-server/stdioTransport.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from './app-server/transport.js';

export interface CodexNativeEndpoint { url: string; token: string }
export interface CodexNativeService extends Transport {
  /** Host-only connection material. Never cross Renderer/Device Link boundaries. */
  readonly endpoint: Promise<CodexNativeEndpoint>;
}
export interface CodexNativeServiceOptions extends StdioTransportOptions {
  /** Main implements the authenticated socket using its existing ws dependency. */
  connect(endpoint: CodexNativeEndpoint): Transport;
  startupTimeoutMs?: number;
}

/** One native service for a Codex host; terminal clients do not own its lifetime. */
export function createCodexNativeService(
  options: CodexNativeServiceOptions,
  createProcess: (options: StdioTransportOptions) => Transport = createStdioTransport,
): CodexNativeService {
  // The service alone selects transport/auth. Preserve the caller's model,
  // provider, ephemeral-auth and plugin flags, but never accept another listener.
  const args = options.extraArgs ?? [];
  if (args.some(arg => /^(--listen|--ws-[a-z-]+)(=|$)/.test(arg) || arg === '--')) {
    throw new Error('Native Codex listener configuration must have one owner');
  }
  const deadline = options.startupTimeoutMs ?? 15_000;
  if (!Number.isFinite(deadline) || deadline <= 0) throw new Error('Invalid native Codex startup deadline');
  const token = randomBytes(32).toString('base64url');
  const verifier = createHash('sha256').update(token).digest('hex');
  const lines = new Set<LineHandler>(), diagnostics = new Set<StderrHandler>(), closes = new Set<CloseHandler>();
  let socket: Transport | undefined, reason: string | undefined, closing: Promise<void> | undefined;
  let resolveEndpoint!: (endpoint: CodexNativeEndpoint) => void, rejectEndpoint!: (error: Error) => void;
  const endpoint = new Promise<CodexNativeEndpoint>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
  void endpoint.catch(() => {});
  let resolveConnected!: (transport: Transport) => void, rejectConnected!: (error: Error) => void;
  const connected = new Promise<Transport>((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  void connected.catch(() => {});
  const queued: string[] = []; let queuedBytes = 0, armed = false;
  let pendingCount = 0, pendingBytes = 0;
  const failure = (why: string) => {
    if (reason !== undefined) return;
    reason = why; clearTimeout(timer); queued.length = 0; queuedBytes = 0;
    rejectEndpoint(new Error(why)); rejectConnected(new Error(why));
    for (const listener of closes) { try { listener({ reason: why }); } catch { /* Observer isolation. */ } }
  };
  const timer = setTimeout(() => { failure('Native Codex listener startup timed out'); void close().catch(() => {}); }, deadline);
  timer.unref();
  let native: Transport;
  try {
    native = createProcess({ ...options, extraArgs: [...args, '--listen', 'ws://127.0.0.1:0',
      '--ws-auth', 'capability-token', '--ws-token-sha256', verifier] });
  } catch (error) { clearTimeout(timer); throw error; }

  function close(why = 'Native Codex service closed'): Promise<void> {
    if (closing) return closing;
    // Publish the promise before synchronous close notifications can re-enter.
    closing = Promise.resolve().then(async () => {
      failure(why);
      const result = await Promise.allSettled([socket?.close(why), native.close(why)]);
      for (const value of result) if (value.status === 'rejected') throw value.reason;
      lines.clear(); diagnostics.clear(); closes.clear();
    });
    failure(why);
    return closing;
  }
  function receive(line: string) {
    if (reason !== undefined) return;
    if (!armed) {
      const bytes = Buffer.byteLength(line);
      if (queued.length >= 256 || queuedBytes + bytes > 16 * 1024 * 1024) {
        failure('Native Codex receive buffer exceeded'); void close().catch(() => {}); return;
      }
      queued.push(line); queuedBytes += bytes; return;
    }
    for (const listener of lines) listener(line);
  }
  function diagnostic(line: string) {
    if (reason !== undefined) return;
    // This exact native startup line discovers an OS-allocated port. It is
    // diagnostic framing only, never conversation/message state or ANSI parsing.
    const match = /^\s*listening on: (ws:\/\/127\.0\.0\.1:([0-9]+))\s*$/.exec(line);
    if (match && !socket) {
      const port = Number(match[2]);
      if (port <= 0 || port > 65535) { failure('Invalid native Codex listener'); void close().catch(() => {}); return; }
      const value = { url: match[1]!, token };
      try {
        socket = options.connect(value);
        socket.onClose(info => failure(info.reason));
        socket.onLine(receive);
        if (reason === undefined) { clearTimeout(timer); resolveEndpoint(value); resolveConnected(socket); }
      } catch { failure('Native Codex listener connection failed'); void close().catch(() => {}); }
      return;
    }
    for (const listener of diagnostics) listener(line);
  }
  native.onClose(info => failure(info.reason));
  native.onStderr?.(diagnostic); native.onLine(diagnostic);
  return {
    endpoint,
    nativeSqliteInitializationFailed: () => native.nativeSqliteInitializationFailed?.() ?? false,
    async writeLine(line) {
      if (reason !== undefined) throw new Error(reason);
      const bytes = Buffer.byteLength(line);
      if (pendingCount >= 256 || pendingBytes + bytes > 16 * 1024 * 1024) throw new Error('Native Codex send buffer exceeded');
      pendingCount++; pendingBytes += bytes;
      try { const transport = await connected; if (reason !== undefined) throw new Error(reason); await transport.writeLine(line); }
      finally { pendingCount--; pendingBytes -= bytes; }
    },
    onLine(listener) {
      lines.add(listener);
      if (!armed) { armed = true; const prior = queued.splice(0); queuedBytes = 0;
        for (const line of prior) { if (reason !== undefined) break; listener(line); } }
      return () => { lines.delete(listener); };
    },
    onStderr(listener) { diagnostics.add(listener); return () => { diagnostics.delete(listener); }; },
    onClose(listener) {
      closes.add(listener);
      if (reason !== undefined) queueMicrotask(() => { if (closes.has(listener)) listener({ reason: reason! }); });
      return () => { closes.delete(listener); };
    },
    close,
  };
}
