import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { projectNativeFileApproval } from './native-file-approval.js';

describe('native single-operation file approval', () => {
  const request = { id: 7, method: 'item/fileChange/requestApproval' as const, params: {
    threadId: 'thread', turnId: 'turn', itemId: 'item', reason: 'fixture edit',
    changes: [{ path: '/protocol/path.txt', diff: '+fixture' }], grantRoot: '/protocol',
  } };
  const answer = (label: string) => ({ answers: { 'lex-file-change': { answers: [label] } } });
  it('shows the exact changes but offers no persistent grant', () => {
    const p = projectNativeFileApproval(request);
    assert.equal(p.request.method, 'item/tool/requestUserInput');
    const questions = p.request.params.questions as Array<{ question: string; options: unknown[] }>;
    assert.match(questions[0]!.question, /fixture edit/);
    assert.match(questions[0]!.question, /\+fixture/);
    assert.equal(questions[0]!.options.length, 2);
    assert.deepEqual(p.decode(answer('Apply these changes once')), { decision: 'accept' });
    assert.equal(p.decode({ decision: 'acceptForSession' }), undefined);
    assert.equal(p.decode(answer('Allow for session')), undefined);
  });
  it('preserves explicit refusal and native cancellation', () => {
    const p = projectNativeFileApproval(request);
    assert.deepEqual(p.decode(answer('Cancel these changes')), { decision: 'cancel' });
    assert.deepEqual(p.decode({ answers: {} }), { decision: 'cancel' });
    assert.deepEqual(p.decode({ answers: { 'lex-file-change': { answers: [] } } }), { decision: 'cancel' });
    assert.equal(p.decode({ answers: { foreign: { answers: [] } } }), undefined);
    assert.equal(p.decode({ answers: { 'lex-file-change': { answers: ['Apply these changes once', 'Cancel these changes'] } } }), undefined);
  });
  it('uses the frozen localized labels and changes', () => {
    const copy = { header: '文件修改', confirmation: '确认修改', once: '仅允许本次修改', onceDescription: '本次',
      cancel: '取消修改', cancelDescription: '不修改' };
    const mutable = structuredClone(request);
    const p = projectNativeFileApproval(mutable, copy);
    mutable.params.changes[0]!.diff = '+changed'; copy.once = 'changed';
    assert.deepEqual(p.decode(answer('仅允许本次修改')), { decision: 'accept' });
    assert.equal(p.decode(answer('changed')), undefined);
    assert.match(JSON.stringify(p.request), /\+fixture/);
  });
});
