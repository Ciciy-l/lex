import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { connectCodexNativeFrontend, type CodexFrontendCall, type CodexNativeFrontendOptions } from './native-frontend.js';
import { CodexNativeApprovals } from './native-approvals.js';
import { CodexNativeDynamicTools } from './native-dynamic-tools.js';

function transport() {
  const lines = new Set<(line: string) => void>(), closes = new Set<(info: { reason: string }) => void>();
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  return {
    sent, get closed() { return closed; },
    async writeLine(line: string) { if (closed) throw new Error('closed'); sent.push(JSON.parse(line)); },
    onLine(fn: (line: string) => void) { lines.add(fn); return () => { lines.delete(fn); }; },
    onClose(fn: (info: { reason: string }) => void) { closes.add(fn); return () => { closes.delete(fn); }; },
    async close() { if (closed) return; closed = true; for (const fn of [...closes]) fn({ reason: 'closed' }); },
    emit(value: unknown) { for (const fn of [...lines]) fn(typeof value === 'string' ? value : JSON.stringify(value)); },
  };
}
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function fixture(route: (call: CodexFrontendCall) => Promise<unknown> = c => c.forward(),
  observe: Pick<CodexNativeFrontendOptions, 'responseDelivered' | 'closed'> = {}) {
  const frontend = transport(), upstream = transport(), approvals = new CodexNativeApprovals();
  let current = true;
  const tools = new CodexNativeDynamicTools(() => current);
  const link = connectCodexNativeFrontend({ frontend, upstream, ...observe,
    handle: { attachNativeApprovalFrontend: receiver => approvals.attach(receiver), attachNativeToolFrontend: receiver => tools.attach(receiver) },
    isCurrent: () => current,
    request: route,
    notification: event => (event.params as { threadId?: string })?.threadId === 'owned' ? event : null,
  });
  const ready = async () => {
    frontend.emit({ id: 'initialize', method: 'initialize', params: {} }); await tick();
    upstream.emit({ id: upstream.sent.at(-1)!.id, result: {} }); await tick();
    frontend.emit({ method: 'initialized' }); await tick(); frontend.sent.length = 0; upstream.sent.length = 0;
  };
  return { frontend, upstream, approvals, tools, link, ready, expire() { current = false; } };
}
describe('task-bound Codex native protocol connection', () => {
  it('relays an admitted tool to the initialized original executor and returns only through Core', async () => {
    const f = fixture();
    const params = { threadId: 'owned', turnId: 'turn', callId: 'actual-tool-call', namespace: 'codex_tui', tool: 'read_thread', arguments: { threadId: 'owned' } };
    f.tools.register([{ type: 'namespace', name: 'codex_tui', tools: [{ type: 'function', name: 'read_thread' }] }]);
    try {
      assert.equal((await f.tools.execute('before-ready', params)).success, false);
      await f.ready();
      const result = f.tools.execute('native-server-id', params); await tick();
      assert.deepEqual(f.frontend.sent, [{ id: 'native-server-id', method: 'item/tool/call', params }]);
      assert.deepEqual(f.upstream.sent, []);
      const response = { success: true, contentItems: [{ type: 'inputText', text: 'original executor result' }] };
      f.frontend.emit({ id: 'native-server-id', result: response });
      assert.deepEqual(await result, response); assert.deepEqual(f.upstream.sent, []);
      const cancelled = f.tools.execute('cancel-native', params); await tick();
      f.tools.cancel('cancel-native', 'owned'); await tick();
      assert.equal((await cancelled).success, false);
      assert.deepEqual(f.frontend.sent.at(-1), { method: 'serverRequest/resolved', params: { threadId: 'owned', requestId: 'cancel-native' } });
    } finally { f.tools.close(); await f.link.close(); }
  });
  it('reports delivery only after the successful ACK write and reports connection loss separately', async () => {
    const delivered: string[] = []; let closes = 0;
    const f = fixture(call => call.forward(), { responseDelivered: request => delivered.push(request.method), closed: () => { closes++; } });
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    try {
      await f.ready(); delivered.length = 0;
      const write = f.frontend.writeLine;
      f.frontend.writeLine = async line => { await held; await write(line); };
      f.frontend.emit({ id: 1, method: 'thread/resume', params: { threadId: 'owned' } }); await tick();
      f.upstream.emit({ id: f.upstream.sent.at(-1)!.id, result: { thread: { id: 'owned' } } }); await tick();
      assert.deepEqual(delivered, []); assert.deepEqual(f.frontend.sent, []);
      finish(); await tick(); assert.deepEqual(delivered, ['thread/resume']);
      await f.link.close(); assert.equal(closes, 1);
    } finally { finish(); await f.link.close(); }
  });
  it('returns correlated original RPC ids while the task policy prepares input exactly once', async () => {
    let admissions = 0;
    const f = fixture(async call => {
      if (call.request.method === 'turn/start') { admissions++; return call.forward({ threadId: 'owned', input: ['prepared'] }); }
      return call.forward();
    });
    try { await f.ready();
      f.frontend.emit({ id: 12, method: 'turn/start', params: { threadId: 'owned', input: ['original'] } }); await tick();
      assert.deepEqual(f.upstream.sent, [{ id: 'lex-tui:2', method: 'turn/start', params: { threadId: 'owned', input: ['prepared'] } }]);
      f.upstream.emit({ id: f.upstream.sent[0]!.id, result: { turn: { id: 'same-native-turn' } } }); await tick();
      assert.equal(admissions, 1); assert.deepEqual(f.frontend.sent, [{ id: 12, result: { turn: { id: 'same-native-turn' } } }]);
    } finally { await f.link.close(); }
  });
  it('withholds raw server requests and sends no native approval response upstream', async () => {
    const f = fixture(); const replies: unknown[] = [];
    try { await f.ready();
      const request = { id: 0, method: 'item/commandExecution/requestApproval' as const,
        params: { threadId: 'owned', availableDecisions: ['accept', 'cancel'] } };
      f.upstream.emit(request);
      f.frontend.emit({ id: 0, result: { decision: 'accept' } }); await tick();
      assert.equal(f.frontend.sent.length, 0); assert.equal(f.upstream.sent.length, 0); assert.equal(replies.length, 0);
      f.approvals.open(request, { allowPersistent: false, accept: value => replies.push(value) }); await tick();
      assert.deepEqual(f.frontend.sent, [request]);
      f.frontend.emit({ id: 0, result: { decision: 'accept' } }); await tick();
      f.frontend.emit({ id: 0, result: { decision: 'cancel' } }); await tick();
      assert.deepEqual(replies, [{ decision: 'accept' }]); assert.deepEqual(f.upstream.sent, []);
      assert.equal(f.frontend.sent.at(-1)?.method, 'serverRequest/resolved');
    } finally { await f.link.close(); }
  });
  it('does not let a late receipt complete a new request reusing the original frontend id', async () => {
    const f = fixture();
    try { await f.ready();
      f.frontend.emit({ id: 7, method: 'thread/read' }); await tick();
      const first = f.upstream.sent.at(-1)!.id;
      f.upstream.emit({ id: first, result: { revision: 1 } }); await tick();
      f.frontend.sent.length = 0;
      f.frontend.emit({ id: 7, method: 'thread/read' }); await tick();
      const second = f.upstream.sent.at(-1)!.id; assert.notEqual(second, first);
      f.upstream.emit({ id: first, result: { revision: 1 } }); await tick();
      assert.deepEqual(f.frontend.sent, []);
      f.upstream.emit({ id: second, result: { revision: 2 } }); await tick();
      assert.deepEqual(f.frontend.sent, [{ id: 7, result: { revision: 2 } }]);
    } finally { await f.link.close(); }
  });
  it('does not expose raw MCP/permission/questions to a competing native responder', async () => {
    const f = fixture();
    try { await f.ready();
      for (const method of ['item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'unknown/newRequest']) {
        f.upstream.emit({ id: 0, method, params: { threadId: 'owned' } });
        f.frontend.emit({ id: 0, result: { anything: true } });
      }
      await tick(); assert.deepEqual(f.frontend.sent, []); assert.deepEqual(f.upstream.sent, []);
    } finally { await f.link.close(); }
  });
  it('replays pending eligible approvals only after the TUI initialization handshake', async () => {
    const f = fixture();
    try {
      f.approvals.open({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'owned' } },
        { allowPersistent: true, accept() {} }); await tick();
      assert.equal(f.frontend.sent.length, 0);
      f.frontend.emit({ id: 'initialize', method: 'initialize' }); await tick();
      f.upstream.emit({ id: f.upstream.sent.at(-1)!.id, result: {} }); await tick();
      assert.equal(f.frontend.sent.length, 1);
      f.frontend.emit({ method: 'initialized' }); await tick();
      assert.equal(f.frontend.sent.length, 2); assert.equal(f.frontend.sent[1]?.method, 'item/fileChange/requestApproval');
    } finally { await f.link.close(); }
  });
  it('projects owned notifications and does not leak other native tasks', async () => {
    const f = fixture();
    try { await f.ready();
      f.upstream.emit({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', delta: 'secret' } });
      f.upstream.emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned', delta: 'visible' } }); await tick();
      assert.deepEqual(f.frontend.sent, [{ method: 'item/agentMessage/delta', params: { threadId: 'owned', delta: 'visible' } }]);
    } finally { await f.link.close(); }
  });
  it('rejects task-policy failures without forwarding or exposing internal errors', async () => {
    const f = fixture(call => call.request.method === 'initialize' ? call.forward() : Promise.reject(new Error('private host detail')));
    try { await f.ready(); f.frontend.emit({ id: 4, method: 'account/login/start', params: {} }); await tick();
      assert.equal(f.upstream.sent.length, 0); assert.equal(f.frontend.sent[0]?.id, 4);
      assert.equal(JSON.stringify(f.frontend.sent).includes('private host detail'), false);
    } finally { await f.link.close(); }
  });
  it('forwards at most once even if an adapter calls its continuation twice', async () => {
    const f = fixture(async call => { const value = await call.forward();
      if (call.request.method !== 'initialize') await assert.rejects(call.forward(), /already forwarded/);
      return value; });
    try { await f.ready(); f.frontend.emit({ id: 1, method: 'thread/read' }); await tick();
      f.upstream.emit({ id: f.upstream.sent.at(-1)!.id, result: {} }); await tick(); assert.equal(f.upstream.sent.length, 1);
    } finally { await f.link.close(); }
  });
  it('fences pending preparation and late replies after owner change without replay', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async call => { if (call.request.method !== 'initialize') await pending; return call.forward(); });
    try { await f.ready(); f.frontend.emit({ id: 1, method: 'turn/start' }); await tick();
      f.expire(); release(); await tick(); assert.deepEqual(f.upstream.sent, []); assert.deepEqual(f.frontend.sent, []);
    } finally { await f.link.close(); }
  });
  it('connection loss cancels only its pending requests and leaves host approvals active', async () => {
    const f = fixture(); const results: unknown[] = []; const other = f.approvals.attach(() => {});
    try { await f.ready();
      f.approvals.open({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'owned' } },
        { allowPersistent: true, accept: value => results.push(value) });
      f.frontend.emit({ id: 33, method: 'turn/start' }); await tick();
      await f.frontend.close(); await tick();
      assert.equal(f.upstream.closed, true); assert.equal(other.answer(1, { decision: 'accept' }), true);
      assert.deepEqual(results, [{ decision: 'accept' }]);
    } finally { await f.link.close(); }
  });
  it('bounds in-flight requests and rejects conflicting request identities', async () => {
    for (const duplicate of [true, false]) {
      const f = fixture();
      try { await f.ready();
        for (let i = 0; i <= (duplicate ? 1 : 256); i++) f.frontend.emit({ id: duplicate ? 0 : i, method: 'thread/read' });
        await tick(); assert.equal(f.frontend.closed, true); assert.equal(f.upstream.closed, true);
      } finally { await f.link.close(); }
    }
  });
  it('preserves a correlated native error and never treats it as a success', async () => {
    const f = fixture();
    try { await f.ready(); f.frontend.emit({ id: 6, method: 'thread/read' }); await tick();
      f.upstream.emit({ id: f.upstream.sent.at(-1)!.id, error: { code: -32000, message: 'native stopped', data: { retry: false } } }); await tick();
      assert.deepEqual(f.frontend.sent, [{ id: 6, error: { code: -32000, message: 'native stopped', data: { retry: false } } }]);
    } finally { await f.link.close(); }
  });
  it('detaches a frontend revoked synchronously while snapshotting its pending approval', async () => {
    const frontend = transport(), upstream = transport(); let current = true, detached = false;
    assert.throws(() => connectCodexNativeFrontend({ frontend, upstream, isCurrent: () => current,
      request: call => call.forward(), notification: event => event,
      handle: { attachNativeApprovalFrontend(receive) {
        current = false;
        receive({ kind: 'request', request: { id: 0, method: 'item/fileChange/requestApproval', params: { threadId: 'old' } } });
        return { answer: () => false, detach() { detached = true; } };
      } },
    }), /retired/);
    await tick(); assert.equal(detached, true); assert.equal(frontend.closed, true); assert.equal(upstream.closed, true);
  });
  it('bounds aggregate pending approval bytes before the native UI is ready', async () => {
    const frontend = transport(), upstream = transport(); let detached = false;
    assert.throws(() => connectCodexNativeFrontend({ frontend, upstream, isCurrent: () => true,
      request: call => call.forward(), notification: event => event,
      handle: { attachNativeApprovalFrontend(receive) {
        const reason = 'x'.repeat(1024 * 1024);
        for (let id = 0; id < 17; id++) receive({ kind: 'request', request: { id,
          method: 'item/fileChange/requestApproval', params: { threadId: 'owned', reason } } });
        return { answer: () => false, detach() { detached = true; } };
      } },
    }), /retired/);
    await tick(); assert.equal(detached, true); assert.equal(frontend.closed, true); assert.equal(upstream.closed, true);
  });
});
