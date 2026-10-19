import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createCodexNativeTaskRouting } from './native-task-routing.js';

type Call = Parameters<ReturnType<typeof createCodexNativeTaskRouting>['request']>[0];
function fixture() {
  let alive = true;
  const forwarded: Array<{ method: string; params: unknown }> = [], controls: string[] = [], catalogs: string[] = [];
  const handle = { id: 'owned', acceptNativeTurn: async (request: { params: unknown; dispatch(params: unknown): Promise<unknown> }) => {
    return request.dispatch({ ...(request.params as object), model: 'host-prepared' });
  } };
  const router = createCodexNativeTaskRouting({ handle: handle as never, cwd: '/protocol/work', isCurrent: () => alive,
    ownsDescendant: id => id === 'child', titleContext: () => ({ model: 'chosen', modelProvider: 'fixture', mcpServers: ['host'] }),
    catalog: async call => { catalogs.push(call.request.method); return { source: 'product-catalog' }; },
    control: async call => { controls.push(call.request.method); return { source: 'product-control' }; },
  });
  function call(method: string, params: unknown = {}, response: unknown = {}): Call {
    return { request: { id: 'r', method, params }, signal: new AbortController().signal,
      forward: async (prepared = params) => { forwarded.push({ method, params: prepared }); return response; } };
  }
  const title = () => ({ model: 'chosen', modelProvider: 'fixture', cwd: '/protocol/work', threadSource: 'thread_title', ephemeral: true, sandbox: 'read-only',
    config: { mcp_servers: { host: { enabled: false } }, web_search: 'disabled', default_permissions: ':read-only',
      ...Object.fromEntries(['shell_tool','unified_exec','hooks','plugins','apps','multi_agent','multi_agent_v2','image_generation','request_permissions_tool'].map(key => ['features.' + key, false])) } });
  const attach = async () => {
    const request = call('thread/resume', { threadId: 'owned' }, { thread: { id: 'owned' } });
    const response = await router.request(request); router.responseDelivered(request.request, response); await router.ready;
  };
  return { router, handle, call, title, forwarded, controls, catalogs, attach, retire: () => { alive = false; } };
}

describe('one task owns original native frontend routing', () => {
  it('forwards owned history and known descendants, but rejects foreign reads', async () => {
    const f = fixture();
    for (const method of ['thread/read', 'thread/items/list', 'thread/turns/list', 'thread/goal/get']) {
      await f.router.request(f.call(method, { threadId: 'owned' }));
      await f.router.request(f.call(method, { threadId: 'child' }));
      await assert.rejects(f.router.request(f.call(method, { threadId: 'foreign' })), /does not belong/);
    }
    assert.equal(f.forwarded.length, 8);
  });
  it('filters both genuine inventory forms while preserving their original pagination', async () => {
    const f = fixture();
    assert.deepEqual(await f.router.request(f.call('thread/list', {}, { data: [{ id: 'foreign' }, { id: 'owned' }, { id: 'child' }], nextCursor: 'foreign-cursor' })),
      { data: [{ id: 'owned' }, { id: 'child' }], nextCursor: 'foreign-cursor' });
    assert.deepEqual(await f.router.request(f.call('thread/loaded/list', {}, { data: ['foreign', 'owned'], nextCursor: 'foreign-cursor' })),
      { data: ['owned'], nextCursor: 'foreign-cursor' });
    await assert.rejects(f.router.request(f.call('thread/list', { cwd: '/foreign' })), /another working/);
  });
  it('uses the same product reservation for native input and delegates descendant controls', async () => {
    const f = fixture(); await f.attach();
    await f.router.request(f.call('turn/start', { threadId: 'owned', input: [{ type: 'text', text: 'native' }], model: 'unprepared' }));
    assert.equal((f.forwarded[1]!.params as { model: string }).model, 'host-prepared');
    assert.equal(f.forwarded.filter(entry => entry.method === 'thread/resume').length, 1);
    await f.router.request(f.call('turn/start', { threadId: 'child' }));
    assert.deepEqual(f.controls, ['turn/start']);
  });
  it('treats attach as a read, not authority to overwrite the task settings or history', async () => {
    const f = fixture();
    await f.router.request(f.call('thread/resume', { threadId: 'owned', model: null, path: null, history: null, excludeTurns: true }, { thread: { id: 'owned' } }));
    for (const patch of [{ model: 'changed' }, { path: '/other' }, { history: [] }, { config: {} }, { permissions: ':full-access' }]) {
      await assert.rejects(f.router.request(f.call('thread/resume', { threadId: 'owned', ...patch })), /cannot replace/);
    }
    assert.equal(f.forwarded.length, 1);
  });
  it('routes native model/config views through the product provider catalog', async () => {
    const f = fixture();
    for (const method of ['model/list', 'config/read', 'mcpServerStatus/list']) {
      assert.deepEqual(await f.router.request(f.call(method, { cwd: '/protocol/work', threadId: 'owned' })), { source: 'product-catalog' });
      await assert.rejects(f.router.request(f.call(method, { cwd: '/foreign' })), /another working/);
    }
    assert.equal(f.forwarded.length, 0); assert.equal(f.catalogs.length, 3);
  });
  it('limits filesystem-derived capability reads to the actual task cwd', async () => {
    const f = fixture();
    for (const method of ['hooks/list', 'skills/list', 'plugin/list']) {
      await f.router.request(f.call(method, { cwds: ['/protocol/work'] }));
      for (const cwds of [[], ['/foreign'], ['/protocol/work', '/foreign']])
        await assert.rejects(f.router.request(f.call(method, { cwds })), /another working/);
    }
    assert.equal(f.forwarded.length, 3);
  });
  it('never directly forwards settings, configuration writes, forks or unknown mutations', async () => {
    const f = fixture(); await f.attach();
    for (const method of ['thread/settings/update', 'config/batchWrite', 'thread/fork', 'thread/start', 'new/mutation']) {
      assert.deepEqual(await f.router.request(f.call(method, { threadId: 'owned' })), { source: 'product-control' });
    }
    assert.deepEqual(f.forwarded.map(entry => entry.method), ['thread/resume']); assert.equal(f.controls.length, 5);
    await assert.rejects(f.router.request(f.call('thread/settings/update', { threadId: 'foreign' })), /does not belong/);
  });
  it('filters unowned notifications without guessing ownership from payload content', () => {
    const f = fixture();
    for (const threadId of ['owned','child']) {
      const event = { method: 'item/started', params: { threadId, item: { id: 'item' } } };
      assert.equal(f.router.notification(event), event);
    }
    assert.equal(f.router.notification({ method: 'item/started', params: { threadId: 'foreign', item: { id: 'owned' } } }), null);
    assert.equal(f.router.notification({ method: 'unknown/global', params: { content: 'owned' } }), null);
    const global = { method: 'account/rateLimits/updated', params: {} }; assert.equal(f.router.notification(global), global);
  });
  it('allows the native read-only title helper without granting it task input authority', async () => {
    const f = fixture();
    await f.router.request(f.call('thread/start', f.title(), { thread: { id: 'title' } }));
    await f.router.request(f.call('turn/start', { threadId: 'title', input: [{ type: 'text', text: 'title request' }], model: null, outputSchema: {} }));
    assert.equal((f.forwarded[1]!.params as { model: unknown }).model, null);
    await assert.rejects(f.router.request(f.call('turn/start', { threadId: 'title', permissions: ':full-access' })), /cannot change/);
    await f.router.request(f.call('thread/unsubscribe', { threadId: 'title' }));
    await assert.rejects(f.router.request(f.call('thread/read', { threadId: 'title' })), /does not belong/);
  });
  it('refuses title helpers with inherited tools or another provider/model', async () => {
    const f = fixture();
    for (const params of [{ ...f.title(), model: 'other' }, { ...f.title(), modelProvider: 'other' },
      { ...f.title(), config: {} }, { ...f.title(), config: { ...f.title().config, mcp_servers: { host: { enabled: true } } } },
      { ...f.title(), sandbox: 'danger-full-access' }, { ...f.title(), dynamicTools: [{}] }]) {
      await assert.rejects(f.router.request(f.call('thread/start', params)), /Native title/);
    }
    assert.equal(f.forwarded.length, 0);
  });
  it('fills authoritative disabled MCP names when the frontend does not receive service configuration', async () => {
    const f = fixture();
    await f.router.request(f.call('thread/start', { ...f.title(), config: { ...f.title().config, mcp_servers: {} } }, { thread: { id: 'title' } }));
    assert.deepEqual((f.forwarded[0]!.params as { config: { mcp_servers: unknown } }).config.mcp_servers, { host: { enabled: false } });
  });
  it('drops a receipt after owner retirement and stops all later native access', async () => {
    const f = fixture(), call = f.call('thread/read', { threadId: 'owned' });
    call.forward = async () => { f.retire(); return { thread: { id: 'owned' } }; };
    await assert.rejects(f.router.request(call), /owner changed/);
    assert.equal(f.router.notification({ method: 'turn/completed', params: { threadId: 'owned' } }), null);
    await assert.rejects(f.router.request(f.call('turn/start', { threadId: 'owned' })), /owner changed/);
  });
  it('refuses native input before the original resume receipt reaches its frontend', async () => {
    const f = fixture();
    await assert.rejects(f.router.request(f.call('turn/start', { threadId: 'owned' })), /not confirmed/);
    const call = f.call('thread/resume', { threadId: 'owned' }, { thread: { id: 'owned' } });
    const response = await f.router.request(call);
    await assert.rejects(f.router.request(f.call('turn/start', { threadId: 'owned' })), /not confirmed/);
    f.router.responseDelivered(call.request, response); await f.router.ready;
    await f.router.request(f.call('turn/start', { threadId: 'owned' }));
    assert.deepEqual(f.forwarded.map(entry => entry.method), ['thread/resume', 'turn/start']);
  });
});
