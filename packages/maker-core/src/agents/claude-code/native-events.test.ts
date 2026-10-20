import { describe, expect, it } from 'vitest';
import { ClaudeNativeEvents } from './native-events.js';
import type { AgentEvent } from '../../types/events.js';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, model: 'actual-model' };
function fixture() {
  const events: AgentEvent[] = [];
  const adapter = new ClaudeNativeEvents('session', event => events.push(event));
  let sequence = 0;
  const send = (kind: string, value: unknown) => adapter.accept({ sequence: ++sequence, kind, value });
  const begin = () => { send('turn.start', { turnId: 'turn' }); send('step-start', { turnId: 'turn', index: 0, model: 'actual-model' }); };
  return { events, adapter, send, begin };
}

describe('Claude native structured product events', () => {
  it('provides the shared renderer status contract throughout native input and usage updates', () => {
    const f = fixture();
    f.send('session.compacted', { trigger: 'manual', tokensAfter: 200 });
    f.begin();
    f.send('step-result', { turnId: 'turn', index: 0, usage });
    f.send('session.compacted', { trigger: 'auto', tokensAfter: 100 });
    f.send('turn.complete', { turnId: 'turn', reason: 'answer', usage });
    expect(f.events.filter(event => event.type === 'status').map(event => {
      const data = event.data as { status: string; isRunning: boolean };
      return { status: data.status, isRunning: data.isRunning };
    })).toEqual([
      { status: 'Done', isRunning: false },
      { status: 'Working', isRunning: true },
      { status: 'Working', isRunning: true },
      { status: 'Working', isRunning: true },
      { status: 'Done', isRunning: false },
    ]);
  });

  it('projects root compaction outside a turn without fabricating finality or missing token counts', () => {
    const f = fixture(); f.adapter.usage.setContextTokensAfterCompact(900);
    f.send('session.compacted', { trigger: 'manual', tokensBefore: 900, tokensAfter: 200 });
    expect(f.adapter.usage.snapshot().contextTokens).toBe(200);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'compact_boundary', data: {
      boundaryId: expect.stringContaining('native-compact:'), trigger: 'manual', preTokens: 900, postTokens: 200,
    } }));
    expect(f.events.at(-1)).toMatchObject({ type: 'status', data: { isRunning: false } });
    f.send('session.compacted', { trigger: 'plugin' });
    expect(f.adapter.usage.snapshot().contextTokens).toBe(200);
    expect(f.events.at(-2)?.data).not.toHaveProperty('postTokens');
    const size = f.events.length;
    f.send('session.compacted', { trigger: 'precompute', tokensAfter: 1 });
    f.send('session.compacted', { trigger: 'auto', agentId: 'child', tokensAfter: 1 });
    expect(f.events).toHaveLength(size); expect(f.events.some(event => event.type === 'done')).toBe(false);
  });

  it('retains the active turn and the compacted context through its terminal aggregate', () => {
    const f = fixture(); f.begin(); f.send('step-result', { turnId: 'turn', index: 0, usage });
    f.send('session.compacted', { trigger: 'auto', tokensBefore: 900, tokensAfter: 200 });
    expect(f.events.at(-1)).toMatchObject({ type: 'status', data: { contextTokens: 200, isRunning: true } });
    f.send('session.compacted', { trigger: 'plugin' });
    f.send('turn.complete', { turnId: 'turn', reason: 'answer', usage });
    expect(f.adapter.usage.snapshot().contextTokens).toBe(200);
    expect(f.events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('preserves a reported zero after compact and does not reuse boundary identities across native lifetimes', () => {
    const f = fixture(), reopened = fixture(); f.begin();
    f.send('session.compacted', { trigger: 'auto', tokensAfter: 0 });
    f.send('turn.complete', { turnId: 'turn', reason: 'answer', usage });
    expect(f.adapter.usage.snapshot().contextTokens).toBe(0);
    reopened.begin(); reopened.send('session.compacted', { trigger: 'auto', tokensAfter: 0 });
    const boundary = (events: typeof f.events) => (events.find(event => event.type === 'compact_boundary')!.data as any).boundaryId;
    expect(boundary(f.events)).not.toBe(boundary(reopened.events));
  });

  it('uses cumulative native cost without adding it twice and preserves the selected route window', () => {
    const f = fixture(); f.adapter.usage.setContextWindow(64000); f.begin();
    f.send('step-result', { turnId: 'turn', index: 0, usage });
    f.send('turn.complete', { turnId: 'turn', reason: 'answer', usage,
      sessionUsage: { context: { window: 1000000, tokens: 30 }, cost: { usd: 0.12 } } });
    expect(f.adapter.usage.snapshot()).toMatchObject({ costUsd: 0.12, contextWindow: 64000, contextTokens: 30 });
    expect(f.events.at(-1)).toMatchObject({ type: 'done', data: { total_cost_usd: 0.12, usageSegmentsComplete: false } });
    f.send('turn.start', { turnId: 'second' }); f.send('step-start', { turnId: 'second', index: 0 });
    f.send('step-result', { turnId: 'second', index: 0, usage });
    f.send('turn.complete', { turnId: 'second', reason: 'answer', usage,
      sessionUsage: { context: { window: 1000000 }, cost: { usd: 0.2 } } });
    expect(f.adapter.usage.snapshot().costUsd).toBe(0.2);
    expect(f.events.at(-1)).toMatchObject({ data: { total_cost_usd: 0.2 } });
  });

  it('fills an unknown window from native counters and ignores absent or malformed cost', () => {
    const f = fixture(); f.begin();
    f.send('step-result', { turnId: 'turn', index: 0, usage });
    f.send('turn.complete', { turnId: 'turn', reason: 'answer', usage,
      sessionUsage: { context: { window: 200000 }, cost: { usd: Number.NaN } } });
    expect(f.adapter.usage.snapshot()).toMatchObject({ contextWindow: 200000, costUsd: 0 });
    expect(f.events.at(-1)?.data).not.toHaveProperty('total_cost_usd');
    expect(f.events.at(-1)).toMatchObject({ type: 'done', data: { usage } });
  });

  it('does not project a refused native turn into an unrelated product reservation', () => {
    const events: AgentEvent[] = [];
    const adapter = new ClaudeNativeEvents('session', event => events.push(event), undefined, undefined, true);
    adapter.accept({ sequence: 1, kind: 'turn.start', value: { turnId: 'refused' } });
    adapter.accept({ sequence: 2, kind: 'turn.complete', value: { turnId: 'refused', reason: 'aborted', isAborted: true } });
    expect(events).toEqual([]);
    expect(() => adapter.admitTurn('refused')).toThrow('identity changed');
    adapter.accept({ sequence: 3, kind: 'turn.start', value: { turnId: 'accepted' } });
    expect(events).toEqual([]);
    adapter.admitTurn('accepted'); adapter.admitTurn('accepted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status', data: { isRunning: true } });
    adapter.accept({ sequence: 4, kind: 'turn.complete', value: { turnId: 'accepted', reason: 'answer', isAborted: false } });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('faults if the provider runs without product admission', () => {
    const adapter = new ClaudeNativeEvents('session', () => {}, undefined, undefined, true);
    adapter.accept({ sequence: 1, kind: 'turn.start', value: { turnId: 'turn' } });
    expect(() => adapter.accept({ sequence: 2, kind: 'step-start', value: { turnId: 'turn', index: 0 } })).toThrow('preceded product admission');
  });

  it('streams before the assistant receipt and attaches only the real transcript UUID', () => {
    const f = fixture(); f.begin();
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'text', index: 0, text: 'hello' } });
    expect(f.events.at(-1)).toMatchObject({ type: 'text', data: { text: 'hello', isFinal: false },
      agentMeta: { nativeTurnId: 'turn', nativeStep: 0, sdkSessionId: 'session', model: 'actual-model' } });
    expect(f.events.at(-1)?.agentMeta).not.toHaveProperty('uuid');
    f.send('session.append', { uuid: 'native-row', nativeTurnId: 'turn', nativeStep: 0, result: { uuid: 'native-row',
      message: { type: 'assistant', content: [{ type: 'text', text: 'hello' }] } } });
    expect(f.events.at(-1)).toMatchObject({ type: 'text', data: { text: 'hello', isFinal: true }, agentMeta: { uuid: 'native-row' } });
    expect(f.events.every(event => !event.agentMeta?.requestId)).toBe(true);
  });

  it('counts a stop and repeated result once and keeps aggregate usage separate from request completeness', () => {
    const f = fixture(); f.begin();
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'stop', usage } });
    f.send('step-result', { turnId: 'turn', index: 0, usage });
    expect(f.adapter.usage.getTurnUsage()).toEqual({ input: 10, output: 5, cacheRead: 20, cacheCreate: 0 });
    f.send('turn.complete', { turnId: 'turn', reason: 'answer', isAborted: false, answer: 'hello', durationMs: 50, usage });
    expect(f.events.at(-1)).toMatchObject({ type: 'done', data: { result: 'hello', usage, usageSegmentsComplete: false,
      usageSegments: [{ id: 'native:turn:0', inputTokens: 10, outputTokens: 5, model: 'actual-model' }] } });
    expect(f.adapter.usage.getTurnUsage().input).toBe(0);
    expect(f.adapter.usage.snapshot().contextTokens).toBe(30);
    expect(f.adapter.usage.snapshot().costUsd).toBe(0);
  });

  it('finishes thinking once and excludes child finality and usage from the root task', () => {
    const f = fixture(); f.begin();
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'thinking', index: 0, text: 'consider' } });
    f.send('chunk', { turnId: 'child', agentId: 'child', step: 0, chunk: { kind: 'text', index: 0, text: 'child' } });
    f.send('turn.complete', { turnId: 'child', agentId: 'child', reason: 'answer', usage });
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'stop', usage } });
    f.send('step-result', { turnId: 'turn', index: 0, usage });
    expect(f.events.filter(event => event.type === 'thinking').map(event => (event.data as { stage: string }).stage)).toEqual(['start', 'delta', 'final']);
    expect(f.events.some(event => event.type === 'done')).toBe(false);
    expect(f.events.some(event => event.type === 'text')).toBe(false);
  });

  it('pairs native tool identities and errors without guessing opaque results or plugin calls', () => {
    const f = fixture(); f.begin();
    f.send('tool.call', { tool_use_id: 'plugin-id', tool: 'Bash', input: {} });
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'tool', id: 'tool-id', name: 'Write', index: 0 } });
    f.send('session.append', { uuid: 'row', nativeTurnId: 'turn', nativeStep: 0, result: { uuid: 'row', message: { type: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-id', name: 'Write', input: { file_path: 'fixture' } }] } } });
    f.send('tool.call', { tool_use_id: 'tool-id', tool: 'Write', file_path: 'fixture' });
    f.send('tool.result', { tool_use_id: 'tool-id', result: { deny: 'refused' } });
    f.send('tool.result', { tool_use_id: 'tool-id', result: { text: 'late result' } });
    expect(f.events.filter(event => event.type === 'tool_use')).toHaveLength(1);
    expect(f.events.filter(event => event.type === 'tool_result_full')).toEqual([expect.objectContaining({
      data: { toolUseId: 'tool-id', fullText: 'refused', isError: true },
    })]);
  });

  it('preserves flattened native tool arguments before the assistant receipt', () => {
    const f = fixture(); f.begin();
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'tool', id: 'tool-id', name: 'mcp__fixture__echo', index: 0 } });
    f.send('tool.call', { tool_use_id: 'tool-id', tool: 'mcp__fixture__echo', consent: 'native context', input: { nested: true }, count: 2 });
    expect(f.events.at(-1)).toMatchObject({ type: 'tool_use', data: { toolUseId: 'tool-id',
      toolName: 'mcp__fixture__echo', input: { input: { nested: true }, count: 2 } } });
    expect(f.events.at(-1)!.data).not.toHaveProperty('input.tool_use_id');
    expect(f.events.at(-1)!.data).not.toHaveProperty('input.tool');
    expect(f.events.at(-1)!.data).not.toHaveProperty('input.consent');
    f.send('session.append', { uuid: 'row', nativeTurnId: 'turn', nativeStep: 0, result: { uuid: 'row',
      message: { type: 'assistant', content: [{ type: 'tool_use', id: 'tool-id', name: 'mcp__fixture__echo',
        input: { input: { nested: true }, count: 2 } }] } } });
    expect(f.events.filter(event => event.type === 'tool_use')).toHaveLength(1);
  });

  it('rejects a tool name changed between model output and the native call', () => {
    const f = fixture(); f.begin();
    f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'tool', id: 'tool-id', name: 'Write', index: 0 } });
    expect(() => f.send('tool.call', { tool_use_id: 'tool-id', tool: 'Bash', command: 'echo fixture' })).toThrow('identity changed');
    expect(f.events.some(event => event.type === 'tool_use')).toBe(false);
  });

  it.each(['answer', 'aborted', 'error', 'refusal'])('preserves %s finality exactly once', reason => {
    const f = fixture(); f.begin();
    const terminal = { turnId: 'turn', reason, isAborted: reason === 'aborted', answer: '' };
    f.send('turn.complete', terminal); f.send('turn.complete', terminal);
    expect(f.events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(f.events.filter(event => event.type === 'error')).toHaveLength(reason === 'error' || reason === 'refusal' ? 1 : 0);
    expect((f.events.at(-1)!.data as { silentStop?: boolean }).silentStop).toBe(reason === 'aborted' ? true : undefined);
    expect(f.events.at(-2)).toMatchObject({ type: 'status', data: { status: 'Done', isRunning: false } });
  });

  it('settles a policy-denied tool from its actual transcript without requiring tool.call', () => {
    const f = fixture(); f.begin();
    f.send('session.append', { uuid: 'assistant', nativeTurnId: 'turn', nativeStep: 0, result: { uuid: 'assistant',
      message: { type: 'assistant', content: [{ type: 'tool_use', id: 'blocked', name: 'Write', input: {} }] } } });
    f.send('session.append', { uuid: 'result', door: 'tool-result', result: { uuid: 'result',
      message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'blocked', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } } });
    expect(f.events.at(-1)).toMatchObject({ type: 'tool_result_full', data: { toolUseId: 'blocked', fullText: 'denied', isError: true } });
  });

  it('refuses gaps and unknown terminal states, ignores stale scoped rows, and retires on close', () => {
    const f = fixture();
    expect(() => f.adapter.accept({ sequence: 2, kind: 'ready', value: {} })).toThrow('gap');
    f.begin();
    const length = f.events.length;
    f.send('session.append', { uuid: 'old', nativeTurnId: 'old-turn', nativeStep: 0, result: { uuid: 'old',
      message: { type: 'assistant', content: [{ type: 'text', text: 'stale' }] } } });
    expect(f.events).toHaveLength(length);
    expect(() => f.send('turn.complete', { turnId: 'turn', reason: 'unknown' })).toThrow('terminal');
    f.adapter.close(); f.send('chunk', { turnId: 'turn', step: 0, chunk: { kind: 'text', index: 0, text: 'late' } });
    expect(f.events).toHaveLength(length);
  });
});
