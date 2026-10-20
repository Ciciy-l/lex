import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiNativeSessionControl } from './native-session.js';
import type { AgentSessionHandle, SendOptions } from '../base-agent.js';
import { TurnDispatchRejectedError } from '../base-agent.js';
import type { NativeSessionBridgeOptions } from '../shared/native-session-bridge.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';
import { Session } from '../../session.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { createPiTranslateContext, translatePiEvent, usageSnapshotOf } from './translator.js';
import type { Capabilities, CapabilityStatus } from '../../types/capabilities.js';

const mock = vi.hoisted(() => ({ options: undefined as NativeSessionBridgeOptions | undefined, command: vi.fn(), enqueue: vi.fn() }));
vi.mock('../shared/native-session-bridge.js', () => ({ NativeSessionBridge: class {
  constructor(options: NativeSessionBridgeOptions) { mock.options = options; }
  async start() {}
  environment() { return {}; }
  command = mock.command;
  enqueueCommand = mock.enqueue;
  async close() {}
} }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
const file = path.join(os.tmpdir(), 'original-pi-native-fixture.jsonl');
const unavailable: CapabilityStatus = { supported: false, reason: 'not-implemented' };
const capabilities: Capabilities = { switchModel: unavailable, availableModels: [], hasFastMode: false,
  effort: unavailable, effortLevels: [], reasoningDisplay: [], permissionModes: [], setPermissionModeMidSession: unavailable,
  multimodal: { text: { supported: true }, image: unavailable, file: unavailable },
  fork: unavailable, rewind: unavailable, abort: { supported: true }, sameTurnSteer: unavailable, memory: { supported: unavailable }, extraDirs: unavailable };
async function fixture(resume = file) {
  const queue = createAsyncQueue<AgentEvent>(), ctx = createPiTranslateContext(logger);
  const driver = { pid: 54321, write: vi.fn(), resize: vi.fn(), onData: () => vi.fn(), onExit: () => vi.fn(), close: vi.fn(async () => {}) };
  mock.command.mockResolvedValue({ ok: true });
  const control = new PiNativeSessionControl({ sessionId: 'task', model: 'fixture-model', provider: 'actual-provider',
    hostProviderId: 'actual-source', executable: 'original-pi', args: [], env: {}, cwd: os.tmpdir(), extensionPath: '', logger,
    resumeSessionId: resume,
    onEvent(event) { translatePiEvent(event, queue, ctx); }, onExit() { queue.end(); },
    async launch() {
      queueMicrotask(() => mock.options!.onEvent({ sequence: 1, kind: 'ready',
        value: { sessionFile: file, model: 'fixture-model', provider: 'actual-provider' } }));
      return driver;
    },
  });
  cleanups.push(async () => { await control.close(); queue.end(); });
  await control.start();
  const base: AgentSessionHandle = { id: file, model: 'fixture-model', agentKind: 'pi',
    async send(message) {
      const response = await control.request({ type: 'prompt', message: typeof message.content === 'string' ? message.content : '' });
      if (!response.success) throw new TurnDispatchRejectedError('not accepted');
    }, async steer() {}, async abort() { await control.request({ type: 'abort' }); },
    setInteractionResolver() {}, getUsageSnapshot: () => usageSnapshotOf(ctx),
    isTurnRunning: () => ctx.isStreaming, events: () => queue, close: () => control.close(),
  };
  const prepare = vi.fn(async (message: import('../../types/common.js').UserMessage, _options: SendOptions) =>
    ({ text: typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('') }));
  const handle = control.bindHandle(base, prepare);
  const event = (type: string, extra: Record<string, unknown> = {}) => mock.options!.onEvent({ sequence: 2, kind: 'agent-event',
    value: { sessionFile: file, event: { type, ...extra } } });
  const input = (id: string, text = 'native input', commandId?: number, signal = new AbortController().signal) => mock.options!.onRequest({
    requestId: id, kind: 'native-input', input: { sessionFile: file, row: { type: 'message', id, message: { role: 'user', timestamp: 1000, content: [{ type: 'text', text }] } },
      ...(commandId === undefined ? {} : { commandId, submittedText: text }) },
  }, signal);
  return { control, handle, event, input, prepare, driver, queue };
}
describe('Pi original interactive task control', () => {
  it('binds the original history and rejects another native identity before exposing a terminal', async () => {
    const f = await fixture();
    expect(f.handle.presentation!.state().nativeSessionId).toBe(file);
    await expect(f.control.start()).rejects.toThrow('already started');
    await expect(fixture(path.join(os.tmpdir(), 'other-pi.jsonl'))).rejects.toThrow('interrupted');
  });
  it('reserves the original user row through real Core Session and settles only at agent_settled', async () => {
    const f = await fixture();
    const session = new Session({ id: 'task', agentKind: 'pi', workDir: os.tmpdir(), handle: f.handle,
      capabilities, logger, permissionMode: 'ask', turnStallMs: 0 });
    cleanups.push(() => session.close());
    const accepted: unknown[] = [];
    session.onNativeInput(async input => {
      expect(input.nativeMessageId).toBe('real-row'); expect(input.submissionId).toBeUndefined();
      expect(input.source?.origin).toEqual({ kind: 'native' });
      accepted.push(await session.acceptNativeInput(input));
    });
    f.event('agent_start');
    expect(session.isTurnRunning()).toBe(false);
    expect(await f.input('real-row')).toEqual({ accepted: true, text: 'native input' });
    expect(accepted).toEqual([{ accepted: true }]); expect(session.isTurnRunning()).toBe(true);
    f.event('agent_end', { messages: [] });
    expect(session.isTurnRunning()).toBe(true);
    f.event('agent_settled', { outcome: 'completed' });
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
    expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('refuses missing, changed and canceled product ownership without a new prompt', async () => {
    const f = await fixture();
    expect(await f.input('unowned')).toEqual({ accepted: false });
    f.handle.setNativeInputResolver!(async input => { f.handle.setNativeInputResolver!(async () => {}); await input.accept(input.message, {}); });
    expect(await f.input('changed')).toEqual({ accepted: false });
    const controller = new AbortController(); controller.abort();
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    expect(await f.input('canceled', 'canceled', undefined, controller.signal)).toEqual({ accepted: false });
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it.each(['stop', 'owner', 'lease', 'settled'] as const)(
    'rechecks %s changes after the resolver has prepared the original row', async change => {
      const f = await fixture(), ownershipSignal = new AbortController();
      let current = true;
      f.handle.setNativeInputResolver!(async input => {
        await input.accept(input.message, {}, { signal: ownershipSignal.signal, isCurrent: () => current });
        if (change === 'stop') await f.control.request({ type: 'abort' });
        else if (change === 'owner') f.handle.setNativeInputResolver!(async () => {});
        else if (change === 'lease') { current = false; ownershipSignal.abort(); }
        else f.event('agent_settled', { outcome: 'cancelled' });
      });
      expect(await f.input('prepared-row')).toEqual({ accepted: false });
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(mock.enqueue).not.toHaveBeenCalled(); expect(f.driver.write).not.toHaveBeenCalled();
    },
  );
  it('binds GUI semantic delivery to its actual native row once, keeping plugin provenance', async () => {
    const f = await fixture(), receipt = vi.fn(async () => {});
    mock.enqueue.mockImplementation(() => ({ id: 7, result: Promise.resolve().then(async () => {
      expect(await f.input('gui-row', 'GUI input', 7)).toEqual({ accepted: true });
      return { accepted: true };
    }) }));
    await f.handle.send({ type: 'user', content: 'GUI input' }, { messageUuid: 'product-message', onNativeUserMessage: receipt });
    expect(receipt).toHaveBeenCalledExactlyOnceWith({ version: 1, engine: 'pi', sessionId: file, messageId: 'gui-row',
      origin: { kind: 'plugin', name: 'lex-pi-native-bridge' }, bridge: { sessionId: file, messageId: 'gui-row', submissionId: 'product-message', pluginName: 'lex-pi-native-bridge' } });
    expect(mock.enqueue).toHaveBeenCalledOnce(); expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('never retries an unconfirmed GUI command and preserves the caller input', async () => {
    const f = await fixture(), message = { type: 'user' as const, content: 'explicit only once' };
    mock.enqueue.mockReturnValue({ id: 9, result: Promise.reject(new Error('receipt lost')) });
    await expect(f.handle.send(message)).rejects.toThrow('receipt lost');
    expect(mock.enqueue).toHaveBeenCalledOnce(); expect(message.content).toBe('explicit only once');
  });
  it('does not give a GUI receipt to a different semantic command', async () => {
    const f = await fixture(), receipt = vi.fn();
    mock.enqueue.mockImplementation(() => ({ id: 7, result: Promise.resolve().then(async () => {
      expect(await f.input('other-row', 'another semantic command', 7)).toEqual({ accepted: false });
      return { refusedBeforeSubmission: true };
    }) }));
    await expect(f.handle.send({ type: 'user', content: 'intended command' }, { messageUuid: 'product-message', onNativeUserMessage: receipt })).rejects.toThrow('not accepted');
    expect(receipt).not.toHaveBeenCalled(); expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('fences preparation that finishes after Stop and native settlement, then accepts only a new explicit input', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.prepare.mockImplementationOnce(async () => { await gate; return { text: 'cancelled prepared input' }; });
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    f.event('agent_start'); const pending = f.input('cancelled-row');
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    await f.control.request({ type: 'abort' }); f.event('agent_settled', { type: 'agent_settled' });
    release(); expect(await pending).toEqual({ accepted: false });
    expect(f.handle.isTurnRunning!()).toBe(false); expect(mock.enqueue).not.toHaveBeenCalled();
    f.event('agent_start'); expect(await f.input('explicit-new-row')).toEqual({ accepted: true, text: 'native input' });
    f.event('agent_settled', { type: 'agent_settled' }); expect(f.handle.isTurnRunning!()).toBe(false);
  });
  it('routes permission callbacks to the same owner and refuses cross-session callbacks', async () => {
    const f = await fixture();
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    await f.input('tool-row');
    const pending = mock.options!.onRequest({ requestId: '17', kind: 'host-ui', input: { sessionFile: file,
      event: { method: 'input', title: 'cindy:permission', placeholder: '{}' } } }, new AbortController().signal);
    f.control.send({ type: 'extension_ui_response', id: 'pi-native:17', value: 'user-deny' });
    await expect(pending).resolves.toEqual({ type: 'extension_ui_response', id: 'pi-native:17', value: 'user-deny' });
    await expect(mock.options!.onRequest({ requestId: '18', kind: 'host-ui', input: { sessionFile: path.join(os.tmpdir(), 'other.jsonl') } }, new AbortController().signal)).rejects.toThrow('another task');
    await f.control.request({ type: 'abort' });
    await expect(mock.options!.onRequest({ requestId: '19', kind: 'host-ui', input: { sessionFile: file } }, new AbortController().signal)).rejects.toThrow('current input');
  });
  it('can retry confirmed termination after an unconfirmed PTY close without launching another executor', async () => {
    const f = await fixture();
    f.driver.close.mockRejectedValueOnce(new Error('exit unconfirmed'));
    await expect(f.control.close()).rejects.toThrow('exit unconfirmed');
    await f.control.close(); expect(f.driver.close).toHaveBeenCalledTimes(2);
  });
});
