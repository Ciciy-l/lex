import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOmpNativeSession } from './native-session.js';
import type { AgentSessionHandle } from '../base-agent.js';
import type { NativeSessionBridgeOptions } from '../shared/native-session-bridge.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';
import { Session } from '../../session.js';

const mock = vi.hoisted(() => ({ options: undefined as NativeSessionBridgeOptions | undefined, command: vi.fn(), enqueue: vi.fn() }));
vi.mock('../shared/native-session-bridge.js', () => ({ NativeSessionBridge: class {
  constructor(options: NativeSessionBridgeOptions) { mock.options = options; }
  async start() {}
  environment() { return {}; }
  command = mock.command;
  enqueueCommand = mock.enqueue;
  async close() {}
} }));
const handles: AgentSessionHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())); vi.clearAllMocks(); });
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
const file = path.join(os.tmpdir(), 'omp-native-fixture.jsonl');
async function fixture(resume = file, consumeEvents = true) {
  const driver = { write: vi.fn(), resize: vi.fn(), onData: () => vi.fn(), onExit: () => vi.fn(), close: vi.fn() };
  mock.command.mockResolvedValue({});
  const execute = vi.fn(async (_arguments: unknown, _context: unknown) => ({ content: [{ type: 'text' as const, text: 'native result' }] }));
  const handle = await createOmpNativeSession({ sessionId: 'task', model: 'fixture-model', providerId: 'source', permissionMode: 'ask',
    executable: 'owned', plan: {} as never, releaseResources: vi.fn(), logger,
    ...(resume ? { resumeSessionId: resume } : {}),
    hostTools: [{ name: 'fixture_tool', description: 'fixture host executor', parameters: { type: 'object' }, execute }],
    async launch() {
      queueMicrotask(() => mock.options!.onEvent({ sequence: 1, kind: 'ready', value: { sessionFile: file, model: 'fixture-model', contextWindow: 100_000 } }));
      return driver;
    },
  });
  handles.push(handle);
  const output: AgentEvent[] = [];
  if (consumeEvents) void (async () => { for await (const event of handle.events()) output.push(event); })();
  const event = (type: string, extra: Record<string, unknown> = {}) => mock.options!.onEvent({ sequence: 2, kind: 'agent-event',
    value: { sessionFile: file, event: { type, ...extra } } });
  const input = (id: string, text = 'native input', commandId?: number) => mock.options!.onRequest({ requestId: id, kind: 'admit-input', input: { sessionFile: file,
    row: { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }, ...(commandId === undefined ? {} : { commandId }) } }, new AbortController().signal);
  return { handle, output, event, input, execute, driver };
}
describe('OMP original interactive task adapter', () => {
  it('uses the actual session file and refuses a changed resume identity', async () => {
    const f = await fixture();
    expect(f.handle.id).toBe(file); expect(f.handle.presentation!.state().nativeSessionId).toBe(file);
    expect(mock.options!.environmentPrefix).toBe('LEX_OMP_BRIDGE');
    await expect(fixture(path.join(os.tmpdir(), 'different.jsonl'))).rejects.toThrow('interrupted');
  });
  it('holds pre-admission agent status, admits one real row through the current owner and refuses replay', async () => {
    const f = await fixture();
    f.event('agent_start');
    expect(f.output.some(event => event.type === 'status')).toBe(false);
    const resolve = vi.fn<import('../native-input.js').AgentNativeInputResolver>(async input => { await input.accept({ type: 'user', content: 'host prepared' }, {}); });
    f.handle.setNativeInputResolver!(resolve);
    expect(await f.input('journal-user')).toEqual({ accepted: true, text: 'host prepared' });
    expect(resolve).toHaveBeenCalledOnce(); expect(resolve.mock.calls[0]![0].nativeMessageId).toBe('journal-user');
    f.event('agent_end', { isTerminal: true });
    await vi.waitFor(() => expect(f.output.some(event => event.type === 'done')).toBe(true));
    await expect(f.input('journal-user')).rejects.toThrow('new native journal row');
    expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('refuses missing/changed product ownership before provider execution', async () => {
    const f = await fixture();
    expect(await f.input('no-owner')).toEqual({ accepted: false });
    f.handle.setNativeInputResolver!(async input => { f.handle.setNativeInputResolver!(async () => {}); await input.accept(input.message, {}); });
    expect(await f.input('changed-owner')).toEqual({ accepted: false });
    expect(f.handle.isTurnRunning!()).toBe(false);
  });
  it('admits the original TUI row through a real Core Session reservation, then accepts a later explicit input', async () => {
    const f = await fixture(file, false);
    const session = new Session({ id: 'task', agentKind: 'omp', workDir: os.tmpdir(), handle: f.handle,
      capabilities: {} as never, logger, permissionMode: 'ask', turnStallMs: 0 });
    const accepted: unknown[] = [];
    session.onNativeInput(async input => { accepted.push(await session.acceptNativeInput(input)); });
    try {
      f.event('agent_start');
      expect(await f.input('original-row')).toEqual({ accepted: true, text: 'native input' });
      expect(accepted).toEqual([{ accepted: true }]);
      expect(session.isTurnRunning()).toBe(true);
      f.event('agent_end', { willContinue: false });
      await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
      f.event('agent_start');
      expect(await f.input('later-explicit-row', 'new explicit input')).toEqual({ accepted: true, text: 'new explicit input' });
      expect(accepted).toEqual([{ accepted: true }, { accepted: true }]);
      expect(f.driver.write).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
  it('sends GUI input semantically once and binds its receipt to the native row', async () => {
    const f = await fixture(); let settle!: () => void;
    mock.enqueue.mockReturnValue({ id: 7, result: new Promise<void>(resolve => { settle = resolve; }) });
    const receipt = vi.fn();
    const sent = f.handle.send({ type: 'user', content: 'GUI input' }, { messageUuid: 'gui-product-id', onNativeUserMessage: receipt });
    expect(mock.enqueue).toHaveBeenCalledOnce();
    expect(await f.input('native-row', 'GUI input', 7)).toEqual({ accepted: true, text: 'GUI input' });
    settle(); await sent;
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce());
    expect(receipt.mock.calls[0]![0]).toMatchObject({ engine: 'omp', messageId: 'native-row', sessionId: file, bridge: { submissionId: 'gui-product-id' } });
    expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('preserves unknown dispatch instead of resending, and abort does not close the CLI', async () => {
    const f = await fixture();
    mock.enqueue.mockReturnValue({ id: 8, result: Promise.reject(new Error('receipt lost')) });
    await expect(f.handle.send({ type: 'user', content: 'unknown input' })).rejects.toMatchObject({ name: 'TurnDispatchUnconfirmedError' });
    expect(mock.enqueue).toHaveBeenCalledOnce();
    await expect(f.handle.send({ type: 'user', content: 'do not replay' })).rejects.toThrow('not active');
    const live = await fixture();
    await live.handle.abort(); expect(mock.command).toHaveBeenLastCalledWith('abort', {}, 10_000);
    expect(live.driver.close).not.toHaveBeenCalled();
  });
  it('distinguishes a real pre-submit busy refusal from an unknown execution outcome', async () => {
    const f = await fixture();
    mock.enqueue.mockReturnValue({ id: 8, result: Promise.resolve({ refusedBeforeSubmission: true }) });
    await expect(f.handle.send({ type: 'user', content: 'retained draft' })).rejects.toMatchObject({ name: 'TurnDispatchRejectedError' });
    expect(f.driver.close).not.toHaveBeenCalled();
    expect(f.handle.isTurnRunning!()).toBe(false);
    expect(mock.enqueue).toHaveBeenCalledOnce();
  });
  it('explicitly refuses an unsupported GUI steer without submitting another native prompt', async () => {
    const f = await fixture();
    await expect(f.handle.steer({ type: 'user', content: 'do not reinterpret as prompt' })).rejects.toMatchObject({ name: 'TurnDispatchRejectedError' });
    expect(mock.enqueue).not.toHaveBeenCalled();
    expect(f.driver.write).not.toHaveBeenCalled();
    expect(f.driver.close).not.toHaveBeenCalled();
  });
  it('uses the managed route rebuild for model/source changes and keeps effort on this native process', async () => {
    const f = await fixture();
    expect(f.handle.requiresModelSwitchRebuild!('different-model', { providerId: 'source' })).toBe(true);
    expect(f.handle.requiresModelSwitchRebuild!('fixture-model', { providerId: 'other-source' })).toBe(true);
    expect(f.handle.requiresModelSwitchRebuild!('fixture-model', { providerId: 'source' })).toBe(false);
    await expect(f.handle.setModel!('different-model')).rejects.toThrow('route rebuild');
    await f.handle.setModel!('fixture-model', { providerId: 'source', effort: 'high' });
    expect(mock.command).toHaveBeenLastCalledWith('effort', { level: 'high' }, 10_000);
    expect(f.handle.getEffort!()).toBe('high');
  });
  it('keeps the same admitted input active across OMP internal continuation but settles its final end once', async () => {
    const f = await fixture();
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    await f.input('journal-continuation-owner');
    f.event('agent_end', { willContinue: true });
    await Promise.resolve();
    expect(f.handle.isTurnRunning!()).toBe(true);
    expect(f.output.filter(event => event.type === 'done')).toHaveLength(0);
    f.event('agent_end', { willContinue: false });
    await vi.waitFor(() => expect(f.output.filter(event => event.type === 'done')).toHaveLength(1));
    expect(f.handle.isTurnRunning!()).toBe(false);
  });
  it('executes the original frozen host tool with real toolCallId, fenced by the current task', async () => {
    const f = await fixture();
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    await f.input('journal-tool-owner');
    f.handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const request = { requestId: '19', kind: 'host-tool', input: { sessionFile: file, toolCallId: 'native-call-33', toolName: 'fixture_tool', arguments: { value: 1 } } };
    expect(await mock.options!.onRequest(request, new AbortController().signal)).toMatchObject({ content: [{ text: 'native result' }] });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]![0]).toEqual({ value: 1 });
    await expect(mock.options!.onRequest({ ...request, requestId: '20', input: { ...request.input, sessionFile: 'another-owner' } }, new AbortController().signal)).rejects.toThrow('current task');
    expect(f.execute).toHaveBeenCalledOnce();
  });
});
