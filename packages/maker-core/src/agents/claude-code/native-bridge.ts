import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface ClaudeBridgeEvent {
  sequence: number;
  kind: string;
  value: unknown;
}

export interface ClaudeNativeRequest {
  requestId: string;
  kind: string;
  input: unknown;
}

export interface ClaudeNativeBridgeOptions {
  sessionId: string;
  /** Synchronous acceptance into the task's event queue. Never perform UI work here. */
  onEvent(event: ClaudeBridgeEvent): void;
  /** Implemented by the existing host policy/interaction path, not by a renderer. */
  onRequest(request: ClaudeNativeRequest, signal: AbortSignal): Promise<unknown>;
  /** No request bodies, credentials or upstream error text are exposed here. */
  onFault(reason: 'event-gap' | 'event-overflow' | 'event-handler' | 'transport'): void;
}

interface PendingCommand {
  command: { id: number; kind: string; payload: unknown };
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
  controller: AbortController;
  result: Promise<unknown>;
  fingerprint?: string;
  settled: boolean;
  polls: number;
}

/** Authenticated, task-scoped side channel for the original interactive Claude process. */
export class ClaudeNativeBridge {
  private readonly options: ClaudeNativeBridgeOptions;
  readonly generation = randomUUID();
  private readonly token = randomBytes(32).toString('hex');
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  private readonly commands = new Map<number, PendingCommand>();
  private readonly requests = new Map<string, PendingRequest>();
  private requestFloor = 0;
  private nextCommand = 0;
  private lastEvent = 0;
  private faulted = false;
  private closed = false;
  private endpoint?: string;
  private starting?: Promise<string>;
  private closing?: Promise<void>;

  constructor(options: ClaudeNativeBridgeOptions) {
    this.options = options;
    if (!options.sessionId) throw new Error('Native session identity is required');
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.maxHeadersCount = 16;
    this.server.on('error', () => { if (this.endpoint && !this.closed) this.fail('transport'); });
  }

  start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Native bridge closed'));
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const fail = (error: Error) => { this.server.off('error', fail); reject(error); };
      this.server.once('error', fail);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', fail);
        const address = this.server.address() as AddressInfo;
        this.endpoint = `http://127.0.0.1:${address.port}`;
        resolve(this.endpoint);
      });
    });
    return this.starting;
  }

  /** Only for the owned child environment. Never serialize this to GUI or diagnostics. */
  environment(): Record<string, string> {
    if (!this.endpoint || this.closed) throw new Error('Native bridge is not listening');
    return { LEX_CLAUDE_BRIDGE_URL: this.endpoint, LEX_CLAUDE_BRIDGE_TOKEN: this.token,
      LEX_CLAUDE_BRIDGE_GENERATION: this.generation, LEX_CLAUDE_BRIDGE_SESSION: this.options.sessionId };
  }

  command(kind: string, payload: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (!this.endpoint || this.closed || this.faulted) return Promise.reject(new Error('Native bridge unavailable'));
    if (this.commands.size >= 128) return Promise.reject(new Error('Native command queue full'));
    if (!kind || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Invalid native command'));
    // Freeze at enqueue time: callers cannot change an already dispatched command.
    let ownedPayload: unknown;
    try {
      const encoded = JSON.stringify(payload);
      if (encoded === undefined || Buffer.byteLength(encoded) > 1_048_576) throw new Error();
      ownedPayload = JSON.parse(encoded);
    } catch { return Promise.reject(new Error('Invalid native command payload')); }
    const id = ++this.nextCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(id);
        // A lost receipt is not proof that the command was unexecuted. Never retry automatically.
        reject(new Error('Native command outcome unconfirmed'));
      }, timeoutMs);
      timer.unref();
      this.commands.set(id, { command: { id, kind, payload: ownedPayload }, resolve, reject, timer });
    });
  }

  /** Cancels only this native callback, e.g. on a matching tool/turn completion. */
  retireRequest(requestId: string): void {
    if (!validRequestId(requestId) || this.closed) return;
    const existing = this.requests.get(requestId);
    if (existing) { existing.controller.abort(); return; }
    if (!this.makeRequestSpace(Number(requestId))) return;
    // The event and long-poll use different connections. Retirement may arrive first.
    const controller = new AbortController();
    controller.abort();
    this.requests.set(requestId, { controller, settled: true, polls: 0, result: Promise.resolve({ retired: true }) });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      await this.starting?.catch(() => {});
      if (!this.server.listening) return;
      const closing = new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.server.closeAllConnections();
      await closing;
    });
    for (const pending of this.commands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Native bridge closed'));
    }
    this.commands.clear();
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    return this.closing;
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.endpoint || this.closed || req.method !== 'POST' || req.headers.origin !== undefined) return false;
    if (req.headers.host !== new URL(this.endpoint).host || req.socket.remoteAddress !== '127.0.0.1') return false;
    const value = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    return value.length === expected.length && timingSafeEqual(value, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) { res.writeHead(403); res.end(); return; }
    const body = await readBody(req);
    if (body.generation !== this.generation || body.sessionId !== this.options.sessionId || this.closed) {
      respond(res, 409, { error: 'stale-runtime' }); return;
    }
    if (req.url === '/exchange') {
      this.exchange(body, res); return;
    }
    if (req.url === '/request') {
      await this.request(body, res); return;
    }
    respond(res, 404, { error: 'unknown-operation' });
  }

  private exchange(body: Record<string, unknown>, res: ServerResponse): void {
    if (!Array.isArray(body.events) || body.events.length > 256) throw new Error('Invalid native event batch');
    if (body.overflow === true) this.fail('event-overflow');
    for (const raw of body.events) {
      const event = record(raw);
      if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1 || typeof event.kind !== 'string') {
        throw new Error('Invalid native event');
      }
      const sequence = event.sequence as number;
      if (sequence <= this.lastEvent) continue;
      if (sequence !== this.lastEvent + 1) { this.fail('event-gap'); break; }
      if (this.faulted) break;
      try { this.options.onEvent(event as unknown as ClaudeBridgeEvent); }
      catch { this.fail('event-handler'); break; }
      this.lastEvent = sequence;
      if (event.kind === 'command-result') {
        const value = record(event.value);
        const pending = this.commands.get(value.id as number);
        if (pending) {
          this.commands.delete(pending.command.id);
          clearTimeout(pending.timer);
          if (value.ok === true) pending.resolve(value.result);
          else pending.reject(new Error('Native command rejected'));
        }
      }
      if (event.kind === 'request-retired') {
        const value = record(event.value);
        if (typeof value.requestId === 'string') this.retireRequest(value.requestId);
      }
    }
    respond(res, 200, { acknowledged: this.lastEvent, faulted: this.faulted,
      commands: this.faulted ? [] : [...this.commands.values()].slice(0, 32).map((entry) => entry.command) });
  }

  private async request(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request = record(body.request);
    const { requestId, kind, input } = request;
    if (typeof requestId !== 'string' || !validRequestId(requestId) || typeof kind !== 'string' || !kind) {
      throw new Error('Invalid native request');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, input })).digest('hex');
    let pending = this.requests.get(requestId);
    if (pending?.controller.signal.aborted || this.faulted) { respond(res, 200, { retired: true }); return; }
    if (pending && pending.fingerprint !== fingerprint) { respond(res, 409, { error: 'request-identity-conflict' }); return; }
    if (!pending) {
      const ordinal = Number(requestId);
      if (!this.makeRequestSpace(ordinal)) { respond(res, 409, { error: 'request-unavailable' }); return; }
      const controller = new AbortController();
      const result = new Promise<unknown>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ retired: true }), { once: true });
        void Promise.resolve().then(() => controller.signal.aborted ? undefined
          : this.options.onRequest({ requestId, kind, input }, controller.signal))
          .then((value) => resolve(controller.signal.aborted ? { retired: true } : { result: value }),
            () => resolve({ error: 'host-request-failed' }));
      });
      pending = { controller, result, settled: false, fingerprint, polls: 0 };
      this.requests.set(requestId, pending);
      const captured = pending;
      void result.then(() => { captured.settled = true; });
    }
    if (pending.polls >= 2) { respond(res, 429, { error: 'poll-already-pending' }); return; }
    pending.polls++;
    // HTTP long-poll is a native host call: unlike a raw Promise it does not
    // consume the Mod's execution budget. Bound each connection, not human time.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<unknown>((resolve) => { timer = setTimeout(() => resolve({ pending: true }), 20_000); timer.unref(); });
    let disconnected!: () => void;
    const connection = new Promise<unknown>((resolve) => { disconnected = () => resolve(undefined); });
    res.once('close', disconnected);
    try {
      const result = await Promise.race([pending.result, timeout, connection]);
      respond(res, 200, pending.controller.signal.aborted ? { retired: true } : result);
    } finally {
      pending.polls--;
      res.off('close', disconnected);
      if (timer) clearTimeout(timer);
    }
  }

  private makeRequestSpace(ordinal: number): boolean {
    if (this.requests.size >= 128) {
      for (const [id, entry] of this.requests) {
        if (entry.settled && entry.polls === 0) {
          this.requests.delete(id);
          this.requestFloor = Math.max(this.requestFloor, Number(id));
        }
      }
    }
    // A delayed unknown request below the retired window is rejected, never recreated.
    return ordinal > this.requestFloor && this.requests.size < 128;
  }

  private fail(reason: Parameters<ClaudeNativeBridgeOptions['onFault']>[0]): void {
    if (this.faulted) return;
    this.faulted = true;
    for (const pending of this.commands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Native command outcome unconfirmed'));
    }
    this.commands.clear();
    for (const request of this.requests.values()) request.controller.abort();
    try { this.options.onFault(reason); } catch { /* Diagnostics cannot break native delivery or cleanup. */ }
  }
}

function validRequestId(value: string): boolean {
  return /^[1-9][0-9]{0,14}$/.test(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Native request too large');
    chunks.push(Buffer.from(chunk));
  }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
