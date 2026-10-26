import { GUI_NATIVE_APPEND, GUI_NATIVE_BODY, ORCA_NATIVE_BODY, type OrcaNativeBodySource } from '../base-agent.js';
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
async function fixture(resume = file, isDelegatedInputCurrent?: (source: OrcaNativeBodySource) => boolean) {
  const queue = createAsyncQueue<AgentEvent>(), ctx = createPiTranslateContext(logger);
  const driver = { pid: 54321, write: vi.fn(), resize: vi.fn(), onData: () => vi.fn(), onExit: () => vi.fn(), close: vi.fn(async () => {}) };
  mock.command.mockResolvedValue({ ok: true });
  const control = new PiNativeSessionControl({ sessionId: 'task', model: 'fixture-model', provider: 'actual-provider',
    hostProviderId: 'actual-source', executable: 'original-pi', args: [], env: {}, cwd: os.tmpdir(), extensionPath: '', logger,
    resumeSessionId: resume, isDelegatedInputCurrent,
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
    }, async steer(message) {
      const response = await control.request({ type: 'steer', message: message.content });
      if (!response.success) throw new TurnDispatchRejectedError('steer not consumed');
    }, async abort() { await control.request({ type: 'abort' }); },
    setInteractionResolver() {}, getUsageSnapshot: () => usageSnapshotOf(ctx),
    isTurnRunning: () => ctx.isStreaming, events: () => queue, close: () => control.close(),
  };
  const prepare = vi.fn(async (message: import('../../types/common.js').UserMessage, _options: SendOptions) =>
    ({ text: typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('') }));
  const handle = control.bindHandle(base, prepare);
  const event = (type: string, extra: Record<string, unknown> = {}) => mock.options!.onEvent({ sequence: 2, kind: 'agent-event',
    value: { sessionFile: file, event: { type, ...extra } } });
  const input = (id: string, text = 'native input', commandId?: number, signal = new AbortController().signal) => mock.options!.onRequest({
    requestId: id, kind: 'native-input', input: { sessionFile: file, turnRowId: handle.getCurrentTurnId?.() ?? undefined, row: { type: 'message', id, message: { role: 'user', timestamp: 1000, content: [{ type: 'text', text }] } },
      ...(commandId === undefined ? {} : { commandId, submittedText: text }) },
  }, signal);
  return { control, handle, event, input, prepare, driver, queue };
}
const customInput = (id: string, submissionId: string, commandId: number, turnRowId: string | null = 'root-row') => mock.options!.onRequest({
  requestId: id, kind: 'native-input', input: { sessionFile: file, commandId, ...(turnRowId ? { turnRowId } : {}),
    row: { type: 'custom_message', id, customType: 'lex-gui-append', content: 'same text', display: true, details: { submissionId } } },
}, new AbortController().signal);
describe('Pi original interactive task control', () => {
  const delegated: OrcaNativeBodySource = { version: 1, targetSessionId: 'task', clientId: 'orca-1',
    role: 'worker', teamId: 'team-1', workerId: 'worker-1', leadSessionId: 'lead-1' };
  it('binds an authorized idle Orca body only to its independent custom row and clientId', async () => {
    const f = await fixture(file, () => true), receipt = vi.fn();
    mock.enqueue.mockImplementation((_kind, payload) => ({ id: 71, result: Promise.resolve().then(async () => {
      expect(payload).toMatchObject({ submissionId: 'orca-1', delegated: true });
      expect(await customInput('foreign-gui', 'orca-1', 71, null)).toEqual({ accepted: false });
      expect(receipt).not.toHaveBeenCalled();
      expect(await mock.options!.onRequest({ requestId: 'orca-row', kind: 'native-input', input: {
        sessionFile: file, commandId: 71, row: { type: 'custom_message', id: 'orca-row', customType: 'lex-orca-body',
          content: 'same text', details: { submissionId: 'orca-1' } },
      } }, new AbortController().signal)).toEqual({ accepted: true });
      return { accepted: true };
    }) }));
    await f.handle.send({ type: 'user', content: 'same text' }, { [ORCA_NATIVE_BODY]: delegated,
      messageUuid: 'orca-1', onNativeUserMessage: receipt });
    expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'orca-row',
      bridge: expect.objectContaining({ submissionId: 'orca-1' }) }));
  });
  it('refuses stale or foreign delegated identity without dispatch and never grants delegated steering', async () => {
    const f = await fixture(file, () => false);
    await expect(f.handle.send({ type: 'user', content: 'same text' }, { [ORCA_NATIVE_BODY]: delegated,
      messageUuid: 'orca-1' })).rejects.toBeInstanceOf(TurnDispatchRejectedError);
    expect(mock.enqueue).not.toHaveBeenCalled();
    await expect(f.handle.steer({ type: 'user', content: 'same text' }, { [ORCA_NATIVE_BODY]: delegated }))
      .rejects.toBeInstanceOf(TurnDispatchRejectedError);
  });
  it('does not publish an older role when another native identity readback overtakes it', async () => {
    const f = await fixture(), firstApply = vi.fn(), lastApply = vi.fn();
    const completions: Array<(value: unknown) => void> = [];
    mock.command.mockImplementation(() => new Promise(resolve => completions.push(resolve)));
    const first = f.control.updateHostIdentity(firstApply);
    const firstOutcome = first.catch(error => error);
    const last = f.control.updateHostIdentity(lastApply);
    completions[1]!({ ok: true, data: { tools: ['cindy_mcp_list_tools', 'cindy_mcp_call_tool'] } });
    await last;
    completions[0]!({ ok: true, data: { tools: ['cindy_mcp_list_tools', 'cindy_mcp_call_tool'] } });
    expect(await firstOutcome).toBeInstanceOf(Error);
    expect(firstApply).not.toHaveBeenCalled(); expect(lastApply).toHaveBeenCalledOnce();
  });
  it('checks both actual native gateways and keeps the input lease frozen during role readback', async () => {
    const f = await fixture(), apply = vi.fn();
    const peer = f.handle.presentation!.attach('role-view', () => {});
    let finish!: (value: unknown) => void;
    mock.command.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const change = f.control.updateHostIdentity(apply);
    expect(peer.acquireControl()).toBeNull(); expect(apply).not.toHaveBeenCalled();
    finish({ ok: true, data: { tools: ['cindy_mcp_list_tools', 'cindy_mcp_call_tool'] } });
    await change; expect(apply).toHaveBeenCalledOnce(); expect(peer.acquireControl()).not.toBeNull();
    mock.command.mockResolvedValue({ ok: true, data: { tools: ['cindy_mcp_list_tools'] } });
    await expect(f.control.updateHostIdentity(apply)).rejects.toThrow('gateways');
    expect(apply).toHaveBeenCalledOnce(); peer.detach();
  });
  it('revokes a pending role promotion synchronously without waiting for native readback', async () => {
    const f = await fixture(), apply = vi.fn();
    let finish!: (value: unknown) => void;
    mock.command.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.control.updateHostIdentity(apply);
    const outcome = pending.catch(error => error);
    f.control.invalidateHostIdentity();
    finish({ ok: true, data: { tools: ['cindy_mcp_list_tools', 'cindy_mcp_call_tool'] } });
    expect(await outcome).toBeInstanceOf(Error); expect(apply).not.toHaveBeenCalled();
  });
  it('admits an independent native addition after the GUI row but before agent_start is delivered', async () => {
    const f = await fixture(), receipt = vi.fn();
    const session = new Session({ id: 'task', agentKind: 'pi', workDir: os.tmpdir(), handle: f.handle,
      capabilities, logger, turnStallMs: 0 });
    cleanups.push(() => session.close());
    session.onNativeInput(input => session.acceptNativeSteer(input));
    mock.enqueue.mockImplementation(() => ({ id: 61, result: Promise.resolve().then(async () => {
      expect(await customInput('first-gui-row', 'first-gui', 61, null)).toEqual({ accepted: true });
      expect(f.handle.isTurnRunning!()).toBe(true);
      expect(await f.input('independent-same-text', 'same text')).toEqual({ accepted: true, text: 'same text' });
      return { accepted: true };
    }) }));
    await session.send('same text', { [GUI_NATIVE_BODY]: true, messageUuid: 'first-gui', onNativeUserMessage: receipt });
    expect(receipt).toHaveBeenCalledOnce(); expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.handle.getCurrentTurnId!()).toBe('first-gui-row');
    f.event('agent_settled', { outcome: 'completed' });
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
  });
  it('requires the queued custom token, never an independent ordinary row, for a GUI append receipt', async () => {
    const f = await fixture(), receipt = vi.fn();
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    f.event('agent_start'); await f.input('root-row');
    mock.enqueue.mockImplementation((_kind, payload) => ({ id: 51, result: Promise.resolve().then(async () => {
      expect(await f.input('independent-extension', 'same text', 51)).toEqual({ accepted: false });
      expect(receipt).not.toHaveBeenCalled();
      expect(await customInput('real-custom', payload.submissionId, 51)).toEqual({ accepted: true });
      return { accepted: true };
    }) }));
    await f.handle.steer({ type: 'user', content: 'same text' }, { [GUI_NATIVE_APPEND]: true, messageUuid: 'owned-submission', onNativeUserMessage: receipt });
    expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'real-custom',
      bridge: expect.objectContaining({ submissionId: 'owned-submission' }) }));
  });
  it('steers through the original handle and confirms only its consumed row, without starting another turn', async () => {
    const f = await fixture(), receipt = vi.fn();
    f.handle.setNativeInputResolver!(async input => { await input.accept(input.message, {}); });
    f.event('agent_start'); await f.input('root-row');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mock.enqueue.mockImplementation(() => ({ id: 12, result: gate.then(async () => {
      expect(await customInput('steer-row', 'gui-steer', 12)).toEqual({ accepted: true });
      return { accepted: true };
    }) }));
    const pending = f.handle.steer({ type: 'user', content: 'add detail' }, { [GUI_NATIVE_APPEND]: true, messageUuid: 'gui-steer', onNativeUserMessage: receipt });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(mock.enqueue).toHaveBeenCalledOnce());
    expect(receipt).not.toHaveBeenCalled();
    release(); await pending;
    expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'steer-row' }));
    expect(f.handle.getCurrentTurnId?.()).toBe('root-row');
    expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('prepares an original terminal steering row through the existing owner without submitting it again', async () => {
    const f = await fixture();
    const owner = vi.fn(async (input: Parameters<NonNullable<typeof f.handle.setNativeInputResolver>>[0] extends (input: infer I) => unknown ? I : never) => {
      await input.accept(input.message, {});
    });
    f.handle.setNativeInputResolver!(owner);
    f.event('agent_start'); await f.input('root-row');
    expect(await f.input('native-steer', 'more detail')).toEqual({ accepted: true, text: 'more detail' });
    expect(owner.mock.calls[1]![0]).toMatchObject({ nativeTurnId: 'root-row', nativeMessageId: 'native-steer' });
    expect(f.handle.getCurrentTurnId?.()).toBe('root-row');
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
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
      expect(await f.input('independent-row', 'GUI input', 7)).toEqual({ accepted: false });
      expect(await customInput('gui-row', 'product-message', 7, null)).toEqual({ accepted: true });
      return { accepted: true };
    }) }));
    await f.handle.send({ type: 'user', content: 'GUI input' }, { [GUI_NATIVE_BODY]: true, messageUuid: 'product-message', onNativeUserMessage: receipt });
    expect(receipt).toHaveBeenCalledExactlyOnceWith({ version: 1, engine: 'pi', sessionId: file, messageId: 'gui-row',
      origin: { kind: 'plugin', name: 'lex-pi-native-bridge' }, bridge: { sessionId: file, messageId: 'gui-row', submissionId: 'product-message', pluginName: 'lex-pi-native-bridge' } });
    expect(mock.enqueue).toHaveBeenCalledOnce(); expect(f.driver.write).not.toHaveBeenCalled();
  });
  it('never retries an unconfirmed GUI command and preserves the caller input', async () => {
    const f = await fixture(), message = { type: 'user' as const, content: 'explicit only once' };
    mock.enqueue.mockReturnValue({ id: 9, result: Promise.reject(new Error('receipt lost')) });
    await expect(f.handle.send(message, { [GUI_NATIVE_BODY]: true })).rejects.toThrow('receipt lost');
    expect(mock.enqueue).toHaveBeenCalledOnce(); expect(message.content).toBe('explicit only once');
  });
  it('does not give a GUI receipt to a different semantic command', async () => {
    const f = await fixture(), receipt = vi.fn();
    mock.enqueue.mockImplementation(() => ({ id: 7, result: Promise.resolve().then(async () => {
      expect(await f.input('other-row', 'another semantic command', 7)).toEqual({ accepted: false });
      return { refusedBeforeSubmission: true };
    }) }));
    await expect(f.handle.send({ type: 'user', content: 'intended command' }, { [GUI_NATIVE_BODY]: true, messageUuid: 'product-message', onNativeUserMessage: receipt })).rejects.toThrow('not accepted');
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
