import type { Transport } from './app-server/transport.js';
import type { CodexNativeSessionHandle } from './native-input.js';
import type { CodexNativeApprovalFrontend, CodexNativeApprovalEvent } from './native-approvals.js';
import type { CodexNativeToolFrontend } from './native-dynamic-tools.js';
import type { AppServerHost } from './app-server/host.js';
import { AppServerRpcError } from './app-server/client.js';

type Id = string | number;
export interface CodexFrontendRequest { id: Id; method: string; params?: unknown }
export interface CodexFrontendNotification { method: string; params?: unknown }
export interface CodexFrontendCall {
  request: CodexFrontendRequest;
  signal: AbortSignal;
  /** One physical write on this connection. A lost receipt never retries. */
  forward(params?: unknown): Promise<unknown>;
  /** Explicit owning-client dispatch, mutually exclusive with forward().
   * beforeDispatch runs at the actual host write boundary. */
  dispatchToHost?(params?: unknown, beforeDispatch?: () => void): Promise<unknown>;
  /** Identity of that dispatcher, not a transport available to the native UI. */
  readonly owningHost?: Pick<AppServerHost, 'request'>;
}
export interface CodexNativeFrontendOptions {
  /** These are two connections, never the owning service's control transport. */
  frontend: Transport;
  upstream: Transport;
  handle: Pick<CodexNativeSessionHandle, 'attachNativeApprovalFrontend' | 'attachNativeToolFrontend'>;
  isCurrent(): boolean;
  /** Required task policy. It admits task input/controls before calling forward. */
  request(call: CodexFrontendCall): Promise<unknown>;
  /** Required task projection; null suppresses unrelated session data. */
  notification(event: CodexFrontendNotification): CodexFrontendNotification | null;
  /** Fresh task creation must use the officially subscribed owning host. The
   * native connection still performs its own genuine initialize/catalog RPCs. */
  owningHost?: { host: Pick<AppServerHost, 'request'>; timeoutMs: number };
  /** Already owner/scoped/bounded by the creation broker. When present, task
   * notifications come only from this stream, never the native side connection. */
  owningNotifications?: { subscribe(receive: (event: CodexFrontendNotification) => Promise<void>): () => void };
  /** Runs only after the actual successful response write, not policy return. */
  responseDelivered?(request: CodexFrontendRequest, result: unknown): void;
  closed?(): void;
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 256;
class NativeRpcError extends Error {
  constructor(readonly payload: Record<string, unknown>) { super('Native request failed'); }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isId(value: unknown): value is Id {
  return typeof value === 'string' ? value.length > 0 && value.length <= 256 : Number.isSafeInteger(value);
}

/**
 * Task-owned RPC relay. Every native server request is withheld: the existing
 * Agent remains its only responder. Policy-approved prompts and registered
 * tool executions are projected to the native UI. No raw native reply is ever
 * sent to app-server.
 */
export function connectCodexNativeFrontend(options: CodexNativeFrontendOptions): { close(): Promise<void> } {
  const lifetime = new AbortController();
  const active = new Map<Id, { forwarded: boolean }>();
  const waiting = new Map<Id, { resolve(value: unknown): void; reject(error: Error): void }>();
  const stops: Array<() => void> = [];
  let closing: Promise<void> | undefined;
  let approval: CodexNativeApprovalFrontend | undefined;
  let tools: CodexNativeToolFrontend | undefined;
  let initializeStarted = false, initializeCompleted = false, ready = false;
  const earlyApprovals: CodexNativeApprovalEvent[] = [];
  let pendingBytes = 0, earlyApprovalBytes = 0, requestSequence = 0;
  const current = () => { try { return !lifetime.signal.aborted && options.isCurrent(); } catch { return false; } };
  const assertCurrent = () => { if (!current()) throw new Error('Native frontend owner changed'); };
  const close = () => {
    if (closing) return closing;
    // Publish before observer/transport callbacks can re-enter close.
    closing = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => options.frontend.close()),
        Promise.resolve().then(() => options.upstream.close()),
      ]);
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    });
    lifetime.abort(); approval?.detach(); tools?.detach();
    try { options.closed?.(); } catch { /* Cleanup must still close both transports. */ }
    for (const stop of stops.splice(0)) stop();
    for (const request of waiting.values()) request.reject(new Error('Native frontend receipt unconfirmed'));
    waiting.clear(); active.clear(); earlyApprovals.length = 0; earlyApprovalBytes = 0;
    return closing;
  };
  const fail = () => { void close().catch(() => {}); };
  const send = (value: unknown): Promise<boolean> => {
    if (!current()) { fail(); return Promise.resolve(false); }
    let line: string;
    try { line = JSON.stringify(value); } catch { fail(); return Promise.resolve(false); }
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { fail(); return Promise.resolve(false); }
    return Promise.resolve().then(() => { assertCurrent(); return options.frontend.writeLine(line); })
      .then(() => current(), () => { fail(); return false; });
  };
  const parse = (line: string): Record<string, unknown> | null => {
    if (!current() || Buffer.byteLength(line) > MAX_FRAME_BYTES) { fail(); return null; }
    try { const value: unknown = JSON.parse(line); if (record(value)) return value; } catch { /* Protocol framing only. */ }
    fail(); return null;
  };
  const publishApproval = (event: CodexNativeApprovalEvent) => {
    if (!current()) { fail(); return; }
    if (!ready) {
      let bytes: number;
      try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { fail(); return; }
      if (earlyApprovals.length >= MAX_PENDING || earlyApprovalBytes + bytes > MAX_FRAME_BYTES) { fail(); return; }
      earlyApprovalBytes += bytes;
      earlyApprovals.push(event); return;
    }
    if (event.kind === 'request') send(event.request);
    else send({ method: 'serverRequest/resolved', params: { threadId: event.threadId, requestId: event.id } });
  };
  const upstreamLine = (line: string) => {
    const value = parse(line); if (!value) return;
    if (typeof value.method === 'string') {
      // Even unimplemented/new native requests stay with the existing host;
      // forwarding them directly would race the host's permission decision.
      if ('id' in value) return;
      if (options.owningNotifications) return;
      try {
        const projected = options.notification({ method: value.method, ...('params' in value ? { params: value.params } : {}) });
        if (projected) send(projected);
      } catch { fail(); }
      return;
    }
    if (!isId(value.id)) { fail(); return; }
    const request = waiting.get(value.id);
    if (!request) return; // Late/unsolicited receipt cannot satisfy another call.
    waiting.delete(value.id);
    if (record(value.error)) request.reject(new NativeRpcError(value.error));
    else if ('result' in value) request.resolve(value.result);
    else { request.reject(new Error('Malformed native response')); fail(); }
  };
  const frontendLine = (line: string) => {
    const value = parse(line); if (!value) return;
    if (!('method' in value)) {
      if (!isId(value.id)) { fail(); return; }
      // Replies settle only the current admitted prompt or executor call;
      // they never answer an arbitrary upstream server request.
      if (!approval?.answer(value.id, value.result)) tools?.answer(value.id, value.result);
      return;
    }
    if (typeof value.method !== 'string' || !value.method || value.method.length > 256) { fail(); return; }
    if (!('id' in value)) {
      // Codex's only client notification is the initialize acknowledgement.
      if (value.method !== 'initialized' || !initializeCompleted || ready) { fail(); return; }
      ready = true;
      try { void options.upstream.writeLine(JSON.stringify({ method: 'initialized' })).catch(fail); } catch { fail(); }
      tools?.ready();
      earlyApprovalBytes = 0;
      for (const event of earlyApprovals.splice(0)) publishApproval(event);
      return;
    }
    if (!isId(value.id) || active.has(value.id) || active.size >= MAX_PENDING) { fail(); return; }
    if (value.method === 'initialize') {
      if (initializeStarted) { fail(); return; }
      initializeStarted = true;
    } else if (!ready) { fail(); return; }
    const bytes = Buffer.byteLength(line);
    if (pendingBytes + bytes > MAX_FRAME_BYTES) { fail(); return; }
    const request: CodexFrontendRequest = { id: value.id, method: value.method, ...('params' in value ? { params: value.params } : {}) };
    const entry = { forwarded: false };
    active.set(request.id, entry); pendingBytes += bytes;
    const claimDispatch = () => {
      assertCurrent();
      if (entry.forwarded || active.get(request.id) !== entry) throw new Error('Native request already forwarded or retired');
      entry.forwarded = true;
    };
    const forward = async (params: unknown = request.params): Promise<unknown> => {
      claimDispatch();
      // Frontends may reuse a completed request id. Use a unique upstream id so
      // a late duplicate receipt can never complete that later native request.
      if (requestSequence >= Number.MAX_SAFE_INTEGER) { fail(); throw new Error('Native request sequence exhausted'); }
      const wireId = 'lex-tui:' + (++requestSequence);
      const payload = JSON.stringify({ ...request, id: wireId, params });
      if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) throw new Error('Native request exceeded transport limit');
      return new Promise((resolve, reject) => {
        waiting.set(wireId, { resolve, reject });
        void Promise.resolve().then(() => { assertCurrent(); return options.upstream.writeLine(payload); }).catch(() => {
          const pending = waiting.get(wireId); waiting.delete(wireId);
          pending?.reject(new Error('Native frontend receipt unconfirmed'));
          // Close this connection, never replay or close the owning service.
          fail();
        });
      });
    };
    const dispatchToHost = options.owningHost ? async (params: unknown = request.params, beforeDispatch?: () => void): Promise<unknown> => {
      claimDispatch();
      return options.owningHost!.host.request(request.method, params, {
        timeoutMs: options.owningHost!.timeoutMs,
        beforeDispatch: () => { assertCurrent(); beforeDispatch?.(); },
      });
    } : undefined;
    void Promise.resolve().then(() => {
      assertCurrent(); return options.request({ request, signal: lifetime.signal, forward,
        ...(dispatchToHost ? { dispatchToHost, owningHost: options.owningHost!.host } : {}) });
    }).then(async result => {
      if (request.method === 'initialize') initializeCompleted = true;
      if (current() && await send({ id: request.id, result })) {
        assertCurrent(); options.responseDelivered?.(request, result);
      }
    }, error => {
      if (current()) return send({ id: request.id, error: error instanceof AppServerRpcError ? error.rpcError : error instanceof NativeRpcError ? error.payload
        : { code: -32600, message: 'This native action could not be accepted by the current Lex task.' } });
    }).catch(fail).finally(() => { if (active.get(request.id) === entry) active.delete(request.id); pendingBytes -= bytes; });
  };
  try {
    assertCurrent();
    if (options.owningHost && (!Number.isFinite(options.owningHost.timeoutMs) || options.owningHost.timeoutMs <= 0)) {
      throw new Error('Invalid owning-host RPC deadline');
    }
    approval = options.handle.attachNativeApprovalFrontend(publishApproval);
    tools = options.handle.attachNativeToolFrontend?.(event => event.kind === 'request' ? send(event.request)
      : send({ method: 'serverRequest/resolved', params: { threadId: event.threadId, requestId: event.id } }));
    if (lifetime.signal.aborted) { approval.detach(); throw new Error('Native frontend retired during attachment'); }
    const subscribe = (stop: () => void) => { if (lifetime.signal.aborted) stop(); else stops.push(stop); };
    subscribe(options.upstream.onClose(fail)); subscribe(options.frontend.onClose(fail));
    subscribe(options.upstream.onLine(upstreamLine)); subscribe(options.frontend.onLine(frontendLine));
    if (options.owningNotifications) {
      subscribe(options.owningNotifications.subscribe(async event => {
        if (!await send(event)) throw new Error('Native notification delivery unconfirmed');
      }));
    }
    assertCurrent();
  } catch (error) { fail(); throw error; }
  return { close };
}
