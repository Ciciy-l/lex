import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { ClaudeNativeBridge, type ClaudeNativeBridgeOptions } from './native-bridge.js';

const bridges: ClaudeNativeBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())); });
async function fixture(onRequest: ClaudeNativeBridgeOptions['onRequest'] = vi.fn(async () => ({ behavior: 'deny' }))) {
  const onEvent = vi.fn();
  const onFault = vi.fn();
  const bridge = new ClaudeNativeBridge({ sessionId: 'native-session', onEvent, onFault, onRequest });
  bridges.push(bridge);
  const url = await bridge.start();
  const env = bridge.environment();
  const envelope = { sessionId: 'native-session', generation: bridge.generation };
  const headers = { authorization: `Bearer ${env.LEX_CLAUDE_BRIDGE_TOKEN}`, 'content-type': 'application/json' };
  const post = (route: string, body: object, overrides = {}) => fetch(url + route, { method: 'POST',
    headers: { ...headers, ...overrides }, body: JSON.stringify({ ...envelope, ...body }) });
  return { bridge, post, onEvent, onFault, onRequest, url, envelope, headers };
}

describe('Claude native semantic side channel', () => {
  it('authenticates the exact local child and fences session/generation and browser origins', async () => {
    const f = await fixture();
    for (const headers of [{ authorization: 'Bearer wrong' }, { origin: 'https://untrusted.invalid' }]) {
      expect((await f.post('/exchange', { events: [] }, headers)).status).toBe(403);
    }
    // fetch derives Host from its URL; use the HTTP client to test a real forged header.
    const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(f.url + '/exchange', { method: 'POST', headers: { ...f.headers, host: 'untrusted.invalid' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end(JSON.stringify({ ...f.envelope, events: [] }));
    });
    expect(forgedHost).toBe(403);
    expect((await f.post('/exchange', { events: [], sessionId: 'another-task' })).status).toBe(409);
    expect((await f.post('/exchange', { events: [], generation: 'old' })).status).toBe(409);
    expect((await f.post('/exchange', { events: [] })).status).toBe(200);
    expect(f.onEvent).not.toHaveBeenCalled();
  });

  it('acknowledges replayed events once and never reorders a gap', async () => {
    const f = await fixture();
    const event = { sequence: 1, kind: 'turn.start', value: { turnId: 'one' } };
    await f.post('/exchange', { events: [event] });
    const repeat = await (await f.post('/exchange', { events: [event] })).json();
    expect(repeat.acknowledged).toBe(1);
    expect(f.onEvent).toHaveBeenCalledOnce();
    const gap = await (await f.post('/exchange', { events: [{ ...event, sequence: 3 }] })).json();
    expect(gap).toMatchObject({ acknowledged: 1, faulted: true, commands: [] });
    expect(f.onFault).toHaveBeenCalledWith('event-gap');
    await f.post('/exchange', { events: [{ ...event, sequence: 2 }] });
    expect(f.onEvent).toHaveBeenCalledOnce();
  });

  it('repeats an unacknowledged command with the same ID and resolves only its receipt', async () => {
    const f = await fixture();
    const result = f.bridge.command('submit', { text: 'same' });
    const a = await (await f.post('/exchange', { events: [] })).json();
    const b = await (await f.post('/exchange', { events: [] })).json();
    expect(a.commands).toEqual(b.commands);
    expect(a.commands).toHaveLength(1);
    const ack = { sequence: 1, kind: 'command-result', value: { id: a.commands[0].id, ok: true, result: { uuid: 'native-row' } } };
    const response = await (await f.post('/exchange', { events: [ack] })).json();
    expect(await result).toEqual({ uuid: 'native-row' });
    expect(response.commands).toEqual([]);
    await f.post('/exchange', { events: [ack] });
    expect(f.onEvent).toHaveBeenCalledOnce();
  });

  it('times out as unconfirmed without creating a replacement command', async () => {
    const f = await fixture();
    const result = f.bridge.command('submit', { text: 'once' }, 20);
    const rejected = expect(result).rejects.toThrow('unconfirmed');
    await rejected;
    const response = await (await f.post('/exchange', { events: [] })).json();
    expect(response.commands).toEqual([]);
  });

  it('uses independent callback identities for simultaneous identical tools and caches one answer', async () => {
    const waiters: Array<(value: { behavior: string }) => void> = [];
    const handler = vi.fn(() => new Promise<{ behavior: string }>((resolve) => waiters.push(resolve)));
    const f = await fixture(handler);
    const one = f.post('/request', { request: { requestId: '1', kind: 'permission', input: { tool: 'Write' } } });
    const duplicate = f.post('/request', { request: { requestId: '1', kind: 'permission', input: { tool: 'Write' } } });
    const two = f.post('/request', { request: { requestId: '2', kind: 'permission', input: { tool: 'Write' } } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    waiters[0]({ behavior: 'deny' });
    expect(await (await one).json()).toEqual({ result: { behavior: 'deny' } });
    expect(await (await duplicate).json()).toEqual({ result: { behavior: 'deny' } });
    waiters[1]({ behavior: 'allow' });
    expect(await (await two).json()).toEqual({ result: { behavior: 'allow' } });
  });

  it('retires an old native callback without delivering its late answer or cancelling a sibling', async () => {
    const waiters = new Map<string, (value: { behavior: string }) => void>();
    const handler = vi.fn((request: { requestId: string }) => new Promise<{ behavior: string }>((resolve) => waiters.set(request.requestId, resolve)));
    const f = await fixture(handler);
    const one = f.post('/request', { request: { requestId: '1', kind: 'permission', input: {} } });
    const two = f.post('/request', { request: { requestId: '2', kind: 'permission', input: {} } });
    await vi.waitFor(() => expect(waiters.size).toBe(2));
    await f.post('/exchange', { events: [{ sequence: 1, kind: 'request-retired', value: { requestId: '1' } }] });
    expect(await (await one).json()).toEqual({ retired: true });
    waiters.get('1')!({ behavior: 'allow' });
    waiters.get('2')!({ behavior: 'deny' });
    expect(await (await two).json()).toEqual({ result: { behavior: 'deny' } });
    expect(await (await f.post('/request', { request: { requestId: '1', kind: 'permission', input: {} } })).json()).toEqual({ retired: true });
  });

  it('marks observer overflow incomplete and cancels pending decisions', async () => {
    const handler = vi.fn(() => new Promise<{ behavior: string }>(() => {}));
    const f = await fixture(handler);
    const request = f.post('/request', { request: { requestId: '1', kind: 'permission', input: {} } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(await (await f.post('/exchange', { events: [], overflow: true })).json()).toMatchObject({ faulted: true });
    expect(await (await request).json()).toEqual({ retired: true });
    await expect(f.bridge.command('submit', {})).rejects.toThrow('unavailable');
    expect(f.onFault).toHaveBeenCalledWith('event-overflow');
  });

  it('tears down in-flight work once without exposing child credentials', async () => {
    const f = await fixture();
    const result = f.bridge.command('abort', { turnId: 'one' });
    const rejected = expect(result).rejects.toThrow('closed');
    const closing = f.bridge.close();
    expect(f.bridge.close()).toBe(closing);
    await closing; await rejected;
    expect(() => f.bridge.environment()).toThrow('not listening');
    expect(f.onFault).not.toHaveBeenCalled();
  });

  it('remembers retirement that arrives before the callback connection', async () => {
    const f = await fixture();
    f.bridge.retireRequest('1');
    expect(await (await f.post('/request', { request: { requestId: '1', kind: 'permission', input: {} } })).json())
      .toEqual({ retired: true });
    expect(f.onRequest).not.toHaveBeenCalled();
  });

  it('refuses reuse of a callback identity for a different decision', async () => {
    const f = await fixture();
    await f.post('/request', { request: { requestId: '1', kind: 'permission', input: { path: 'one' } } });
    expect((await f.post('/request', { request: { requestId: '1', kind: 'permission', input: { path: 'two' } } })).status).toBe(409);
    expect(f.onRequest).toHaveBeenCalledOnce();
    f.bridge.retireRequest('1');
    expect(await (await f.post('/request', { request: { requestId: '1', kind: 'permission', input: { path: 'one' } } })).json())
      .toEqual({ retired: true });
  });

  it('bounds completed callback retention without recreating old decisions', async () => {
    const f = await fixture();
    for (let i = 1; i <= 130; i++) {
      expect((await f.post('/request', { request: { requestId: String(i), kind: 'permission', input: {} } })).status).toBe(200);
    }
    expect((await f.post('/request', { request: { requestId: '1', kind: 'permission', input: {} } })).status).toBe(409);
    expect(f.onRequest).toHaveBeenCalledTimes(130);
  });

  it('freezes command data and isolates failing diagnostics while rejecting unconfirmed work', async () => {
    const f = await fixture();
    const payload = { text: 'original' };
    const result = f.bridge.command('submit', payload);
    const rejected = expect(result).rejects.toThrow('unconfirmed');
    payload.text = 'mutated';
    expect((await (await f.post('/exchange', { events: [] })).json()).commands[0].payload.text).toBe('original');
    f.onFault.mockImplementation(() => { throw new Error('observer gone'); });
    expect((await (await f.post('/exchange', { events: [], overflow: true })).json()).faulted).toBe(true);
    await rejected;
  });

  it('closes safely while the listener is still starting', async () => {
    const bridge = new ClaudeNativeBridge({ sessionId: 'one', onEvent: vi.fn(), onRequest: vi.fn(), onFault: vi.fn() });
    bridges.push(bridge);
    const started = bridge.start();
    const closing = bridge.close();
    expect(bridge.close()).toBe(closing);
    await started; await closing;
    await expect(bridge.start()).rejects.toThrow('closed');
    expect(() => bridge.environment()).toThrow('not listening');
  });
});
