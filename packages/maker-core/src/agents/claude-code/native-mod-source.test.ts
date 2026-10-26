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
    session: { id: async () => 'session', cwd: async () => '/owned/work', version: async () => ({ version: 'fixture' }), compact: vi.fn(async (_input: unknown): Promise<any> => ({ messages: [], tokensBefore: 900, tokensAfter: 200 })), usage: async () => ({}), model: async () => 'fixture' },
    clock: { every: vi.fn((_ms: number, callback: () => Promise<void>) => { tick = callback; return { cancel: vi.fn() }; }),
      sleep: vi.fn((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) },
    http: { fetch: vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      events.push(...body.events);
      return { ok: true, text: JSON.stringify({ acknowledged: body.events.at(-1)?.sequence ?? events.at(-1)?.sequence ?? 0, commands: commands.splice(0) }) };
    }) },
    prompt: { submit: vi.fn(async (input: { text: string }) => input), read: vi.fn(async () => ({ text: 'draft', cursor: 2 })),
      fill: vi.fn(async (_input: unknown) => ({ isFilled: true })) },
    turn: { abort: vi.fn(async (_input: unknown) => {}) },
    command: { run: vi.fn(async (_input: unknown) => ({ queued: true })) },
  };
  const start = () => hooks.get('session.start')!($, { isInteractive: true }, async (e: unknown) => e);
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await tick(); };
  return { $, hooks, env, start, flush, events, commands, tick: () => tick() };
}

describe('packaged Claude native Mod', () => {
  it('restores editor text only when fill and actual draft readback both agree, without submitting', async () => {
    const f = fixture(); await f.start();
    f.commands.push({ id: 1, kind: 'restore-draft', payload: { text: 'draft' } });
    await f.tick(); await f.flush();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'command-result', value: { id: 1, ok: true, result: { draft: { text: 'draft', cursor: 2 } } } }));
    expect(f.$.prompt.fill).toHaveBeenCalledWith({ text: 'draft', mode: 'replace' });
    f.commands.push({ id: 2, kind: 'restore-draft', payload: { text: 'changed by extension' } });
    await f.tick(); await f.flush();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'command-result', value: { id: 2, ok: false } }));
    f.$.prompt.fill.mockResolvedValueOnce({ isFilled: false });
    f.commands.push({ id: 3, kind: 'restore-draft', payload: { text: 'draft' } });
    await f.tick(); await f.flush();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'command-result', value: { id: 3, ok: false } }));
    expect(f.$.prompt.submit).not.toHaveBeenCalled(); expect(f.$.command.run).not.toHaveBeenCalled();
  });
  it('reports a committed compaction from the terminal or host command, excluding children and precompute', async () => {
    const f = fixture(); await f.start();
    const result = { messages: [{ text: 'private native summary' }], tokensBefore: 900, tokensAfter: 200 };
    const next = vi.fn(async () => result);
    expect(await f.hooks.get('session.compact')!(f.$, { trigger: 'manual' }, next)).toBe(result);
    await f.hooks.get('session.compact')!(f.$, { trigger: 'precompute' }, next);
    await f.hooks.get('session.compact')!(f.$, { trigger: 'auto', agentId: 'child' }, next);
    await f.hooks.get('session.compact')!(f.$, { trigger: 'auto' }, async () => ({ skip: 'native veto' }));
    await f.hooks.get('session.compact')!(f.$, { trigger: 'auto' }, async () => ({ skip: '' }));
    await expect(f.hooks.get('session.compact')!(f.$, { trigger: 'auto' }, async () => { throw new Error('compact failed'); })).rejects.toThrow('compact failed');
    f.commands.push({ id: 1, kind: 'compact', payload: { instructions: 'keep decisions' } });
    await f.tick(); await f.flush();
    expect(f.$.session.compact).toHaveBeenCalledWith({ instructions: 'keep decisions' });
    expect(f.events.filter(event => event.kind === 'session.compacted').map(event => event.value)).toEqual([
      { trigger: 'manual', tokensBefore: 900, tokensAfter: 200 },
      { trigger: 'plugin', tokensBefore: 900, tokensAfter: 200 },
    ]);
    expect(JSON.stringify(f.events.filter(event => event.kind === 'session.compacted'))).not.toContain('private native summary');
  });

  it('samples local native counters at root completion and preserves finality when the optional read fails', async () => {
    const f = fixture(); await f.start();
    const counters = { context: { window: 200000, tokens: 20 }, cost: { usd: 0.01 } };
    const read = vi.spyOn(f.$.session, 'usage').mockResolvedValue(counters);
    const next = vi.fn(async () => ({ text: 'native result' }));
    const terminal = { turnId: 'turn', reason: 'answer', answer: 'done' };
    expect(await f.hooks.get('turn.complete')!(f.$, terminal, next)).toEqual({ text: 'native result' });
    await f.tick();
    expect(read).toHaveBeenCalledWith();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'turn.complete', value: { ...terminal, sessionUsage: counters } }));
    read.mockRejectedValue(new Error('counter unavailable'));
    await f.hooks.get('turn.complete')!(f.$, { ...terminal, turnId: 'second' }, next); await f.tick();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'turn.complete', value: { ...terminal, turnId: 'second' } }));
    expect(next).toHaveBeenCalledTimes(2);
    await f.hooks.get('turn.complete')!(f.$, { ...terminal, agentId: 'child' }, next);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('uses the native full context API without running a slash command or modifying the terminal draft', async () => {
    const f = fixture(); await f.start();
    const usage = { context: { breakdown: { model: 'fixture', totalTokens: 42 } } };
    const read = vi.spyOn(f.$.session, 'usage').mockResolvedValue(usage);
    f.commands.push({ id: 1, kind: 'context-usage', payload: {} });
    await f.tick(); await f.flush();
    expect(read).toHaveBeenCalledWith({ breakdown: 'full' });
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'command-result', value: { id: 1, ok: true, result: usage } }));
    expect(f.$.command.run).not.toHaveBeenCalled(); expect(f.$.prompt.submit).not.toHaveBeenCalled();
    expect(f.$.prompt.read).not.toHaveBeenCalled();
  });

  it('binds identical overlapping permission calls to native IDs without changing the native input or verdict', async () => {
    const f = fixture(); await f.start();
    const exchange = f.$.http.fetch.getMockImplementation()!;
    const inputs: any[] = [];
    const answers: Array<(result: unknown) => void> = [];
    f.$.http.fetch.mockImplementation((url, init) => {
      if (!url.endsWith('/request')) return exchange(url, init);
      inputs.push(JSON.parse(init.body).request.input);
      return new Promise(resolve => answers.push(result => resolve({ ok: true, text: JSON.stringify({ result }) })));
    });
    const nativeInputs: any[] = [];
    const invoke = (id: string, agentId?: string) => {
      const controller = new AbortController();
      const verdict = { decision: 'ask', ceiling: 'ask', reason: 'native rule' };
      const check = Object.assign(async () => verdict, { signal: controller.signal });
      const input = { agent_id: agentId, tool_name: 'Read', tool_input: { file_path: '/same' } };
      nativeInputs.push(input);
      return f.hooks.get('tool.call')!(f.$, { tool_use_id: id, tool: 'Read', agentId, file_path: '/same' }, async () => {
        expect(await f.hooks.get('tool.check')!(f.$, { tool_use_id: id, tool: 'Read', input: input.tool_input }, check)).toBe(verdict);
        return f.hooks.get('classic.PermissionRequest')!(f.$, input,
          Object.assign(vi.fn(async (e: unknown) => { expect(e).toBe(input); return {}; }), { signal: controller.signal }));
      });
    };
    const running = [invoke('first'), invoke('second'), invoke('child', 'agent-child')];
    await vi.waitFor(() => expect(inputs).toHaveLength(3));
    expect(new Set(inputs.map(input => input.tool_use_id))).toEqual(new Set(['first', 'second', 'child']));
    expect(nativeInputs.every(input => !('tool_use_id' in input))).toBe(true);
    answers.forEach(answer => answer({ behavior: 'deny', message: 'GUI refusal' }));
    expect(await Promise.all(running)).toEqual(Array(3).fill({ decision: { behavior: 'deny', message: 'GUI refusal' } }));
    await f.tick();
    expect(f.events.filter(event => event.kind === 'permission')).toHaveLength(3);
    expect(f.events.filter(event => event.kind === 'request-retired')).toHaveLength(3);
  });

  it('retires a terminal-answered card at tool completion and ignores its late GUI answer', async () => {
    const f = fixture(); await f.start();
    const exchange = f.$.http.fetch.getMockImplementation()!;
    let lateAnswer!: (value: unknown) => void;
    f.$.http.fetch.mockImplementation((url, init) => url.endsWith('/request')
      ? new Promise(resolve => { lateAnswer = result => resolve({ ok: true, text: JSON.stringify({ result }) }); })
      : exchange(url, init));
    const signal = new AbortController().signal;
    const original = { tool_name: 'Write', tool_input: { file_path: '/same' } };
    const nativeDecision = { decision: { behavior: 'allow' } };
    const nativeNext = Object.assign(vi.fn(async () => nativeDecision), { signal });
    let pending!: Promise<unknown>;
    await f.hooks.get('tool.call')!(f.$, { tool: 'Write', tool_use_id: 'terminal-tool' }, async () => {
      await f.hooks.get('tool.check')!(f.$, { tool: 'Write', tool_use_id: 'terminal-tool' },
        Object.assign(async () => ({ decision: 'ask' }), { signal }));
      pending = f.hooks.get('classic.PermissionRequest')!(f.$, original, nativeNext);
      // The upstream terminal resolves the actual tool while its classic hook
      // is still awaiting an answer, as the real native probe demonstrates.
      return { content: 'native tool completed' };
    });
    await f.tick();
    expect(f.events.filter(event => event.kind === 'request-retired')).toHaveLength(1);
    expect(f.events.some(event => event.kind === 'turn.complete')).toBe(false);
    lateAnswer({ behavior: 'deny', message: 'stale GUI action' });
    expect(await pending).toBe(nativeDecision);
    expect(nativeNext).toHaveBeenCalledWith(original);
    await f.tick();
    expect(f.events.filter(event => event.kind === 'request-retired')).toHaveLength(1);
  });

  it.each(['allow', 'deny', 'ask'])('releases a %s scope when the native decider completes without a classic callback', async decision => {
    const f = fixture(); await f.start();
    const signal = new AbortController().signal;
    const check = (id: string, value: string) => f.hooks.get('tool.check')!(f.$, { tool: 'Read', tool_use_id: id },
      Object.assign(async () => ({ decision: value }), { signal }));
    await f.hooks.get('tool.call')!(f.$, { tool: 'Read', tool_use_id: 'automatic' }, () => check('automatic', decision));
    await f.hooks.get('tool.call')!(f.$, { tool: 'Read', tool_use_id: 'next' }, () => check('next', 'ask'));
    expect(f.$.clock.sleep).not.toHaveBeenCalled();
    await f.tick();
    expect(f.events.some(event => event.kind === 'permission')).toBe(false);
  });

  it('does not deadlock a repeated native check of the same call before its classic callback', async () => {
    const f = fixture(); await f.start();
    const signal = new AbortController().signal;
    const input = { tool: 'Read', tool_use_id: 'same-call' };
    const check = Object.assign(async () => ({ decision: 'ask' }), { signal });
    await f.hooks.get('tool.call')!(f.$, input, async () => {
      expect(await f.hooks.get('tool.check')!(f.$, input, check)).toEqual({ decision: 'ask' });
      expect(await f.hooks.get('tool.check')!(f.$, input, check)).toEqual({ decision: 'ask' });
    });
    expect(f.$.clock.sleep).not.toHaveBeenCalled();
  });

  it('keeps unscoped permission queries on their native path and does not infer identity from matching arguments', async () => {
    const f = fixture(); await f.start();
    const signal = new AbortController().signal;
    const input = { tool_name: 'Read', tool_input: { file_path: '/same' } };
    const native = Object.assign(vi.fn(async () => ({ decision: { behavior: 'deny' } })), { signal });
    await f.hooks.get('tool.check')!(f.$, { tool: 'Read', input: input.tool_input },
      Object.assign(async () => ({ decision: 'ask' }), { signal }));
    expect(await f.hooks.get('classic.PermissionRequest')!(f.$, input, native)).toEqual({ decision: { behavior: 'deny' } });
    expect(native).toHaveBeenCalledWith(input);
    await f.tick();
    expect(f.events.some(event => event.kind === 'permission')).toBe(false);
  });

  it('installs host preparation before native append and fences a refused input before provider I/O', async () => {
    for (const allow of [true, false]) {
      const f = fixture(); f.env.LEX_CLAUDE_BRIDGE_INPUT_PREPARATION = '1'; f.env.LEX_CLAUDE_BRIDGE_TURN_ADMISSION = '1'; await f.start();
      const original = f.$.http.fetch.getMockImplementation()!;
      f.$.http.fetch.mockImplementation(async (url, init) => {
        if (!url.endsWith('/request')) return original(url, init);
        return { ok: true, text: JSON.stringify({ result: { allow, content: [{ type: 'text', text: 'rewritten' }] } }) };
      });
      const e = { uuid: 'native-row', door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text: 'original' }] } };
      const append = Object.assign(vi.fn(async (value: any) => ({ uuid: value.uuid, message: value.message })), { signal: new AbortController().signal });
      await f.hooks.get('session.append')!(f.$, e, append);
      expect(append.mock.calls[0]?.[0].message.content[0].text).toBe(allow ? 'rewritten' : '[Input was not submitted by Lex.]');
      await f.hooks.get('turn.start')!(f.$, { turnId: 'turn', text: 'original' }, async () => ({ turnId: 'turn' }));
      const provider = Object.assign(vi.fn(async function* () { return {}; }), { signal: new AbortController().signal });
      const stream = f.hooks.get('turn.step')!(f.$, { turnId: 'turn', index: 0 }, provider);
      while (!(await stream.next()).done) {}
      expect(provider).toHaveBeenCalledTimes(allow ? 1 : 0);
      await f.tick();
      const appendIndex = f.events.findIndex(event => event.kind === 'session.append');
      const retiredIndex = f.events.findIndex(event => event.kind === 'request-retired');
      expect(appendIndex).toBeGreaterThan(-1); expect(retiredIndex).toBeGreaterThan(appendIndex);
    }
  });

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

  it.each(['media', 'opaque', 'changed-receipt'])('removes refused content before future turns and faults an unverifiable %s row', async kind => {
    const f = fixture(); f.env.LEX_CLAUDE_BRIDGE_INPUT_PREPARATION = '1'; await f.start();
    const original = f.$.http.fetch.getMockImplementation()!;
    f.$.http.fetch.mockImplementation(async (url, init) => url.endsWith('/request')
      ? { ok: true, text: JSON.stringify({ result: { allow: false } }) } : original(url, init));
    const input = { uuid: 'row', door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', content: [
      { type: 'text', text: 'REFUSED_PRIVATE_INPUT' },
      kind === 'opaque' ? { type: 'opaque', value: 'private' } : { type: 'image', source: { data: 'private' } },
    ] } };
    const append = Object.assign(vi.fn(async (e: any) => ({ uuid: e.uuid, message: kind === 'changed-receipt' ? input.message : e.message })),
      { signal: new AbortController().signal });
    await f.hooks.get('session.append')!(f.$, input, append);
    expect(append.mock.calls[0]?.[0].message.content).toEqual([{ type: 'text', text: '[Input was not submitted by Lex.]' }]);
    await f.tick();
    const exchange = f.$.http.fetch.mock.calls.find(([url]) => url.endsWith('/exchange'))!;
    expect(JSON.parse(exchange[1].body).overflow).toBe(kind !== 'media');
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

  it('does not let a child turn consume the root native input receipt', async () => {
    const f = fixture(); f.env.LEX_CLAUDE_BRIDGE_TURN_ADMISSION = '1'; await f.start();
    const row = { uuid: 'root-row', door: 'prompt', origin: { kind: 'composer' },
      message: { type: 'user', content: [{ type: 'text', text: 'root input' }] } };
    await f.hooks.get('session.append')!(f.$, row, async () => ({ uuid: row.uuid, message: row.message }));
    await f.hooks.get('turn.start')!(f.$, { turnId: 'child-turn', agentId: 'child' }, async () => ({}));
    await f.hooks.get('turn.start')!(f.$, { turnId: 'root-turn' }, async () => ({}));
    await f.tick();
    expect(f.events.filter(event => event.kind === 'turn.start').map(event => event.value)).toEqual([
      { turnId: 'child-turn', agentId: 'child', messageIds: [] },
      { turnId: 'root-turn', messageIds: ['root-row'] },
    ]);
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
    const decision = f.hooks.get('tool.call')!(f.$, { agentId: 'one', tool: 'Write', tool_use_id: 'one-tool' }, async () => {
      await f.hooks.get('tool.check')!(f.$, { tool: 'Write', tool_use_id: 'one-tool' },
        Object.assign(async () => ({ decision: 'ask' }), { signal: next.signal }));
      return f.hooks.get('classic.PermissionRequest')!(f.$, { agent_id: 'one', tool_name: 'Write' }, next);
    });
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
