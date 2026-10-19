import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexNativeApprovals } from './native-approvals.js';
import { CodexNativeQuestions, nativeQuestionAnswer } from './native-questions.js';
const question = { id: 'q', header: 'Direction', question: 'Pick a direction', isOther: true, isSecret: false, options: null };
function fixture() {
  const broker = new CodexNativeApprovals(), events: unknown[] = [], receipts: unknown[] = [];
  const native = broker.attach(event => events.push(event));
  const questions = new CodexNativeQuestions(broker, (...args) => receipts.push(args));
  let current = true;
  const owner = questions.open('gui', [question], () => current);
  const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [question] };
  const prompt = questions.attach('gui', { id: 8, params });
  return { broker, native, questions, owner, prompt, params, events, receipts, stale() { current = false; } };
}
describe('native questions share one GUI decision', () => {
  it('preserves native answers including multi-valued text and ignores late GUI answers', async () => {
    const f = fixture(); await Promise.resolve();
    assert.equal(f.native.answer(8, { answers: { q: { answers: ['A', 'free text'] } } }), true);
    assert.deepEqual(await f.owner.decision, { kind: 'ask_user_question', answers: { 'Pick a direction': '["A","free text"]' } });
    assert.equal(f.owner.gui({ kind: 'ask_user_question', answers: {} }), false);
    assert.equal(f.receipts.length, 1);
  });
  it('GUI wins once and closes every native prompt', async () => {
    const f = fixture(); f.owner.gui({ kind: 'ask_user_question', answers: { Direction: 'B' } });
    assert.equal(f.native.answer(8, { answers: {} }), false);
    assert.deepEqual(await f.owner.decision, { kind: 'ask_user_question', answers: { Direction: 'B' } });
    assert.equal(f.receipts.length, 0);
  });
  it('joins protocol aliases by existing question position, with one accepted reply', async () => {
    const f = fixture();
    f.questions.attach('gui', { id: 9, params: { ...f.params, questions: [{ ...question, id: 'alias' }] } });
    assert.equal(f.native.answer(9, { answers: { alias: { answers: ['C'] } } }), false);
    assert.equal(f.native.answer(8, { answers: { q: { answers: ['C'] } } }), true);
    assert.equal(f.native.answer(8, { answers: { q: { answers: ['A'] } } }), false);
    assert.equal((await f.owner.decision).answers[question.question], '["C"]');
    assert.equal(f.receipts.length, 1);
  });
  it('cancel, stale ownership and detaching one alias cannot submit a late answer', async () => {
    const f = fixture(); f.stale(); assert.equal(f.native.answer(8, { answers: {} }), false);
    f.questions.cancel('gui'); assert.equal((await f.owner.decision).dismissed, true);
    assert.equal(f.native.answer(8, { answers: {} }), false);
    const other = fixture(); other.prompt.close();
    assert.equal(other.native.answer(8, { answers: {} }), false);
    other.owner.gui({ kind: 'ask_user_question', answers: {} });
    assert.equal((await other.owner.decision).dismissed, undefined);
  });
  it('rejects unknown ids, malformed values and secret questions without consuming the prompt', async () => {
    const f = fixture();
    for (const response of [{ answers: { other: { answers: ['wrong'] } } }, { answers: { q: { answers: [1] } } },
      { answers: {}, ignored: true }, { answers: { q: { answers: ['A'], ignored: true } } }])
      assert.equal(f.native.answer(8, response), false);
    assert.equal(f.native.answer(8, { answers: {} }), true); await f.owner.decision;
    assert.equal(f.receipts.length, 1);
    assert.equal(nativeQuestionAnswer({ answers: { q: { answers: ['secret'] } } }, [{ ...question, isSecret: true }], [question]), undefined);
    assert.equal(nativeQuestionAnswer({ answers: { q: { answers: Array(11).fill('x'.repeat(100_000)) } } }, [question], [question]), undefined);
  });
  it('keeps a detached GUI follow-up answerable without letting its retired native prompt answer', async () => {
    const f = fixture();
    f.questions.retireNative(8);
    assert.equal(f.native.answer(8, { answers: { q: { answers: ['late'] } } }), false);
    f.owner.gui({ kind: 'ask_user_question', answers: { [question.question]: 'GUI follow-up' } });
    assert.equal((await f.owner.decision).answers[question.question], 'GUI follow-up');
    assert.equal(f.receipts.length, 0);
  });
});
