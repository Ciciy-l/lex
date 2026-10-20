import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexNativeApprovals, type CodexNativeApprovalRequest, type CodexNativeApprovalEvent } from './native-approvals.js';

const request = (id: string | number = 0): CodexNativeApprovalRequest => ({ id, method: 'item/commandExecution/requestApproval',
  params: { threadId: 'owned-thread', turnId: 'owned-turn', itemId: 'owned-item', command: 'fixture',
    availableDecisions: ['accept', 'cancel', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['fixture'] } }] } });
function fixture() {
  const broker = new CodexNativeApprovals(); const events: CodexNativeApprovalEvent[] = []; const answers: unknown[] = [];
  const native = broker.attach(event => events.push(event));
  const open = (allowPersistent = true) => broker.open(request(), { allowPersistent, accept: (...values) => answers.push(values) });
  return { broker, events, answers, native, open };
}
describe('native approval remains behind the host decision boundary', () => {
  it('cannot answer a native broadcast before the host makes that request eligible', () => {
    const f = fixture(); assert.equal(f.native.answer(0, { decision: 'accept' }), false); assert.deepEqual(f.answers, []);
  });
  it('publishes the exact request once, accepts the first answer and retires every view', async () => {
    const f = fixture(); const other: CodexNativeApprovalEvent[] = []; const second = f.broker.attach(event => other.push(event));
    f.open(); await Promise.resolve(); assert.equal(f.events.length, 1);
    assert.equal(second.answer(0, { decision: 'accept' }), true);
    assert.equal(f.native.answer(0, { decision: 'cancel' }), false);
    assert.deepEqual(f.answers, [[{ decision: 'accept' }, 'allow', false]]);
    assert.deepEqual(f.events.map(e => e.kind), ['request', 'resolved']); assert.deepEqual(other, f.events);
  });
  it('a GUI answer revokes a late native answer without calling the tool again', async () => {
    const f = fixture(); const pending = f.open(); await Promise.resolve(); pending.close();
    assert.equal(f.native.answer(0, { decision: 'accept' }), false); assert.deepEqual(f.answers, []);
    assert.deepEqual(f.events.map(e => e.kind), ['request', 'resolved']);
  });
  it('a new frontend snapshots a pending approval without duplicate publication', async () => {
    const f = fixture(); f.open(); const seen: CodexNativeApprovalEvent[] = []; f.broker.attach(event => seen.push(event));
    await Promise.resolve(); assert.equal(seen.length, 1); assert.equal(f.events.length, 1);
  });
  it('preserves only the exact advertised native policy amendment', () => {
    const f = fixture(); f.open();
    assert.equal(f.native.answer(0, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['broader'] } } }), false);
    const amendment = request().params.availableDecisions as unknown[];
    assert.equal(f.native.answer(0, { decision: amendment[3] }), true);
    assert.deepEqual(f.answers, [[{ decision: amendment[3] }, 'allow', false]]);
  });
  it('forced confirmation cannot acquire persistent or session-wide authority', async () => {
    const f = fixture(); f.open(false); await Promise.resolve();
    assert.deepEqual((f.events[0] as { kind: 'request'; request: CodexNativeApprovalRequest }).request.params.availableDecisions, ['accept', 'cancel']);
    assert.equal(f.native.answer(0, { decision: 'acceptForSession' }), false);
    assert.equal(f.native.answer(0, { decision: (request().params.availableDecisions as unknown[])[3] }), false);
    assert.equal(f.native.answer(0, { decision: 'accept' }), true);
  });
  it.each(['allow', 'deny'] as const)('preserves the actual %s of an advertised network amendment', behavior => {
    const f = fixture();
    const decision = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: behavior } } };
    f.broker.open({ ...request(), params: { ...request().params, availableDecisions: [decision] } },
      { allowPersistent: true, accept: (...values) => f.answers.push(values) });
    assert.equal(f.native.answer(0, { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: '*', action: behavior } } } }), false);
    assert.equal(f.native.answer(0, { decision }), true);
    assert.deepEqual(f.answers, [[{ decision }, behavior, false]]);
  });
  it('does not guess the meaning of an unknown native amendment shape', async () => {
    const f = fixture();
    const decision = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'invented' } } };
    f.broker.open({ ...request(), params: { ...request().params, availableDecisions: [decision, 'cancel'] } },
      { allowPersistent: true, accept: (...values) => f.answers.push(values) });
    await Promise.resolve();
    assert.equal(f.native.answer(0, { decision }), false);
    assert.deepEqual((f.events[0] as { kind: 'request'; request: CodexNativeApprovalRequest }).request.params.availableDecisions, ['cancel']);
  });
  it('detaching one frontend leaves the request and other frontend usable', () => {
    const f = fixture(); f.open(); const second = f.broker.attach(() => {}); f.native.detach();
    assert.equal(f.native.answer(0, { decision: 'accept' }), false);
    assert.equal(second.answer(0, { decision: 'cancel' }), true);
    assert.deepEqual(f.answers, [[{ decision: 'cancel' }, 'deny', false]]);
  });
  it('close fences all old frontends and does not reopen an unresolved request', () => {
    const f = fixture(); f.open(); f.broker.close();
    assert.equal(f.native.answer(0, { decision: 'accept' }), false); assert.deepEqual(f.answers, []);
    assert.throws(() => f.open(), /unavailable/); assert.throws(() => f.broker.attach(() => {}), /closed/);
  });
  it('frontends cannot mutate another view or the accepted decision catalog', async () => {
    const f = fixture(); f.broker.attach(event => { if (event.kind === 'request') (event.request.params.availableDecisions as unknown[]).push('invented'); });
    f.open(); await Promise.resolve(); assert.equal(f.native.answer(0, { decision: 'invented' }), false);
    assert.equal(f.native.answer(0, { decision: 'accept', injected: true }), false);
    assert.equal(f.native.answer(0, { decision: 'accept' }), true);
  });
  it('reentrant answers cannot win twice and a broken frontend does not stop other views', async () => {
    const f = fixture(); f.broker.attach(() => { throw new Error('fixture'); });
    const second = f.broker.attach(() => {});
    f.broker.open(request(), { allowPersistent: true, accept: () => {
      assert.equal(second.answer(0, { decision: 'accept' }), false);
      f.answers.push('once');
    } });
    await Promise.resolve(); assert.equal(f.native.answer(0, { decision: 'accept' }), true); assert.deepEqual(f.answers, ['once']);
  });
  it('an immediate native answer cannot publish a stale prompt to a later observer', async () => {
    const broker = new CodexNativeApprovals(); const later: CodexNativeApprovalEvent[] = [];
    const first = broker.attach(event => { if (event.kind === 'request') first.answer(event.request.id, { decision: 'accept' }); });
    broker.attach(event => later.push(event));
    broker.open(request(), { allowPersistent: true, accept() {} });
    await Promise.resolve(); assert.deepEqual(later, []);
  });
});
