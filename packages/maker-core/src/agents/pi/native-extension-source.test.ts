import { afterEach, describe, expect, it, vi } from 'vitest';
import { PI_NATIVE_EXTENSION_SOURCE, PI_NATIVE_HOST_UI_SOURCE } from './native-extension-source.js';

type Message = { role: string; timestamp: number; content: Array<{ type: string; text: string }> };
type Row = { id: string; type: 'message'; message: Message } | { id: string; type: 'custom'; customType: string; data: { enabled: boolean } }
  | { id: string; type: 'custom_message'; customType: string; content: string; details: { submissionId: string } };
type Packet = { request?: { kind: string; input: { row?: Row; phase?: string; commandId?: number } };
  events?: Array<{ sequence: number; kind: string; value: unknown }> };
const stops: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  Reflect.deleteProperty(globalThis, Symbol.for('lex.pi.native.history-replacement'));
});
async function fixture(accepted = true) {
  let brokenAdmission = false;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const rows: Row[] = [], requests: Packet[] = [], faults: Packet[] = [], batches: Packet[] = [];
  const commands: Array<{ id: number; kind: string; payload: unknown }> = [];
  const ctx = { mode: 'tui', signal: undefined as AbortSignal | undefined, abort: vi.fn(), shutdown: vi.fn(), isIdle: () => true, hasPendingMessages: () => false,
    model: { id: 'model', provider: 'provider' }, modelRegistry: { getAvailable: () => [] }, ui: { notify: vi.fn(), setEditorText: vi.fn() },
    sessionManager: { getSessionFile: () => '/managed/original-pi.jsonl', getSessionId: () => 'native-pi', getEntries: () => [...rows], getBranch: () => [...rows],
      getTree: () => rows.map(entry => ({ entry, children: [] })), getLeafId: () => rows.at(-1)?.id ?? null },
  };
  const api = { on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    sendUserMessage: vi.fn(), sendMessage: vi.fn(), getCommands: () => [{ name: 'plan', source: 'extension' }], getSettings: () => ({ compaction: { enabled: true } }),
    setThinkingLevel: vi.fn(), getThinkingLevel: () => 'high', setSessionName: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
  };
  const fetch = vi.fn(async (url: string, options: { body: string }) => {
    const body: Packet = JSON.parse(options.body);
    if (brokenAdmission && body.request?.kind === 'native-input') throw new Error('admission connection lost');
    if (url.endsWith('/exchange')) { batches.push(body); return { ok: true, json: async () => ({ acknowledged: body.events?.at(-1)?.sequence ?? 0, commands: commands.splice(0) }) }; }
    (body.request?.kind === 'native-fault' ? faults : requests).push(body);
    return { ok: true, json: async () => ({ result: { accepted, text: 'host prepared' } }) };
  });
  const activate = new Function('process', 'fetch', 'Text', PI_NATIVE_EXTENSION_SOURCE.replace("import { Text } from '@earendil-works/pi-tui';", '').replace('export default function', 'return function'))({ env: {
    LEX_PI_BRIDGE_URL: 'http://127.0.0.1:1', LEX_PI_BRIDGE_TOKEN: 'fixture-only', LEX_PI_BRIDGE_GENERATION: 'generation', LEX_PI_BRIDGE_SESSION: 'product-task',
  } }, fetch, class { constructor(public text: string) {} });
  activate(api);
  const emit = async (name: string, event: unknown = {}) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; };
  stops.push(() => emit('session_shutdown')); await emit('session_start');
  const row = (id: string, text = 'native input', timestamp = 1000): Extract<Row, { type: 'message' }> => ({ id, type: 'message', message: { role: 'user', timestamp, content: [{ type: 'text', text }] } });
  return { api, ctx, rows, requests, faults, batches, commands, emit, row, admit() { accepted = true; }, breakAdmission() { brokenAdmission = true; } };
}
describe('Pi official interactive extension', () => {
  it('renders GUI and Orca body without exposing transport labels or submission details', async () => {
    const f = await fixture();
    for (const [kind, render] of f.api.registerMessageRenderer.mock.calls) {
      const result = render({ content: 'body', details: { submissionId: 'private-receipt' } }, {}, { fg: (_role: string, text: string) => text });
      expect(result.text).toBe((kind === 'lex-orca-body' ? 'Orca' : 'GUI') + '\nbody');
      expect(render({ content: [{ type: 'text', text: 'photo' }, { type: 'image', data: 'synthetic', mimeType: 'image/png' }] },
        {}, { fg: (_role: string, text: string) => text })).toBeUndefined();
    }
    expect(f.api.registerMessageRenderer).toHaveBeenCalledTimes(2);
  });
  it('reads only the fresh withSession context after fork invalidates the command context', async () => {
    const f = await fixture();
    let invalidated = false, draft = 'unsent';
    const next = { ...f.ctx, cwd: '/work', ui: { ...f.ctx.ui,
      getEditorText: () => draft, setEditorText: (value: string) => { draft = value; } },
      sessionManager: { ...f.ctx.sessionManager, getSessionFile: () => '/managed/fork.jsonl' } };
    const fork = vi.fn(async (_entry: string, options: { withSession(ctx: typeof next): Promise<void> }) => {
      await f.emit('session_shutdown', { reason: 'fork', targetSessionFile: '/managed/fork.jsonl' });
      invalidated = true;
      await options.withSession(next);
      return { cancelled: false };
    });
    const old = new Proxy({ ...f.ctx, cwd: '/work', ui: next.ui, fork }, {
      get(target, key) { if (invalidated) throw new Error('stale command context'); return Reflect.get(target, key); },
    });
    const registered = f.api.registerCommand.mock.calls.find(call => call[0] === 'lex-native-tree-handoff')![1];
    f.api.sendUserMessage.mockImplementation((text: string) => registered.handler(text.split(' ')[1], old));
    f.commands.push({ id: 51, kind: 'control', payload: { type: 'fork_history', entryId: 'leaf' } });
    await vi.waitFor(() => expect(f.batches.flatMap(batch => batch.events ?? [])).toContainEqual(expect.objectContaining({
      kind: 'command-result', value: { id: 51, ok: true, result: { ok: true, data: expect.objectContaining({ sessionFile: '/managed/fork.jsonl', draft: 'unsent' }) } },
    })));
    expect(fork).toHaveBeenCalledOnce();
    expect(f.faults).toEqual([]);
  });
  it('does not label an already journalled GUI row as refused before submission when Host admission is denied', async () => {
    const f = await fixture(false);
    f.commands.push({ id: 40, kind: 'prompt', payload: { text: 'GUI body', submissionId: 'owned-body' } });
    await vi.waitFor(() => expect(f.api.sendMessage).toHaveBeenCalledOnce());
    const row = { id: 'persisted-body', type: 'custom_message' as const, customType: 'lex-gui-append', content: 'GUI body', details: { submissionId: 'owned-body' } };
    f.rows.push(row);
    await f.emit('context', { messages: [{ role: 'custom', customType: row.customType, content: row.content, details: row.details }] });
    await vi.waitFor(() => expect(f.batches.flatMap(batch => batch.events ?? [])).toContainEqual(expect.objectContaining({
      kind: 'command-result', value: { id: 40, ok: true, result: { cancelledOutcomeUnknown: true } },
    })));
    expect(f.api.sendMessage).toHaveBeenCalledOnce();
    expect(f.ctx.abort).toHaveBeenCalled();
  });
  it('reads the original native tree identity without sending input or changing the editor', async () => {
    const f = await fixture();
    f.rows.push(f.row('first', 'same text'), f.row('second', 'same text'));
    f.commands.push({ id: 31, kind: 'control', payload: { type: 'get_tree' } });
    await vi.waitFor(() => expect(f.batches.flatMap(batch => batch.events ?? [])).toContainEqual(expect.objectContaining({
      kind: 'command-result', value: { id: 31, ok: true, result: { ok: true, data: {
        tree: f.ctx.sessionManager.getTree(), leafId: 'second', sessionId: 'native-pi', sessionFile: '/managed/original-pi.jsonl',
      } } },
    })));
    expect(f.api.sendUserMessage).not.toHaveBeenCalled();
    expect(f.ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it('uses native steer delivery and waits for a real consumed row before acknowledging GUI input', async () => {
    const f = await fixture(), root = f.row('root-row'); f.rows.push(root);
    await f.emit('context', { messages: [root.message] });
    f.ctx.isIdle = () => false;
    f.commands.push({ id: 23, kind: 'steer', payload: { text: 'in turn', turnRowId: 'root-row', submissionId: 'owned-token' } });
    await vi.waitFor(() => expect(f.api.sendMessage).toHaveBeenCalledWith({ customType: 'lex-gui-append', content: 'in turn', display: true,
      details: { submissionId: 'owned-token' } }, { deliverAs: 'steer' }));
    expect(f.batches.flatMap(batch => batch.events ?? []).some(event => event.kind === 'command-result')).toBe(false);
    const row = { id: 'consumed-row', type: 'custom_message' as const, customType: 'lex-gui-append', content: 'in turn', details: { submissionId: 'owned-token' } }; f.rows.push(row);
    await f.emit('context', { messages: [root.message, { role: 'custom', customType: row.customType, content: row.content, details: row.details }] });
    expect(f.requests.at(-1)!.request).toMatchObject({ kind: 'native-input', input: { row, commandId: 23, turnRowId: 'root-row' } });
    expect(f.ctx.abort).not.toHaveBeenCalled(); expect(f.faults).toEqual([]);
  });
  it('uses the actual already-persisted Pi row and installs only owner-prepared context', async () => {
    const f = await fixture(), row = f.row('real-pi-row'); f.rows.push(row);
    const original = structuredClone(row.message);
    expect(await f.emit('context', { messages: [row.message] })).toEqual({ messages: [{ ...row.message, content: [{ type: 'text', text: 'host prepared' }] }] });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.request).toMatchObject({ kind: 'native-input', input: { sessionFile: '/managed/original-pi.jsonl', row } });
    expect(f.requests[0]!.request!.input).not.toHaveProperty('submissionId');
    expect(row.message).toEqual(original); expect(f.api.sendUserMessage).not.toHaveBeenCalled(); expect(f.ctx.abort).not.toHaveBeenCalled();
    await f.emit('context', { messages: [row.message] }); expect(f.requests).toHaveLength(1);
  });
  it('fails before execution when there is no real row, without guessing an identity or replaying', async () => {
    const f = await fixture(), row = f.row('absent');
    await f.emit('before_agent_start', { messageType: 'user', prompt: 'native input' });
    await f.emit('context', { messages: [row.message] });
    expect(f.requests).toHaveLength(0); expect(f.ctx.abort).toHaveBeenCalled();
    expect(f.faults[0]!.request!.input.phase).toBe('journal-unavailable');
    await f.emit('context', { messages: [row.message] }); expect(f.requests).toHaveLength(0);
  });
  it('requires the owner for each later explicit input and only resets active ownership at agent_settled', async () => {
    const f = await fixture(), first = f.row('first'), second = f.row('second', 'explicit after stop', 2000);
    f.rows.push(first); await f.emit('context', { messages: [first.message] });
    await f.emit('agent_end', { type: 'agent_end' });
    await f.emit('agent_settled', { type: 'agent_settled', outcome: 'aborted' });
    expect(f.api.sendUserMessage).not.toHaveBeenCalled();
    f.rows.push(second); await f.emit('context', { messages: [first.message, second.message] });
    expect(f.requests.map(item => item.request!.input.row!.id)).toEqual(['first', 'second']); expect(f.ctx.abort).not.toHaveBeenCalled();
  });
  it('admits distinct real rows with equal text and timestamps without content deduplication', async () => {
    const f = await fixture(), first = f.row('first'), second = f.row('second');
    f.rows.push(first); await f.emit('before_agent_start'); await f.emit('context', { messages: [first.message] });
    await f.emit('agent_settled', { type: 'agent_settled' });
    f.rows.push(second); await f.emit('before_agent_start'); await f.emit('context', { messages: [first.message, second.message] });
    expect(f.requests.map(item => item.request!.input.row!.id)).toEqual(['first', 'second']);
    expect(f.faults).toEqual([]);
  });
  it('keeps the original frontend alive after a refused input without automatically resending it', async () => {
    const f = await fixture(false), row = f.row('refused'); f.rows.push(row);
    await f.emit('context', { messages: [row.message] });
    expect(f.ctx.abort).toHaveBeenCalled(); expect(f.ctx.shutdown).not.toHaveBeenCalled(); expect(f.faults).toEqual([]);
    await f.emit('agent_settled', { type: 'agent_settled', outcome: 'aborted' });
    await f.emit('context', { messages: [row.message] });
    expect(f.requests).toHaveLength(1); expect(f.api.sendUserMessage).not.toHaveBeenCalled();
    f.admit(); const next = f.row('explicit-after-refusal', 'new explicit input', 2000); f.rows.push(next);
    await f.emit('context', { messages: [row.message, next.message] });
    expect(f.requests).toHaveLength(2); expect(f.faults).toEqual([]);
  });
  it('runs the original plan command once and returns only its actual persisted setting', async () => {
    const f = await fixture();
    f.api.sendUserMessage.mockImplementation(() => { f.rows.push({ id: 'actual-plan-row', type: 'custom', customType: 'plan-mode', data: { enabled: true } }); });
    f.commands.push({ id: 11, kind: 'control', payload: { type: 'native_plan', enabled: true } });
    await vi.waitFor(() => expect(f.batches.flatMap(batch => batch.events ?? [])).toContainEqual(expect.objectContaining({ kind: 'command-result', value: { id: 11, ok: true, result: { ok: true, data: { enabled: true } } } })));
    expect(f.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith('/plan', { expandPromptTemplates: true });
    expect(f.requests).toEqual([]);
  });
  it('does not mistake aborting after a transport failure for a user cancellation or replay the input', async () => {
    const f = await fixture(), row = f.row('unconfirmed'), run = new AbortController();
    f.ctx.signal = run.signal; f.ctx.abort.mockImplementation(() => run.abort());
    f.rows.push(row); f.breakAdmission();
    await f.emit('before_agent_start'); await f.emit('context', { messages: [row.message] });
    expect(f.faults[0]!.request!.input.phase).toBe('input-admission');
    await f.emit('context', { messages: [row.message] }); expect(f.api.sendUserMessage).not.toHaveBeenCalled();
  });
  it('starts exactly one causal custom GUI turn and keeps interactive draft input', async () => {
    const f = await fixture();
    f.commands.push({ id: 7, kind: 'prompt', payload: { text: 'explicit GUI', submissionId: 'gui-submission' } });
    await vi.waitFor(() => expect(f.api.sendMessage).toHaveBeenCalledExactlyOnceWith({ customType: 'lex-gui-append',
      content: 'explicit GUI', display: true, details: { submissionId: 'gui-submission' } }, { triggerTurn: true }));
    expect(f.api.sendUserMessage).not.toHaveBeenCalled();
    expect(await f.emit('input', { text: 'native draft', source: 'interactive' })).toEqual({ action: 'handled' });
    expect(f.ctx.ui.setEditorText).toHaveBeenCalledWith('native draft');
    const independent = f.row('independent-row', 'explicit GUI'); f.rows.push(independent);
    const row = { id: 'gui-row', type: 'custom_message' as const, customType: 'lex-gui-append', content: 'explicit GUI', details: { submissionId: 'gui-submission' } };
    f.rows.push(row);
    await f.emit('context', { messages: [independent.message, { role: 'custom', ...row }] });
    expect(f.requests[0]!.request!.input.commandId).toBeUndefined();
    expect(f.requests[1]!.request!.input.commandId).toBe(7);
    await vi.waitFor(() => expect(f.batches.flatMap(batch => batch.events ?? []).some(event => event.kind === 'command-result')).toBe(true));
  });
  it('keeps original native/package dialogs and RPC while forwarding only Cindy private TUI requests', async () => {
    const native = vi.fn(async () => 'native-answer'), host = vi.fn(async () => ({ value: 'host-answer', confirmed: false }));
    const key = Symbol.for('lex.pi.native.host-ui');
    const factory = new Function('globalThis', PI_NATIVE_HOST_UI_SOURCE + '\nreturn cindyHostUi;')({ [key]: host });
    const ctx = { mode: 'tui', ui: { input: native, confirm: native } };
    expect(await factory(ctx).input('Package question', 'original')).toBe('native-answer');
    expect(await factory(ctx).input('cindy:permission', '{}')).toBe('host-answer');
    expect(await factory({ ...ctx, mode: 'rpc' }).input('cindy:permission', '{}')).toBe('native-answer');
    expect(native).toHaveBeenCalledTimes(2); expect(host).toHaveBeenCalledOnce();
  });
});
