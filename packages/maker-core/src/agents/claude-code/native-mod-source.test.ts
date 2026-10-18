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
    session: { id: async () => 'session', cwd: async () => '/owned/work', version: async () => ({ version: 'fixture' }), usage: async () => ({}), model: async () => 'fixture' },
    clock: { every: vi.fn((_ms: number, callback: () => Promise<void>) => { tick = callback; return { cancel: vi.fn() }; }) },
    http: { fetch: vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      events.push(...body.events);
      return { ok: true, text: JSON.stringify({ acknowledged: body.events.at(-1)?.sequence ?? events.at(-1)?.sequence ?? 0, commands: commands.splice(0) }) };
    }) },
    prompt: { submit: vi.fn(async (input: { text: string }) => input), read: vi.fn(async () => ({ text: 'draft', cursor: 2 })) },
    turn: { abort: vi.fn(async (_input: unknown) => {}) },
    command: { run: vi.fn(async (_input: unknown) => ({ queued: true })) },
  };
  const start = () => hooks.get('session.start')!($, { isInteractive: true }, async (e: unknown) => e);
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await tick(); };
  return { $, hooks, env, start, flush, events, commands, tick: () => tick() };
}

describe('packaged Claude native Mod', () => {
  it('holds the first native model call behind host admission and refuses provider work when unavailable', async () => {
    for (const allow of [true, false]) {
      const f = fixture(); f.env.LEX_CLAUDE_BRIDGE_TURN_ADMISSION = '1'; await f.start();
      const original = f.$.http.fetch.getMockImplementation()!;
      const requests: any[] = [];
      f.$.http.fetch.mockImplementation(async (url, init) => {
        if (!url.endsWith('/request')) return original(url, init);
        requests.push(JSON.parse(init.body).request);
        return { ok: true, text: JSON.stringify({ result: { allow } }) };
      });
      const e = { uuid: 'native-row', door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text: 'hello' }] } };
      await f.hooks.get('session.append')!(f.$, e, async (value: any) => ({ uuid: value.uuid, message: value.message }));
      await f.hooks.get('turn.start')!(f.$, { turnId: 'turn', text: 'hello' }, async () => ({ turnId: 'turn' }));
      const provider = Object.assign(vi.fn(async function* () { yield { kind: 'text', index: 0, text: 'response' }; return {}; }), { signal: new AbortController().signal });
      const stream = f.hooks.get('turn.step')!(f.$, { turnId: 'turn', index: 0 }, provider);
      while (!(await stream.next()).done) {}
      await f.tick();
      expect(f.events.find(event => event.kind === 'turn.start').value.messageIds).toEqual(['native-row']);
      expect(requests).toMatchObject([{ kind: 'turn-admission', input: { turnId: 'turn' } }]);
      if (allow) { expect(provider).toHaveBeenCalledOnce(); expect(f.$.turn.abort).not.toHaveBeenCalled(); }
      else { expect(provider).not.toHaveBeenCalled(); expect(f.$.turn.abort).toHaveBeenCalledWith({ turnId: 'turn' }); }
    }
  });

  it('forwards the native tool scope to the existing host hook and preserves native refusal', async () => {
    const f = fixture(); f.env.LEX_CLAUDE_BRIDGE_HOST_HOOKS = '1'; await f.start();
    const original = f.$.http.fetch.getMockImplementation()!;
    const calls: any[] = [];
    f.$.http.fetch.mockImplementation(async (url, init) => {
      if (!url.endsWith('/request')) return original(url, init);
      calls.push(JSON.parse(init.body).request);
      return { ok: true, text: JSON.stringify({ result: { deny: 'host boundary', updatedInput: { file_path: '/processed' } } }) };
    });
    const envelope = { tool: 'Read', tool_use_id: 'tool-1', agentId: 'child', file_path: '/original' };
    const next = Object.assign(async () => ({ updatedInput: { file_path: '/native-rewrite' } }), { signal: new AbortController().signal });
    const result = await f.hooks.get('tool.call')!(f.$, envelope,
      () => f.hooks.get('classic.PreToolUse')!(f.$, envelope, next));
    expect(result).toEqual({ deny: 'host boundary', updatedInput: { file_path: '/processed' } });
    expect(calls[0]).toMatchObject({ kind: 'hook', input: { hook_event_name: 'PreToolUse', session_id: 'session',
      tool_name: 'Read', tool_use_id: 'tool-1', agent_id: 'child', tool_input: { file_path: '/native-rewrite' } } });
    const refuse = Object.assign(async () => ({ deny: 'native policy' }), { signal: new AbortController().signal });
    expect(await f.hooks.get('classic.PreToolUse')!(f.$, envelope, refuse)).toEqual({ deny: 'native policy' });
    expect(calls).toHaveLength(1);
    expect(await f.hooks.get('classic.PreToolUse')!(f.$, envelope, next)).toMatchObject({ deny: expect.any(String) });
  });

  it('does not execute a tool when an enabled host hook is unreachable', async () => {
    const f = fixture(); f.env.LEX_CLAUDE_BRIDGE_HOST_HOOKS = '1'; await f.start();
    f.$.http.fetch.mockRejectedValue(new Error('offline'));
    const envelope = { tool: 'Write', tool_use_id: 'tool-1', file_path: '/owned/file' };
    const next = Object.assign(async () => ({ allow: true }), { signal: new AbortController().signal });
    expect(await f.hooks.get('tool.call')!(f.$, envelope,
      () => f.hooks.get('classic.PreToolUse')!(f.$, envelope, next))).toEqual({ deny: 'Lex host tool policy is unavailable' });
  });

  it('keeps media identity after early enqueue acknowledgment and preserves literal body', async () => {
    const f = fixture(); await f.start();
    const text = 'literal $ARGUMENTS @not-an-attachment !shell';
    f.commands.push({ id: 1, kind: 'submit', payload: { text, imagePaths: ['/owned media/a.png'] } });
    await f.tick(); await f.flush();
    expect(f.$.command.run).toHaveBeenCalledWith({ command: 'lex-native-bridge:send', args: 'LEX_SUBMISSION_generation_1 @"/owned media/a.png"' });
    expect(f.events.some(event => event.kind === 'command-result' && event.value.id === 1)).toBe(false);
    f.commands.push({ id: 2, kind: 'submit', payload: { text: 'next' } }); await f.tick();
    expect(f.$.prompt.submit).not.toHaveBeenCalled();
    const append = async (uuid: string, door: string, isMeta: boolean, name = 'lex-native-bridge') => {
      const e = { uuid, door, origin: { kind: 'plugin', name }, message: { type: 'user', isMeta,
        content: [{ type: 'text', text: 'LEX_SUBMISSION_generation_1 @"/owned media/a.png"' }] } };
      const next = vi.fn(async (input) => ({ uuid: input.uuid, message: input.message }));
      const result = await f.hooks.get('session.append')!(f.$, e, next);
      return { e, next, result };
    };
    const unrelated = await append('external', 'prompt', true, 'another-plugin');
    expect(unrelated.next).toHaveBeenCalledWith(unrelated.e);
    await append('command', 'command', false);
    const bound = await append('meta', 'prompt', true);
    expect(bound.result.message.content).toEqual([{ type: 'text', text }]);
    await f.flush();
    expect(f.$.prompt.submit).toHaveBeenCalledWith({ text: 'next' });
    expect(f.events.filter(event => event.kind === 'command-result' && event.value.id === 1)).toHaveLength(1);
    expect(f.events.find(event => event.kind === 'session.append' && event.value.uuid === 'command').value.submissionId).toBe(1);
    expect(f.events.find(event => event.kind === 'session.append' && event.value.uuid === 'meta').value.commandMessageId).toBe('command');
  });

  it('rejects malformed media paths without invoking a native command', async () => {
    const f = fixture(); await f.start();
    f.commands.push({ id: 1, kind: 'submit', payload: { text: 'hello', imagePaths: ['unsafe"name'] } });
    await f.tick(); await f.flush();
    expect(f.$.command.run).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'command-result', value: { id: 1, ok: false } }));
  });

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
