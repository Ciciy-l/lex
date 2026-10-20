import type { AppServerHost, AppServerNotification, CodexNativeNotificationReceipt } from './app-server/host.js';
import type { ThreadStartParams, ThreadStartResponse } from './app-server/protocol.js';
import type { CodexFrontendCall, CodexFrontendNotification, CodexFrontendRequest } from './native-frontend.js';
import { isCodexNativeTaskCwd } from './native-task-cwd.js';
import { projectCodexNativeTaskInventory } from './native-task-inventory.js';

const MAX_EVENTS = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOTSTRAP_READS = new Set(['account/read', 'account/rateLimits/read', 'config/read', 'configRequirements/read',
  'model/list', 'mcpServerStatus/list', 'collaborationMode/list', 'skills/list', 'plugin/list', 'hooks/list']);
type Failure = 'owner-changed' | 'deadline' | 'frontend-exit' | 'overrun' | 'delivery-failed' | 'creation-failed';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A receipt can fail before Core/Main has reached the corresponding phase.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One local Session/account/generation owns one genuine native fresh start.
 *
 * created settles at the owning host ACK so Core can return its normal handle.
 * start keeps the native request pending until Main releases the binding gate.
 * responseDelivered is a separate transport receipt, never a fabricated ACK.
 * No method in this class retries, resumes, deletes, or closes the shared host.
 */
export class CodexNativeTaskCreation {
  private readonly lifetime = new AbortController();
  private readonly creation = deferred<ThreadStartResponse>();
  private readonly bindings = deferred<void>();
  private readonly presentation = deferred<void>();
  readonly created = this.creation.promise;
  readonly ready = this.presentation.promise;
  readonly signal = this.lifetime.signal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly stopObserving: () => void;
  private readonly ownerAborted: () => void;
  private readonly notificationReceipt?: CodexNativeNotificationReceipt;
  private nativeAborted?: () => void;
  private nativeSignal?: AbortSignal;
  private receiver?: (event: CodexFrontendNotification) => Promise<void>;
  private queue: Array<{ id: string; line: string; bytes: number }> = [];
  private bytes = 0;
  private draining = false;
  private started = false;
  private bindingReady = false;
  private delivered = false;
  private request?: CodexFrontendRequest;
  private ack?: ThreadStartResponse;
  private failure?: Failure;
  private dispatched = false;

  constructor(private readonly options: {
    host: Pick<AppServerHost, 'request' | 'observeNotifications' | 'captureNativeNotificationReceipt'>;
    /** Must include both the local owner generation and the service lease. */
    signal: AbortSignal;
    isCurrent(): boolean;
    timeoutMs: number;
    dispatchContext?<T>(run: () => Promise<T>): Promise<T>;
    onDispatched?(): void;
    onUnavailable?(reason: Failure): void;
  }) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid native creation deadline');
    this.ownerAborted = () => this.fail('owner-changed');
    this.notificationReceipt = options.host.captureNativeNotificationReceipt();
    this.timer = setTimeout(() => this.fail('deadline'), options.timeoutMs);
    this.timer.unref?.();
    this.stopObserving = options.host.observeNotifications(event => this.observe(event));
    options.signal.addEventListener('abort', this.ownerAborted, { once: true });
    this.notificationReceipt?.signal.addEventListener('abort', this.ownerAborted, { once: true });
    if (options.signal.aborted || !this.current()) this.fail('owner-changed');
  }

  get threadId(): string | undefined { return this.ack?.thread.id; }
  get uncertain(): boolean { return this.failure !== undefined; }
  /** Dispatch is sticky even if no ACK is received. There is no recreate path. */
  get requestDispatched(): boolean { return this.dispatched; }
  get inputReady(): boolean { return this.bindingReady && this.delivered && this.current(); }

  private current(): boolean {
    try { return !this.signal.aborted && !this.options.signal.aborted && this.options.isCurrent()
      && (!this.notificationReceipt || this.notificationReceipt.isCurrent()); } catch { return false; }
  }
  private check(): void {
    if (!this.current()) { this.fail('owner-changed'); throw new Error('Native task creation owner is no longer current'); }
  }
  private wait<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('Native task creation receipt unconfirmed'));
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
      void work.then(resolve, reject).finally(() => this.signal.removeEventListener('abort', abort));
    });
  }

  async route(call: CodexFrontendCall, policy: {
    cwd: string;
    prepareStart(params: Record<string, unknown>): Promise<ThreadStartParams>;
    /** Existing audited catalog projection; never an unrestricted raw forward. */
    catalog(call: CodexFrontendCall): Promise<unknown>;
    bound(call: CodexFrontendCall): Promise<unknown>;
  }): Promise<unknown> {
    this.check();
    const params = call.request.params ?? {};
    if (!record(params)) throw new Error('Invalid native bootstrap parameters');
    const method = call.request.method;
    // After the genuine ACK is delivered, the bound task router owns target
    // admission (including legitimate title/helper operations).
    if (this.inputReady) return policy.bound(call);
    if (method === 'initialize') return call.forward();
    if (method === 'thread/list' || method === 'thread/loaded/list') {
      if (params.cwd != null && !isCodexNativeTaskCwd(policy.cwd, params.cwd)) {
        throw new Error('Native inventory has another working directory');
      }
      const page = await this.wait(call.forward(params.cwd == null ? params : { ...params, cwd: policy.cwd }));
      this.check();
      // These reads can race the pending start. Only its genuine ACK may
      // establish visibility; inventory never creates or adopts a thread.
      if (this.started && !this.threadId) await this.wait(this.created);
      this.check();
      return projectCodexNativeTaskInventory(page, id => id === this.threadId);
    }
    if (BOOTSTRAP_READS.has(method)) {
      if ((params.threadId != null && params.threadId !== this.threadId)
        || (params.cwd != null && !isCodexNativeTaskCwd(policy.cwd, params.cwd))
        || (params.cwds != null && (!Array.isArray(params.cwds) || params.cwds.length !== 1 || !isCodexNativeTaskCwd(policy.cwd, params.cwds[0])))
        || (method === 'account/read' && params.refreshToken === true)) throw new Error('Native bootstrap catalog is outside its owner');
      const normalized = { ...params,
        ...(params.cwd != null ? { cwd: policy.cwd } : {}), ...(params.cwds != null ? { cwds: [policy.cwd] } : {}),
      };
      return policy.catalog({ ...call, request: { ...call.request, params: normalized },
        forward: (prepared = normalized) => call.forward(prepared) });
    }
    if (method === 'thread/start') return this.start(call, () => policy.prepareStart(params));
    if (!this.inputReady || params.threadId !== this.threadId) throw new Error('Native task bindings are not ready or are outside scope');
    return policy.bound(call);
  }

  async start(call: CodexFrontendCall, prepare: ThreadStartParams | (() => Promise<ThreadStartParams>)): Promise<ThreadStartResponse> {
    this.check();
    if (this.started || call.request.method !== 'thread/start' || !call.dispatchToHost || call.owningHost !== this.options.host) {
      throw new Error('Native task creation is already reserved or has no owning dispatcher');
    }
    this.started = true; this.request = call.request;
    this.nativeSignal = call.signal; this.nativeAborted = () => this.fail('frontend-exit');
    call.signal.addEventListener('abort', this.nativeAborted, { once: true });
    if (call.signal.aborted) this.fail('frontend-exit');
    try {
      this.check();
      if (!this.notificationReceipt?.isCurrent()) throw new Error('Owning host has no complete native initialization receipt');
      const params = typeof prepare === 'function' ? await this.wait(prepare()) : prepare;
      this.check();
      const dispatch = () => call.dispatchToHost!(params, () => {
        this.check(); this.dispatched = true; this.options.onDispatched?.();
      });
      const value = await this.wait(this.options.dispatchContext ? this.options.dispatchContext(dispatch) : dispatch());
      this.check();
      if (!record(value) || !record(value.thread) || typeof value.thread.id !== 'string' || !THREAD_ID.test(value.thread.id)) {
        throw new Error('Invalid genuine thread/start receipt');
      }
      this.ack = value as unknown as ThreadStartResponse;
      this.queue = this.queue.filter(event => event.id === this.threadId);
      this.bytes = this.queue.reduce((total, event) => total + event.bytes, 0);
      this.creation.resolve(this.ack);
      await this.wait(this.bindings.promise);
      this.check();
      return this.ack;
    } catch (error) { this.fail('creation-failed', error instanceof Error ? error : undefined); throw error; }
  }

  /** Called at the actual Main startup receipt, after the handle has returned. */
  releaseAfterBindings(): void {
    this.check();
    if (!this.ack) throw new Error('Cannot release native input before the owning thread ACK');
    this.bindingReady = true; this.bindings.resolve();
  }

  /** Call only from connectCodexNativeFrontend.responseDelivered. */
  responseDelivered(request: CodexFrontendRequest, value: unknown): void {
    if (request !== this.request || value !== this.ack || !this.bindingReady || !this.current()) return;
    this.delivered = true;
    this.drain();
  }

  subscribe(receive: (event: CodexFrontendNotification) => Promise<void>): () => void {
    this.check();
    if (this.receiver) throw new Error('Native creation already has a frontend');
    this.receiver = receive; this.drain();
    return () => { if (this.receiver === receive) { this.receiver = undefined; this.fail('frontend-exit'); } };
  }

  private observe(event: AppServerNotification): void {
    if (!this.current()) { this.fail('owner-changed'); return; }
    if (!record(event.params)) return; // No service/account-global fan-out.
    const id = event.method === 'thread/started'
      ? record(event.params.thread) ? event.params.thread.id : undefined : event.params.threadId;
    if (typeof id !== 'string' || !THREAD_ID.test(id) || (this.threadId && id !== this.threadId)) return;
    // Before the actual ACK we cannot infer an owner from arrival order. Buffer
    // bounded original frames, then retain only the ACK's exact thread identity.
    try {
      const line = JSON.stringify(event), bytes = Buffer.byteLength(line);
      if (this.queue.length >= MAX_EVENTS || bytes + this.bytes > MAX_BYTES) { this.fail('overrun'); return; }
      this.queue.push({ id, line, bytes }); this.bytes += bytes; this.drain();
    } catch { this.fail('delivery-failed'); }
  }

  private drain(): void {
    if (this.draining || !this.delivered || !this.receiver || !this.current()) return;
    this.draining = true;
    void (async () => {
      while (this.queue.length) {
        this.check();
        const event = this.queue[0]!;
        await this.wait(this.receiver!(JSON.parse(event.line) as CodexFrontendNotification));
        this.check();
        this.queue.shift(); this.bytes -= event.bytes;
      }
      this.check(); clearTimeout(this.timer); this.presentation.resolve();
    })().catch(() => this.fail('delivery-failed')).finally(() => {
      this.draining = false;
      // A ready observer may enqueue after the empty check but before this cleanup.
      if (this.queue.length) this.drain();
    });
  }

  close(): void { this.fail('frontend-exit'); }
  private fail(reason: Failure, cause?: Error): void {
    if (this.failure) return;
    this.failure = reason; clearTimeout(this.timer);
    this.stopObserving(); this.options.signal.removeEventListener('abort', this.ownerAborted);
    this.notificationReceipt?.signal.removeEventListener('abort', this.ownerAborted);
    if (this.nativeAborted) this.nativeSignal?.removeEventListener('abort', this.nativeAborted);
    this.lifetime.abort(); this.queue.length = 0; this.bytes = 0;
    const error = cause ?? new Error('Native task creation or delivery is unconfirmed');
    this.creation.reject(error); this.bindings.reject(error); this.presentation.reject(error);
    try { this.options.onUnavailable?.(reason); } catch { /* Never affect the shared host. */ }
  }
}
