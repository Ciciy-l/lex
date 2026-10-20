import { afterEach, describe, expect, it, vi } from 'vitest';
import { OMP_NATIVE_EXTENSION_SOURCE } from './native-extension-source.js';

type Message = { role: string; content: { type: string; text: string }[]; timestamp: number };
type Entry = { id: string; parentId: string | null; type: string; message: Message };
const shutdowns: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of shutdowns.splice(0)) await stop(); });
async function fixture(accepted = true) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const rows: Entry[] = [], requests: Record<string, any>[] = [], faults: Record<string, any>[] = [];
  const ctx = { mode: 'tui', abort: vi.fn(), shutdown: vi.fn(), isIdle: () => true, hasPendingMessages: () => false,
    model: { id: 'model', contextWindow: 1234 }, ui: { notify: vi.fn(), setEditorText: vi.fn() },
    sessionManager: { getSessionFile: () => '/managed/original.jsonl', getSessionId: () => 'original-native-session',
      getEntries: () => [...rows], getBranch: () => [...rows], getLeafId: () => rows.at(-1)?.id ?? null },
  };
  const api = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
    handlers.set(name, [...handlers.get(name) ?? [], handler]);
  }, registerTool: vi.fn(), sendUserMessage: vi.fn(), setThinkingLevel: vi.fn() };
  const fetch = vi.fn(async (url: string, options: { body: string }) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/exchange')) return { ok: true, json: async () => ({ acknowledged: body.events.at(-1)?.sequence ?? 0, commands: [] }) };
    (body.request.kind === 'native-fault' ? faults : requests).push(body);
    return { ok: true, json: async () => ({ result: { accepted, text: 'product prepared' } }) };
  });
  const source = OMP_NATIVE_EXTENSION_SOURCE.replace("import { readFileSync } from 'node:fs';", '')
    .replace("import { randomUUID } from 'node:crypto';", '').replace('export default function', 'return function');
  let submission = 0;
  const activate = new Function('process', 'readFileSync', 'fetch', 'randomUUID', source)({ env: { LEX_OMP_BRIDGE_URL: 'http://127.0.0.1:1',
    LEX_OMP_BRIDGE_TOKEN: 'test-only', LEX_OMP_BRIDGE_GENERATION: 'generation', LEX_OMP_BRIDGE_SESSION: 'product-task' } }, () => '[]', fetch, () => 'submission-' + ++submission);
  activate(api);
  const emit = async (name: string, event: unknown = {}) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; };
  shutdowns.push(() => emit('session_shutdown'));
  await emit('session_start');
  const row = (id: string, text = 'native text'): Entry => ({ id, parentId: rows.at(-1)?.id ?? null, type: 'message',
    message: { role: 'user', timestamp: 1000, content: [{ type: 'text', text }] } });
  return { emit, ctx, rows, row, requests, fetch, faults };
}
describe('OMP official extension native input gate', () => {
  it('prepares before input events, then binds the real journal row before the original provider request', async () => {
    const f = await fixture(), row = f.row('real-journal-row');
    const event = { messages: [structuredClone(row.message)] };
    expect(await f.emit('context', event)).toMatchObject({ messages: [{ content: [{ text: 'product prepared' }] }] });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ sessionId: 'product-task', generation: 'generation', request: { kind: 'prepare-input',
      input: { sessionFile: '/managed/original.jsonl', submissionId: 'submission-1', message: row.message } } });
    expect(f.requests[0].request.input).not.toHaveProperty('row');
    // Pinned OMP agent-loop emits these only AFTER prepareProviderCall/context.
    f.rows.push(row);
    await f.emit('message_end', { type: 'message_end', message: row.message });
    const payload = { model: 'model', messages: ['original-engine-payload'] };
    expect(await f.emit('before_provider_request', { payload })).toBeUndefined();
    expect(payload.messages).toEqual(['original-engine-payload']);
    expect(f.requests[1].request).toMatchObject({ kind: 'input-receipt',
      input: { submissionId: 'submission-1', row: { id: 'real-journal-row' } } });
    expect(f.ctx.abort).not.toHaveBeenCalled();
    await f.emit('context', event); await f.emit('before_provider_request'); expect(f.requests).toHaveLength(2);
  });
  it('aborts before provider execution when a user row has not been persisted', async () => {
    const f = await fixture();
    await f.emit('context', { messages: [f.row('not-persisted').message] });
    vi.useFakeTimers();
    try {
      const pending = f.emit('before_provider_request');
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;
    } finally { vi.useRealTimers(); }
    expect(f.ctx.abort).toHaveBeenCalled(); expect(f.requests).toHaveLength(1);
    expect(f.requests[0].request.kind).toBe('prepare-input');
    expect(f.faults[0].request.input).toEqual({ sessionFile: '/managed/original.jsonl', phase: 'journal-receipt-unavailable' });
  });
  it('waits for the independent journal commit before admitting the exact native row', async () => {
    const f = await fixture(), row = f.row('delayed-real-row');
    await f.emit('context', { messages: [structuredClone(row.message)] });
    // Events are emitted after context; their independent commit can then settle.
    const commit = setTimeout(() => f.rows.push(row), 0);
    try {
      await f.emit('before_provider_request');
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1].request.input.row.id).toBe('delayed-real-row');
      expect(f.ctx.abort).not.toHaveBeenCalled();
    } finally { clearTimeout(commit); }
  });
  it('refuses a session identity change while waiting for the real journal row', async () => {
    const f = await fixture(), row = f.row('delayed-other-session');
    await f.emit('context', { messages: [row.message] });
    const change = setTimeout(() => vi.spyOn(f.ctx.sessionManager, 'getSessionFile').mockReturnValue('/different/session.jsonl'), 0);
    try {
      await f.emit('before_provider_request');
      expect(f.ctx.abort).toHaveBeenCalled();
      expect(f.requests).toHaveLength(1);
    } finally { clearTimeout(change); }
  });
  it('refuses repeated-text ambiguity instead of inventing a journal association', async () => {
    const f = await fixture(), row = f.row('real-row');
    await f.emit('context', { messages: [row.message, structuredClone(row.message)] });
    expect(f.ctx.abort).toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
  });
  it('aborts on owner refusal and never resubmits the rejected row on a continuation', async () => {
    const f = await fixture(false), row = f.row('refused-row');
    await f.emit('context', { messages: [row.message] });
    expect(f.ctx.abort).toHaveBeenCalled(); expect(f.requests).toHaveLength(1);
    await f.emit('context', { messages: [row.message] });
    expect(f.requests).toHaveLength(1);
  });
  it('retains each owner-prepared message when a later user input adds another journal row', async () => {
    const f = await fixture(), first = f.row('row-one', 'first native input');
    await f.emit('context', { messages: [first.message] });
    f.rows.push(first); await f.emit('before_provider_request');
    await f.emit('agent_end', { type: 'agent_end', willContinue: false });
    const second = f.row('row-two', 'second native input');
    const answer = await f.emit('context', { messages: [first.message, second.message] });
    expect(answer).toEqual({ messages: [
      { ...first.message, content: [{ type: 'text', text: 'product prepared' }] },
      { ...second.message, content: [{ type: 'text', text: 'product prepared' }] },
    ] });
    f.rows.push(second); await f.emit('before_provider_request');
    expect(f.requests).toHaveLength(4);
    expect(f.ctx.abort).not.toHaveBeenCalled();
  });
  it('refuses two persisted candidates rather than choosing a same-text journal row', async () => {
    const f = await fixture(), row = f.row('real-row');
    await f.emit('context', { messages: [row.message] });
    f.rows.push(row, { ...row, id: 'ambiguous-copy' });
    await f.emit('before_provider_request');
    expect(f.ctx.abort).toHaveBeenCalled(); expect(f.requests).toHaveLength(1);
  });
  it('shares the original admission deadline across preparation and the later journal receipt', async () => {
    const f = await fixture(), row = f.row('late-row');
    vi.useFakeTimers();
    try {
      await f.emit('context', { messages: [row.message] });
      await vi.advanceTimersByTimeAsync(8_000);
      f.rows.push(row); await f.emit('before_provider_request');
      expect(f.requests).toHaveLength(1); expect(f.ctx.abort).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
