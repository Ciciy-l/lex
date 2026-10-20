import { describe, expect, it, vi } from 'vitest';
import { ClaudeNativeTurns, type ClaudeNativeTurn } from './native-turns.js';
import type { ClaudeNativeUserMessage } from './native-messages.js';

const row = (uuid: string): ClaudeNativeUserMessage => ({
  row: { sessionId: 'native', uuid, door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', content: [{ type: 'text', text: 'same text' }] } },
  display: { content: [{ type: 'text', text: 'same text' }] },
});
const start = (turnId: string, messageIds: string[]) => ({ sequence: 1, kind: 'turn.start', value: { turnId, messageIds } });
const signal = () => new AbortController().signal;

describe('native model admission', () => {
  it('binds exact accepted rows, including identical prompts, and admits each turn only once', async () => {
    const admit = vi.fn(async (_turn: ClaudeNativeTurn) => {}), turns = new ClaudeNativeTurns('native', admit);
    turns.record(row('first')); turns.record(row('second'));
    turns.accept(start('one', ['first'])); turns.accept(start('two', ['second']));
    expect(await Promise.all([turns.request({ turnId: 'one' }, signal()), turns.request({ turnId: 'one' }, signal()), turns.request({ turnId: 'two' }, signal())])).toEqual([{ allow: true }, { allow: true }, { allow: true }]);
    expect(admit.mock.calls.map(([turn]) => turn.messages.map(message => message.row.uuid))).toEqual([['first'], ['second']]);
    turns.close();
  });
  it('waits for ordered event delivery when the request connection arrives first', async () => {
    const admit = vi.fn(async () => {}), turns = new ClaudeNativeTurns('native', admit);
    const pending = turns.request({ turnId: 'one' }, signal());
    await Promise.resolve(); expect(admit).not.toHaveBeenCalled();
    turns.record(row('first')); turns.accept(start('one', ['first']));
    expect(await pending).toEqual({ allow: true }); turns.close();
  });
  it('does not manufacture input identities for a continuation', async () => {
    const admit = vi.fn(async () => {}), turns = new ClaudeNativeTurns('native', admit);
    turns.accept(start('continuation', [])); await turns.request({ turnId: 'continuation' }, signal());
    expect(admit).toHaveBeenCalledWith({ nativeSessionId: 'native', turnId: 'continuation', messages: [] }, expect.any(AbortSignal));
    turns.close();
  });
  it('rejects missing, reused, or foreign native rows instead of matching text', () => {
    const turns = new ClaudeNativeTurns('native', async () => {});
    expect(() => turns.accept(start('one', ['missing']))).toThrow('identity');
    const foreign = row('first'); foreign.row.sessionId = 'foreign';
    expect(() => turns.record(foreign)).toThrow('identity');
    turns.record(row('first')); turns.accept(start('one', ['first']));
    expect(() => turns.accept(start('two', ['first']))).toThrow('identity');
    expect(() => turns.accept(start('one', []))).toThrow('identity'); turns.close();
  });
  it('never allows a late admission after Stop or a completed turn', async () => {
    for (const stop of ['request', 'turn', 'close']) {
      let release!: () => void;
      const admit = vi.fn(async (_turn, signal: AbortSignal) => { await new Promise<void>(resolve => { release = resolve; }); expect(signal.aborted).toBe(true); });
      const turns = new ClaudeNativeTurns('native', admit), controller = new AbortController();
      turns.record(row('first')); turns.accept(start('one', ['first']));
      const pending = turns.request({ turnId: 'one' }, controller.signal);
      await Promise.resolve();
      if (stop === 'request') controller.abort();
      else if (stop === 'turn') turns.accept({ sequence: 2, kind: 'turn.complete', value: { turnId: 'one' } });
      else turns.close();
      release(); expect(await pending).toEqual({ allow: false }); turns.close();
    }
  });
  it('settles an unknown-turn waiter on close and bounds the event-delivery wait', async () => {
    const turns = new ClaudeNativeTurns('native', async () => {});
    const waiting = expect(turns.request({ turnId: 'unknown' }, signal())).rejects.toThrow('cancelled');
    turns.close(); await waiting;
    vi.useFakeTimers();
    try {
      const timed = new ClaudeNativeTurns('native', async () => {});
      const rejected = expect(timed.request({ turnId: 'missing' }, signal())).rejects.toThrow('unavailable');
      await vi.advanceTimersByTimeAsync(10_000); await rejected; timed.close();
    } finally { vi.useRealTimers(); }
  });
});
