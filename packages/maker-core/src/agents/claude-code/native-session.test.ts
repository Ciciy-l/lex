import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../session.js';
import { AgentPresentationRuntime } from '../presentation.js';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type AgentSessionHandle } from '../base-agent.js';
import type { ClaudeNativeRuntimeOptions } from './native-runtime.js';
import type { ClaudeNativeUserMessage } from './native-messages.js';
import { createClaudeNativeSession } from './native-session.js';

const mocked = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./native-runtime.js', () => ({ createClaudeNativeRuntime: mocked.create }));
const handles: AgentSessionHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())); vi.clearAllMocks(); });

async function fixture() {
  let callbacks!: ClaudeNativeRuntimeOptions;
  const driver = { write: vi.fn(), resize: vi.fn(), close: vi.fn(), onData: () => vi.fn(), onExit: () => vi.fn() };
  const presentation = new AgentPresentationRuntime('native', driver);
  const runtime = { presentation, ready: Promise.resolve(), command: vi.fn(async () => ({})),
    submit: vi.fn(async (_input: any) => ({ nativeMessageId: 'row' })), close: vi.fn(async () => { await presentation.close(); }) };
  mocked.create.mockImplementation(async options => { callbacks = options; return runtime; });
  const policy = { setInteractionResolver: vi.fn(), beforeInput: vi.fn(async () => {}), close: vi.fn() };
  const onFault = vi.fn(), observer = vi.fn();
  const prepareInput = vi.fn(async (message: any) => ({ text: typeof message.content === 'string' ? message.content : message.content[0].text }));
  const handle = await createClaudeNativeSession({ model: 'fixture', policy, prepareInput, onFault, runtime: {
    nativeSessionId: 'native', executable: 'owned', cwd: '/fixture', args: [], env: {}, launch: () => driver, onEvent: observer,
  } });
  handles.push(handle);
  const row = (uuid: string, submissionId?: string): ClaudeNativeUserMessage => ({
    row: { sessionId: 'native', uuid, door: 'prompt', origin: submissionId ? { kind: 'plugin', name: 'lex-native-bridge' } : { kind: 'composer' },
      message: { type: 'user', content: [{ type: 'text', text: 'input' }] } }, display: { content: [{ type: 'text', text: 'input' }] },
    ...(submissionId ? { submission: { sessionId: 'native', nativeMessageId: uuid, submissionId, pluginName: 'lex-native-bridge', originalContent: [{ type: 'text', text: 'input' }] } } : {}),
  });
  const start = async (message: ClaudeNativeUserMessage, id = 'turn') => {
    callbacks.onUserMessage!(message);
    callbacks.onEvent({ sequence: 1, kind: 'turn.start', value: { turnId: id, messageIds: [message.row.uuid] } });
    await callbacks.onTurnAdmission!({ nativeSessionId: 'native', turnId: id, messages: [message] }, new AbortController().signal);
    callbacks.onAgentEvent!({ type: 'status', source: 'claude-code', data: { isRunning: true } });
  };
  const finish = (id = 'turn') => {
    callbacks.onAgentEvent!({ type: 'done', source: 'claude-code', data: { is_error: false, nativeTurnId: id } });
    callbacks.onEvent({ sequence: 2, kind: 'turn.complete', value: { turnId: id, reason: 'answer', isAborted: false } });
  };
  const logger: any = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = new Session({ id: 'task', agentKind: 'claude-code', workDir: '/fixture', logger, handle, capabilities: {} as any, turnStallMs: 0 });
  return { handle, session, policy, prepareInput, runtime, driver, onFault, callbacks, row, start, finish };
}

describe('Claude native Maker handle', () => {
  it('uses one real Session reservation for GUI and native input and keeps presentation detach independent', async () => {
    const f = await fixture(), history = vi.fn(), terminal = vi.fn();
    f.session.setTurnLifecycleObserver({ beforeProviderStart() {}, onUndispatched() {}, onTerminal: terminal });
    f.runtime.submit.mockImplementation(async input => {
      await f.start(f.row('gui-row', input.messageId));
      return { nativeMessageId: 'gui-row' };
    });
    const receipt = vi.fn();
    expect(await f.session.send('GUI', { messageUuid: 'host-row', onNativeUserMessage: receipt, onAccepted: history })).toEqual({ accepted: true });
    expect(f.runtime.submit).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'host-row', text: 'GUI', onNativeUserMessage: receipt }));
    expect(f.policy.beforeInput).toHaveBeenCalledTimes(1);
    const view = f.handle.presentation!.attach('desktop', vi.fn()); view.detach();
    expect(f.runtime.close).not.toHaveBeenCalled(); expect(f.driver.close).not.toHaveBeenCalled();
    f.finish(); await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1));
    f.session.onNativeInput(async input => {
      expect(await f.session.acceptNativeInput(input, { onAccepted: history })).toEqual({ accepted: true });
    });
    const accepted = vi.fn(async () => {});
    await f.callbacks.onNativeInput!({ nativeSessionId: 'native', nativeMessageId: 'tui-row',
      message: { type: 'user', content: 'TUI' }, signal: new AbortController().signal, accept: accepted });
    await f.start(f.row('tui-row'), 'tui-turn'); f.finish('tui-turn');
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(2));
    expect(history).toHaveBeenCalledTimes(2); expect(accepted).toHaveBeenCalledOnce();
    expect(f.runtime.submit).toHaveBeenCalledOnce(); expect(mocked.create).toHaveBeenCalledOnce();
    expect(f.policy.beforeInput).toHaveBeenCalledTimes(2);
    await f.session.close();
  });

  it('closes an unconfirmed dispatch through Session without replaying it', async () => {
    const f = await fixture(); f.runtime.submit.mockRejectedValue(new Error('receipt lost'));
    await expect(f.session.send('input', { messageUuid: 'host-row' })).rejects.toBeInstanceOf(TurnDispatchUnconfirmedError);
    expect(f.runtime.submit).toHaveBeenCalledOnce(); expect(f.runtime.close).toHaveBeenCalledOnce();
    expect(f.session.getStatus()).toBe('closed');
  });

  it('retains accepted status after an actual native row even when its command response is lost', async () => {
    const f = await fixture();
    f.runtime.submit.mockImplementation(async input => {
      await f.start(f.row('actual', input.messageId)); throw new Error('command response lost');
    });
    expect(await f.session.send('input', { messageUuid: 'host-row' })).toEqual({ accepted: true });
    expect(f.runtime.close).not.toHaveBeenCalled(); expect(f.handle.isTurnRunning?.()).toBe(true);
    f.finish(); await f.session.close();
  });

  it('fences closure during media preparation before any native command or policy mutation', async () => {
    const f = await fixture(); let prepared!: () => void;
    f.prepareInput.mockImplementation(() => new Promise(resolve => { prepared = () => resolve({ text: 'late' }); }));
    const sent = f.handle.send({ type: 'user', content: 'input' });
    await vi.waitFor(() => expect(prepared).toBeDefined()); await f.handle.close(); prepared();
    await expect(sent).rejects.toBeInstanceOf(TurnDispatchRejectedError);
    expect(f.runtime.submit).not.toHaveBeenCalled(); expect(f.policy.beforeInput).not.toHaveBeenCalled();
    expect(f.policy.close).toHaveBeenCalledOnce();
  });

  it('refuses native input without a product owner and does not relabel foreign rows', async () => {
    const f = await fixture(), accept = vi.fn();
    await expect(f.callbacks.onNativeInput!({ nativeSessionId: 'native', nativeMessageId: 'native-input',
      message: { type: 'user', content: 'input' }, signal: new AbortController().signal, accept })).rejects.toThrow('product owner');
    expect(accept).not.toHaveBeenCalled();
    const foreign = f.row('foreign'); foreign.row.origin = { kind: 'plugin', name: 'lex-native-bridge' };
    await expect(f.start(foreign)).rejects.toThrow('not admitted');
    expect(f.runtime.submit).not.toHaveBeenCalled();
  });

  it('stops only the current native turn and keeps its process usable afterwards', async () => {
    const f = await fixture(); f.runtime.submit.mockImplementation(async input => { await f.start(f.row('actual', input.messageId)); return { nativeMessageId: 'actual' }; });
    await f.handle.send({ type: 'user', content: 'input' }); await f.handle.abort();
    expect(f.runtime.command).toHaveBeenCalledExactlyOnceWith('abort', { turnId: 'turn' });
    expect(f.runtime.close).not.toHaveBeenCalled(); f.finish();
    expect(f.handle.isTurnRunning?.()).toBe(false);
  });

  it('retains the exact accepted aborted input when Stop precedes the first model step', async () => {
    const f = await fixture(); let message!: ClaudeNativeUserMessage;
    f.runtime.submit.mockImplementation(async input => {
      message = f.row('actual', input.messageId); f.callbacks.onUserMessage!(message); return { nativeMessageId: 'actual' };
    });
    await f.handle.send({ type: 'user', content: 'input' }); await f.handle.abort();
    f.callbacks.onEvent({ sequence: 1, kind: 'turn.start', value: { turnId: 'stopped', messageIds: ['actual'] } });
    await expect(f.callbacks.onTurnAdmission!({ nativeSessionId: 'native', turnId: 'stopped', messages: [message] }, new AbortController().signal)).rejects.toThrow('not admitted');
    f.callbacks.onEvent({ sequence: 2, kind: 'turn.complete', value: { turnId: 'stopped', reason: 'aborted', isAborted: true } });
    expect(await f.handle.events()[Symbol.asyncIterator]().next()).toMatchObject({ value: { type: 'done', data: { silentStop: true, nativeTurnId: 'stopped' } } });
    expect(f.handle.isTurnRunning?.()).toBe(false); expect(f.runtime.close).not.toHaveBeenCalled();
  });
});
