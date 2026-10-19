import { describe, expect, it } from 'vitest';
import { CodexNativeDynamicTools, type CodexNativeToolEvent } from './native-dynamic-tools.js';
const declarations = [{ type: 'namespace', name: 'codex_tui', tools: [
  { type: 'function', name: 'read_thread' }, { type: 'function', name: 'wait_threads' },
] }];
const params = { threadId: 'own', turnId: 'turn', callId: 'real-call', namespace: 'codex_tui', tool: 'read_thread', arguments: { threadId: 'own' } };
const ok = { success: true, contentItems: [{ type: 'inputText' as const, text: 'original result' }] };
const flushed = () => new Promise<void>(resolve => setImmediate(resolve));

describe('original native dynamic tool executor', () => {
  it('keeps exact identities and results, chooses one initialized frontend and never broadcasts execution', async () => {
    const tools = new CodexNativeDynamicTools(() => true); tools.register(declarations);
    const firstEvents: CodexNativeToolEvent[] = [], secondEvents: CodexNativeToolEvent[] = [];
    const first = tools.attach(async event => { firstEvents.push(event); return true; });
    const second = tools.attach(async event => { secondEvents.push(event); return true; });
    first.ready();
    const result = tools.execute('server-id', params); await flushed();
    expect(firstEvents).toEqual([{ kind: 'request', request: { id: 'server-id', method: 'item/tool/call', params } }]);
    expect(secondEvents).toEqual([]);
    expect(second.answer('server-id', ok)).toBe(false);
    second.ready();
    expect(second.answer('server-id', ok)).toBe(false);
    expect(first.answer('server-id', ok)).toBe(true);
    expect(await result).toEqual(ok);
    expect(first.answer('server-id', ok)).toBe(false); tools.close();
  });
  it('does not replay a disconnected or uncertain execution on the next frontend', async () => {
    const tools = new CodexNativeDynamicTools(() => true); tools.register(declarations);
    let sends = 0; const old = tools.attach(async () => { sends++; return true; }); old.ready();
    const result = tools.execute(1, params); await flushed(); old.detach();
    expect((await result).success).toBe(false);
    const next = tools.attach(async () => { sends++; return false; }); next.ready();
    await flushed(); expect(sends).toBe(1); expect(old.answer(1, ok)).toBe(false);
    expect((await tools.execute(2, params)).success).toBe(false);
    expect(sends).toBe(2); tools.close();
  });
  it('cancels only the matching request and ignores late answers and expired owners', async () => {
    let current = true; const tools = new CodexNativeDynamicTools(() => current); tools.register(declarations);
    const events: CodexNativeToolEvent[] = [];
    const frontend = tools.attach(async event => { events.push(event); return true; }); frontend.ready();
    const first = tools.execute(1, params), second = tools.execute(2, { ...params, callId: 'second-real-call' });
    await flushed(); tools.cancel(1, 'foreign'); expect(frontend.answer(1, ok)).toBe(true); expect(await first).toEqual(ok);
    tools.cancel(2, 'own'); expect((await second).success).toBe(false); await flushed();
    expect(events.filter(event => event.kind === 'resolved')).toEqual([{ kind: 'resolved', id: 2, threadId: 'own' }]);
    expect(frontend.answer(2, ok)).toBe(false);
    const last = tools.execute(3, params); await flushed(); current = false;
    expect(frontend.answer(3, ok)).toBe(false); tools.close(); expect((await last).success).toBe(false);
    expect((await tools.execute(4, params)).success).toBe(false);
  });
  it('refuses unadvertised namespaces and invalid outputs without manufacturing a successful tool result', async () => {
    const tools = new CodexNativeDynamicTools(() => true); tools.register(declarations);
    const frontend = tools.attach(async () => true); frontend.ready();
    expect((await tools.execute(1, { ...params, namespace: 'foreign' })).success).toBe(false);
    const result = tools.execute(2, params); await flushed();
    expect(frontend.answer(2, { success: true, contentItems: [{ type: 'inputText' }] })).toBe(true);
    expect((await result).success).toBe(false); tools.close();
  });
  it('bounds pending calls and does not dispatch a repeated in-flight server identity', async () => {
    const tools = new CodexNativeDynamicTools(() => true); tools.register(declarations);
    const events: CodexNativeToolEvent[] = [];
    const frontend = tools.attach(async event => { events.push(event); return true; }); frontend.ready();
    const pending = Array.from({ length: 128 }, (_, id) => tools.execute(id, { ...params, callId: String(id) }));
    expect((await tools.execute(0, params)).success).toBe(false);
    expect((await tools.execute(128, params)).success).toBe(false);
    await flushed(); expect(events).toHaveLength(128);
    tools.close(); expect((await Promise.all(pending)).every(value => !value.success)).toBe(true);
  });
});
