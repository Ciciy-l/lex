// Executed only by the native opt-in probe, inside claude plugin test.
import { describe, expect, test, tier } from 'claude-code/testing';

tier('user');
describe('register', () => {
  test('mirrors a model stream without duplicating its request', async ($, on) => {
    let calls = 0;
    on('turn.step', async function* ($, e) {
      calls++;
      yield { kind: 'text', index: 0, text: 'synthetic result' };
      yield { kind: 'stop', stopReason: 'end_turn', usage: null };
      return { turnId: e.turnId, index: e.index, answer: 'synthetic result', toolUses: [], stopReason: 'end_turn', usage: null };
    });
    const stream = $.turn.step({ turnId: 'fixture-turn', index: 0, model: 'fixture-model', messageCount: 1 });
    const chunks = [];
    let result;
    while (true) {
      const item = await stream.next();
      if (item.done) { result = item.value; break; }
      chunks.push(item.value);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'synthetic result' });
    expect(result.answer).toBe('synthetic result');
    expect(calls).toBe(1);
  });
});
