import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_NATIVE_MOD_SOURCE } from './native-mod-source.js';

// Execute the actual packaged source. Native compiler acceptance is separately
// checked by the opt-in native gate; these tests exercise protocol behavior.
type Hook = (...args: any[]) => any;
function fixture() {
  const hooks = new Map<string, Hook>();
  const register = new Function(CLAUDE_NATIVE_MOD_SOURCE.replace('export function register', 'function register') + '; return register;')();
  register((name: string, hook: Hook) => hooks.set(name, hook));
  const commands: Array<{ id: number; kind: string; payload: unknown }> = [];
  const events: any[] = [];
  const env: Record<string, string> = { LEX_CLAUDE_BRIDGE_URL: 'http://127.0.0.1:12345',
    LEX_CLAUDE_BRIDGE_TOKEN: 'fixture', LEX_CLAUDE_BRIDGE_GENERATION: 'generation', LEX_CLAUDE_BRIDGE_SESSION: 'session' };
  let tick!: () => Promise<void>;
  const $ = {
    env: { get: async (key: string) => env[key] },
    session: { id: async () => 'session', version: async () => ({ version: 'fixture' }), usage: async () => ({}), model: async () => 'fixture' },
    clock: { every: vi.fn((_ms: number, callback: () => Promise<void>) => { tick = callback; return { cancel: vi.fn() }; }) },
    http: { fetch: vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      events.push(...body.events);
      return { ok: true, text: JSON.stringify({ acknowledged: body.events.at(-1)?.sequence ?? events.at(-1)?.sequence ?? 0, commands: commands.splice(0) }) };
    }) },
    prompt: { submit: vi.fn(async (input: { text: string }) => input), read: vi.fn(async () => ({ text: 'draft', cursor: 2 })) },
    turn: { abort: vi.fn(async (_input: unknown) => {}) },
  };
  const start = () => hooks.get('session.start')!($, { isInteractive: true }, async (e: unknown) => e);
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await tick(); };
  return { $, hooks, env, start, flush, events, commands, tick: () => tick() };
}

describe('packaged Claude native Mod', () => {
  it('starts only for an exact loopback endpoint and native session', async () => {
    const f = fixture();
    await f.start(); await f.tick();
    expect(f.events[0]).toMatchObject({ kind: 'ready', value: { sessionId: 'session' } });
    for (const endpoint of ['http://127.0.0.1:123/a', 'http://127.0.0.1.attacker:123', 'https://public.invalid:123']) {
      const bad = fixture(); bad.env.LEX_CLAUDE_BRIDGE_URL = endpoint; await bad.start();
      expect(bad.$.clock.every).not.toHaveBeenCalled();
    }
    const stale = fixture(); stale.env.LEX_CLAUDE_BRIDGE_SESSION = 'other'; await stale.start();
    expect(stale.$.clock.every).not.toHaveBeenCalled();
  });

  it('passes stream identity, order and final value unchanged while the host is unavailable', async () => {
    const f = fixture(); await f.start();
    f.$.http.fetch.mockImplementation(() => new Promise(() => {}));
    void f.tick();
    const chunks = [{ kind: 'engine', ref: 1 }, { kind: 'text', index: 0, text: 'hello' }];
    const result = { answer: 'hello', usage: { outputTokens: 1 } };
    const next = vi.fn(async function* () { yield* chunks; return result; });
    const stream = f.hooks.get('turn.step')!(f.$, { turnId: 'turn', index: 0 }, next);
    expect((await stream.next()).value).toBe(chunks[0]);
    expect((await stream.next()).value).toBe(chunks[1]);
    expect((await stream.next()).value).toBe(result);
    expect(next).toHaveBeenCalledOnce();
  });

  it('reports an unserializable observation without breaking the native stream', async () => {
    const f = fixture(); await f.start();
    const opaque: any = { kind: 'engine', ref: 1 }; opaque.self = opaque;
    const stream = f.hooks.get('turn.step')!(f.$, { turnId: 'turn', index: 0 }, async function* () { yield opaque; return {}; });
    expect((await stream.next()).value).toBe(opaque);
    await stream.next(); await f.tick();
    expect(JSON.parse(f.$.http.fetch.mock.calls[0][1].body).overflow).toBe(true);
  });

  it('deduplicates commands without blocking abort or erasing an existing native draft', async () => {
    const f = fixture(); await f.start();
    let complete!: (input: { text: string }) => void;
    f.$.prompt.submit.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    f.commands.push({ id: 1, kind: 'submit', payload: { text: 'once' } });
    await f.tick();
    f.commands.push({ id: 1, kind: 'submit', payload: { text: 'once' } },
      { id: 2, kind: 'abort', payload: { turnId: 'turn' } }, { id: 3, kind: 'snapshot', payload: {} });
    await f.tick(); await f.flush();
    expect(f.$.prompt.submit).toHaveBeenCalledOnce();
    expect(f.$.turn.abort).toHaveBeenCalledWith({ turnId: 'turn' });
    expect(f.events.find((e) => e.kind === 'command-result' && e.value.id === 3).value.result.draft).toEqual({ text: 'draft', cursor: 2 });
    complete({ text: 'once' }); await f.flush();
    expect(f.events.filter((e) => e.kind === 'command-result' && e.value.id === 1)).toHaveLength(1);
  });

  it('binds only the built-in submission to its one native row, preserving external plugin provenance', async () => {
    const f = fixture(); await f.start();
    let complete!: (input: { text: string }) => void;
    f.$.prompt.submit.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    f.commands.push({ id: 1, kind: 'submit', payload: { text: 'identical' } }); await f.tick();
    for (const [uuid, name] of [['external', 'other-plugin'], ['ours', 'lex-native-bridge'], ['later', 'lex-native-bridge']]) {
      const input = { uuid, door: 'prompt', origin: { kind: 'plugin', name }, message: { type: 'user', content: [{ type: 'text', text: 'identical' }] } };
      const result = { uuid, message: input.message };
      expect(await f.hooks.get('session.append')!(f.$, input, async () => result)).toBe(result);
    }
    complete({ text: 'identical' }); await f.flush();
    expect(f.events.filter((e) => e.value.submissionId).map((e) => [e.value.uuid, e.value.submissionId])).toEqual([['ours', 1]]);
  });

  it('retires only the completing agent decision and ignores its late HTTP answer', async () => {
    const f = fixture(); await f.start(); await f.tick();
    const replies: Array<(reply: { ok: boolean; text: string }) => void> = [];
    const original = f.$.http.fetch.getMockImplementation()!;
    f.$.http.fetch.mockImplementation((url, init) => url.endsWith('/request')
      ? new Promise((resolve) => replies.push(resolve)) : original(url, init));
    const next = Object.assign(vi.fn(async () => ({ native: true })), { signal: new AbortController().signal });
    const decision = f.hooks.get('classic.PermissionRequest')!(f.$, { agent_id: 'one', tool_name: 'Write' }, next);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await f.hooks.get('turn.complete')!(f.$, { agentId: 'sibling' }, async () => ({}));
    await f.tick();
    expect(f.events.some((e) => e.kind === 'request-retired')).toBe(false);
    await f.hooks.get('turn.complete')!(f.$, { agentId: 'one' }, async () => ({}));
    replies[0]({ ok: true, text: JSON.stringify({ result: { behavior: 'allow' } }) });
    expect(await decision).toEqual({ native: true });
    await f.tick();
    expect(f.events.filter((e) => e.kind === 'request-retired')).toHaveLength(1);
  });
});
