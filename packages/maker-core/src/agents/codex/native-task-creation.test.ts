import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { AppServerHost } from './app-server/host.js';
import { AppServerRpcError } from './app-server/client.js';
import type { Logger } from '../../interfaces/logger.js';
import type { Transport, LineHandler, CloseHandler } from './app-server/transport.js';
import type { ThreadStartParams } from './app-server/protocol.js';
import { CodexNativeApprovals } from './native-approvals.js';
import { connectCodexNativeFrontend, type CodexFrontendCall } from './native-frontend.js';
import { CodexNativeTaskCreation } from './native-task-creation.js';

const OWNED = '019d6540-0134-7238-8cb3-4a833b083e2a';
const FOREIGN = '019d6540-0134-7238-8cb3-4a833b083e2b';
const CHILD = '019d6540-0134-7238-8cb3-4a833b083e2c';
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const tick = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
type Frame = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
class Wire implements Transport {
  readonly sent: Frame[] = [];
  readonly lines = new Set<LineHandler>();
  readonly closes = new Set<CloseHandler>();
  closed = false;
  beforeWrite?: (frame: Frame) => Promise<void>;
  constructor(public respond?: (frame: Frame) => void) {}
  async writeLine(line: string) {
    const frame = JSON.parse(line) as Frame;
    await this.beforeWrite?.(frame);
    if (this.closed) throw new Error('fixture wire closed');
    this.sent.push(frame); this.respond?.(frame);
  }
  onLine(handler: LineHandler) { this.lines.add(handler); return () => { this.lines.delete(handler); }; }
  onClose(handler: CloseHandler) { this.closes.add(handler); return () => { this.closes.delete(handler); }; }
  emit(frame: Frame) { for (const handler of this.lines) handler(JSON.stringify(frame)); }
  async close() { if (this.closed) return; this.closed = true; for (const handler of this.closes) handler({ reason: 'fixture exit' }); }
}
const params: ThreadStartParams = { cwd: '/task', model: 'gpt-6-astra', modelProvider: 'loopback',
  dynamicTools: [{ type: 'function', name: 'existing-core-tool', description: 'existing', inputSchema: { type: 'object' } }] };
async function fixture(timeoutMs = 30_000, optOutNotificationMethods?: string[], nativeProfile = true) {
  const ownerWire = new Wire(frame => {
    if (frame.method === 'initialize') ownerWire.emit({ id: frame.id, result: { userAgent: 'codex/fixture', codexHome: '/isolated' } });
    else if (frame.id != null && frame.method !== 'thread/start') ownerWire.emit({ id: frame.id, result: {} });
  });
  const upstream = new Wire(frame => { if (frame.id != null) upstream.emit({ id: frame.id, result: {} }); });
  const frontend = new Wire(), approvals = new CodexNativeApprovals();
  const host = new AppServerHost({ createTransport: () => ownerWire, logger, clientInfo: { name: 'a1-fixture', version: '1' },
    ...(nativeProfile ? { notificationProfile: 'native-presentation' as const } : {}) });
  await host.ensureStarted(optOutNotificationMethods ? { optOutNotificationMethods } : undefined);
  const owner = new AbortController(); let current = true;
  let link: ReturnType<typeof connectCodexNativeFrontend> | undefined;
  const unavailable: string[] = [];
  const creation = new CodexNativeTaskCreation({ host, signal: owner.signal, isCurrent: () => current, timeoutMs,
    onUnavailable: reason => { unavailable.push(reason); void link?.close(); } });
  let nativeStart: CodexFrontendCall | undefined;
  const policy = { cwd: '/task', prepareStart: async () => params,
    catalog: (call: CodexFrontendCall) => call.forward(),
    bound: (call: CodexFrontendCall) => call.dispatchToHost!() };
  link = connectCodexNativeFrontend({ frontend, upstream,
    handle: { attachNativeApprovalFrontend: receive => approvals.attach(receive) },
    isCurrent: () => current && !creation.signal.aborted, owningHost: { host, timeoutMs },
    request: call => { if (call.request.method === 'thread/start') nativeStart = call; return creation.route(call, policy); },
    notification: event => event, owningNotifications: { subscribe: receive => creation.subscribe(receive) },
    responseDelivered: (request, value) => creation.responseDelivered(request, value),
    closed: () => creation.close(),
  });
  frontend.emit({ id: 'init', method: 'initialize' }); await tick();
  frontend.emit({ method: 'initialized' }); await tick(); frontend.sent.length = 0; upstream.sent.length = 0;
  const start = async (id: number | string = 1) => { frontend.emit({ id, method: 'thread/start', params: { ephemeral: false } }); await tick(); };
  const ack = async () => {
    const request = ownerWire.sent.find(frame => frame.method === 'thread/start'); assert.ok(request);
    ownerWire.emit({ id: request.id, result: { thread: { id: OWNED, turns: [], name: null, ephemeral: false, historyMode: 'paginated' },
      model: 'gpt-6-astra', modelProvider: 'loopback', cwd: '/task' } }); await tick();
  };
  return { ownerWire, frontend, upstream, host, creation, owner, unavailable, policy, start, ack, approvals,
    get nativeStart() { return nativeStart; }, expire() { current = false; },
    async close() { creation.close(); await link!.close(); await host.shutdown(); } };
}

describe('owning-host native fresh task creation', () => {
  it('returns the real host receipt to Core before Main bindings and the native ACK, without a name/read/resume/turn', async () => {
    const f = await fixture();
    try {
      await f.start(); await f.ack();
      const actual = await f.creation.created; assert.equal(actual.thread.id, OWNED);
      assert.equal(f.creation.inputReady, false); assert.deepEqual(f.frontend.sent, []);
      assert.deepEqual(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').map(frame => frame.params), [params]);
      assert.deepEqual(f.upstream.sent, []);
      f.creation.releaseAfterBindings(); await tick(); await f.creation.ready;
      assert.deepEqual(f.frontend.sent, [{ id: 1, result: actual }]); assert.equal(f.creation.inputReady, true);
      assert.deepEqual(f.ownerWire.sent.filter(frame => frame.method && frame.method !== 'initialize' && frame.method !== 'initialized').map(frame => frame.method), ['thread/start']);
      const initialize = f.ownerWire.sent.find(frame => frame.method === 'initialize')!;
      assert.deepEqual((initialize.params as { capabilities: { optOutNotificationMethods: string[] } }).capabilities.optOutNotificationMethods, []);
    } finally { await f.close(); }
  });

  it('keeps early raw task events in order after the ACK, excluding other threads, descendants and service-global data', async () => {
    const f = await fixture();
    try {
      await f.start();
      const emit = (id: string, delta: string) => f.ownerWire.emit({ method: 'item/commandExecution/outputDelta', params: { threadId: id, delta } });
      emit(FOREIGN, 'private'); emit(OWNED, 'first'); emit(CHILD, 'child-private');
      f.ownerWire.emit({ method: 'account/updated', params: { account: 'private' } });
      await f.ack(); emit(FOREIGN, 'later-private'); emit(OWNED, 'second');
      f.upstream.emit({ method: 'item/commandExecution/outputDelta', params: { threadId: OWNED, delta: 'duplicate' } });
      f.creation.releaseAfterBindings(); await tick(); await f.creation.ready;
      assert.deepEqual(f.frontend.sent.map(frame => frame.method ?? 'ACK'), ['ACK', 'item/commandExecution/outputDelta', 'item/commandExecution/outputDelta']);
      assert.deepEqual(f.frontend.sent.slice(1).map(frame => frame.params), [{ threadId: OWNED, delta: 'first' }, { threadId: OWNED, delta: 'second' }]);
      emit(OWNED, 'third'); await tick(); assert.equal((f.frontend.sent.at(-1)!.params as { delta: string }).delta, 'third');
    } finally { await f.close(); }
  });

  it('delivers the sole own-thread event emitted by a pre-registered ready observer exactly once after the ACK', async () => {
    const f = await fixture();
    try {
      const event = { method: 'item/commandExecution/outputDelta', params: { threadId: OWNED, delta: 'only-ready-event' } };
      // Register before release: this callback runs before drain's chained finally.
      const emitted = f.creation.ready.then(() => { f.ownerWire.emit(event); });
      void emitted.catch(() => {});
      await f.start(); await f.ack();
      const actual = await f.creation.created;
      assert.deepEqual(f.frontend.sent, []);
      f.creation.releaseAfterBindings();
      await emitted;
      // One scheduler boundary, not a sleep or polling loop. Fixture writes and
      // the entire drain chain settle in microtasks before this callback.
      await new Promise<void>(resolve => { setImmediate(resolve); });
      assert.deepEqual(f.frontend.sent, [{ id: 1, result: actual }, event]);
      assert.equal(f.creation.inputReady, true);
      assert.deepEqual(f.unavailable, []);
      assert.equal(f.ownerWire.closed, false);
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1);
    } finally { await f.close(); }
  });

  it('admits no turn or foreign/catalog scope before binding, then uses the same owning host for the first turn', async () => {
    const f = await fixture();
    try {
      await f.start(); await f.ack();
      for (const frame of [
        { id: 2, method: 'turn/start', params: { threadId: OWNED, input: [] } },
        { id: 3, method: 'thread/read', params: { threadId: FOREIGN } },
        { id: 4, method: 'config/read', params: { cwd: '/other' } },
        { id: 5, method: 'account/read', params: { refreshToken: true } },
      ]) f.frontend.emit(frame);
      await tick(); assert.equal(f.frontend.sent.filter(frame => frame.error).length, 4);
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'turn/start').length, 0); assert.deepEqual(f.upstream.sent, []);
      f.creation.releaseAfterBindings(); await tick();
      f.frontend.emit({ id: 6, method: 'turn/start', params: { threadId: OWNED, input: [{ type: 'text', text: 'first actual user input' }] } });
      await tick();
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1);
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'turn/start').length, 1);
      assert.deepEqual(f.upstream.sent, []);
    } finally { await f.close(); }
  });

  it('reserves across concurrent request IDs before preparation and never repeats an ambiguous start', async () => {
    const f = await fixture(); let release!: () => void;
    f.policy.prepareStart = async () => { await new Promise<void>(resolve => { release = resolve; }); return params; };
    try {
      await f.start(1); await f.start('different-id');
      assert.equal(f.frontend.sent.filter(frame => frame.error).length, 1);
      release(); await tick(); assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1);
      await f.start(99); assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1);
      assert.equal(f.creation.requestDispatched, true);
      await f.frontend.close(); await tick(); assert.equal(f.creation.uncertain, true); assert.equal(f.ownerWire.closed, false);
      await f.ack(); await assert.rejects(f.creation.created); assert.equal(f.frontend.sent.some(frame => frame.result && frame.id === 1), false);
    } finally { release?.(); await f.close(); }
  });

  it('does not publish a delayed ACK after owner generation changes or claim it for another request ID', async () => {
    const f = await fixture();
    try {
      await f.start(); f.expire(); await f.ack();
      await assert.rejects(f.creation.created); assert.equal(f.creation.inputReady, false);
      assert.deepEqual(f.frontend.sent, []); assert.equal(f.ownerWire.closed, false);
    } finally { await f.close(); }
  });

  it('waits for the actual native response write before publishing readiness or original events', async () => {
    const f = await fixture(); let release!: () => void;
    try {
      await f.start(); await f.ack();
      const held = new Promise<void>(resolve => { release = resolve; });
      f.frontend.beforeWrite = frame => frame.id === 1 ? held : Promise.resolve();
      f.creation.releaseAfterBindings(); await tick();
      f.ownerWire.emit({ method: 'item/fileChange/outputDelta', params: { threadId: OWNED, delta: 'original' } });
      await tick(); assert.equal(f.frontend.sent.length, 0); assert.equal(f.creation.inputReady, false);
      release(); await tick(); await f.creation.ready;
      assert.equal(f.creation.inputReady, true); assert.equal(f.frontend.sent[0]!.id, 1); assert.equal(f.frontend.sent[1]!.method, 'item/fileChange/outputDelta');
    } finally { release?.(); await f.close(); }
  });

  it('fails bounded notification overrun instead of silently dropping events and reporting ready', async () => {
    const f = await fixture();
    try {
      await f.start(); await f.ack();
      for (let n = 0; n <= 256; n++) f.ownerWire.emit({ method: 'item/agentMessage/delta', params: { threadId: OWNED, delta: String(n) } });
      await tick(); assert.deepEqual(f.unavailable, ['overrun']); await assert.rejects(f.creation.ready);
      assert.equal(f.creation.inputReady, false); assert.equal(f.ownerWire.closed, false); assert.equal(f.frontend.closed, true);
    } finally { await f.close(); }
  });

  it('ends startup at its existing deadline with no second start and no shared service shutdown', async () => {
    vi.useFakeTimers(); const f = await fixture(30_000);
    try {
      await f.start(); await vi.advanceTimersByTimeAsync(30_000);
      await assert.rejects(f.creation.created); assert.deepEqual(f.unavailable, ['deadline']);
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1); assert.equal(f.ownerWire.closed, false);
    } finally { await f.close(); vi.useRealTimers(); }
  });

  it('preserves the genuine owning-host RPC error rather than returning a successful synthetic ACK', async () => {
    const f = await fixture();
    try {
      await f.start(); const request = f.ownerWire.sent.find(frame => frame.method === 'thread/start')!;
      const error = { code: -32601, message: 'native backend does not implement create', data: { actual: true } };
      f.ownerWire.emit({ id: request.id, error }); await tick();
      await assert.rejects(f.creation.created, actual => actual instanceof AppServerRpcError
        && actual.code === error.code && actual.rpcError.message === error.message);
      assert.equal(f.creation.threadId, undefined); assert.equal(f.creation.uncertain, true); assert.equal(f.ownerWire.closed, false);
      // Broker failure closes the frontend: it cannot publish any success.
      assert.equal(f.frontend.sent.some(frame => frame.result), false);
    } finally { await f.close(); }
  });

  it('shares the once-only dispatch guard between the native and owning connections and keeps RPC error fields', async () => {
    const f = await fixture();
    try {
      await f.start(); await f.ack(); f.creation.releaseAfterBindings(); await tick();
      f.policy.bound = async call => {
        const result = await call.dispatchToHost!();
        await assert.rejects(call.forward(), /already forwarded/);
        await assert.rejects(call.dispatchToHost!(), /already forwarded/);
        return result;
      };
      f.frontend.emit({ id: 7, method: 'thread/read', params: { threadId: OWNED } }); await tick();
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/read').length, 1); assert.deepEqual(f.upstream.sent, []);
      f.policy.bound = call => call.dispatchToHost!();
      const error = { code: -32601, message: 'actual backend error', data: { actual: true } };
      f.ownerWire.respond = frame => { if (frame.id != null) f.ownerWire.emit({ id: frame.id, error }); };
      f.frontend.emit({ id: 8, method: 'thread/read', params: { threadId: OWNED } }); await tick();
      assert.deepEqual(f.frontend.sent.at(-1), { id: 8, error });
    } finally { await f.close(); }
  });

  it('does not create on a host whose initialize explicitly omitted native output events', async () => {
    const f = await fixture(30_000, ['item/commandExecution/outputDelta']);
    try {
      await f.start(); await assert.rejects(f.creation.created);
      assert.equal(f.creation.requestDispatched, false);
      assert.equal(f.ownerWire.sent.some(frame => frame.method === 'thread/start'), false);
      assert.equal(f.ownerWire.closed, false);
    } finally { await f.close(); }
  });

  it('rejects a legacy connection without upgrading or breaking its GUI RPCs', async () => {
    const f = await fixture(30_000, undefined, false);
    try {
      await f.start(); await assert.rejects(f.creation.created);
      assert.equal(f.creation.requestDispatched, false);
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'initialize').length, 1);
      assert.equal(f.ownerWire.sent.some(frame => frame.method === 'thread/start'), false);
      assert.deepEqual(await f.host.request('thread/read', { threadId: OWNED }), {});
      assert.equal(f.ownerWire.closed, false);
    } finally { await f.close(); }
  });

  it('revokes the captured connection receipt during pending preparation without sending a start', async () => {
    const f = await fixture(); let release!: () => void;
    f.policy.prepareStart = async () => { await new Promise<void>(resolve => { release = resolve; }); return params; };
    try {
      await f.start(); await f.host.shutdown(); release(); await tick();
      await assert.rejects(f.creation.created);
      assert.equal(f.creation.inputReady, false);
      assert.equal(f.creation.requestDispatched, false);
      assert.equal(f.ownerWire.sent.some(frame => frame.method === 'thread/start'), false);
      assert.deepEqual(f.unavailable, ['owner-changed']);
    } finally { release?.(); await f.close(); }
  });

  it('leaves the genuine created task available to GUI after Main cancels before releasing native input', async () => {
    const f = await fixture();
    try {
      await f.start(); await f.ack(); const actual = await f.creation.created;
      f.owner.abort(); await tick(); await assert.rejects(f.creation.ready);
      assert.equal(f.creation.inputReady, false); assert.equal(f.creation.threadId, actual.thread.id);
      assert.deepEqual(await f.host.request('thread/read', { threadId: actual.thread.id }), {});
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1);
      assert.equal(f.ownerWire.closed, false);
    } finally { await f.close(); }
  });

  it('keeps approvals with the owning host and accepts only the Core-projected native choice once', async () => {
    const f = await fixture();
    let subscription: ReturnType<AppServerHost['subscribeThread']> | undefined; let owners = 0;
    try {
      await f.start(); await f.ack();
      subscription = f.host.subscribeThread(OWNED, { commandExecutionApproval: async (value, meta) => {
        owners++;
        return new Promise(resolve => { f.approvals.open({ id: meta!.requestId, method: 'item/commandExecution/requestApproval', params: value },
          { allowPersistent: false, accept: () => resolve({ decision: 'accept' }) }); });
      } });
      f.creation.releaseAfterBindings(); await tick();
      const request = { id: 92, method: 'item/commandExecution/requestApproval',
        params: { threadId: OWNED, turnId: 'turn', itemId: 'item', availableDecisions: ['accept', 'cancel'] } };
      f.ownerWire.emit(request); await tick();
      assert.equal(owners, 1); assert.equal(f.frontend.sent.filter(frame => frame.method === request.method).length, 1);
      f.frontend.emit({ id: 92, result: { decision: 'accept' } });
      f.frontend.emit({ id: 92, result: { decision: 'cancel' } }); await tick();
      assert.deepEqual(f.ownerWire.sent.filter(frame => frame.id === 92), [{ id: 92, result: { decision: 'accept' } }]);
      assert.deepEqual(f.upstream.sent, []);
    } finally { await subscription?.release(); await f.close(); }
  });

  it('retires readiness on an actual event write failure after startup without closing the GUI service', async () => {
    const f = await fixture();
    try {
      await f.start(); await f.ack(); f.creation.releaseAfterBindings(); await tick(); await f.creation.ready;
      assert.equal(f.creation.inputReady, true);
      f.frontend.beforeWrite = async frame => { if (frame.method === 'item/agentMessage/delta') throw new Error('native pipe exited'); };
      f.ownerWire.emit({ method: 'item/agentMessage/delta', params: { threadId: OWNED, delta: 'must not be silently lost' } });
      await tick(); assert.equal(f.creation.signal.aborted, true); assert.equal(f.creation.inputReady, false);
      assert.equal(f.creation.threadId, OWNED); assert.equal(f.ownerWire.closed, false);
      assert.equal(f.ownerWire.sent.filter(frame => frame.method === 'thread/start').length, 1);
    } finally { await f.close(); }
  });
});
