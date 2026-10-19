import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexNativeApprovals, type CodexNativeApprovalEvent } from './native-approvals.js';

const request = { id: 10, method: 'mcpServer/elicitation/request' as const,
  params: { threadId: 'owned', turnId: 'turn', serverName: 'fixture' } };
describe('other native confirmations share the one policy-gated broker', () => {
  it('never forwards an answer before the existing host exposes the prompt', () => {
    const broker = new CodexNativeApprovals(), frontend = broker.attach(() => {});
    assert.equal(frontend.answer(10, { action: 'accept' }), false);
  });
  it('refuses invalid answers without losing the valid outstanding prompt', async () => {
    const broker = new CodexNativeApprovals(), events: CodexNativeApprovalEvent[] = [], accepted: string[] = [];
    const frontend = broker.attach(event => events.push(event));
    broker.openInteraction(request, { normalize: response => response === 'allow-once' ? response : undefined,
      accept: response => accepted.push(response) });
    await Promise.resolve();
    assert.equal(frontend.answer(10, 'always'), false);
    assert.equal(frontend.answer(10, 'allow-once'), true);
    assert.equal(frontend.answer(10, 'allow-once'), false);
    assert.deepEqual(accepted, ['allow-once']); assert.deepEqual(events.map(e => e.kind), ['request', 'resolved']);
  });
  it('cannot reuse a command approval identity for an unrelated elicitation', () => {
    const broker = new CodexNativeApprovals();
    broker.open({ ...request, method: 'item/commandExecution/requestApproval' }, { allowPersistent: false, accept() {} });
    assert.throws(() => broker.openInteraction(request, { normalize: v => v, accept() {} }), /unavailable/);
  });
  it('GUI resolution and host cancellation fence late native replies', () => {
    const broker = new CodexNativeApprovals(), frontend = broker.attach(() => {});
    let count = 0;
    const prompt = broker.openInteraction(request, { normalize: () => true, accept() { count++; } });
    prompt.close(); assert.equal(frontend.answer(10, {}), false); assert.equal(count, 0);
  });
  it('revokes the first response before a callback or another frontend can reenter', () => {
    const broker = new CodexNativeApprovals(), first = broker.attach(() => {}), other = broker.attach(() => {});
    let count = 0;
    broker.openInteraction(request, { normalize: () => true, accept() {
      count++; assert.equal(first.answer(10, {}), false); assert.equal(other.answer(10, {}), false);
    } });
    assert.equal(first.answer(10, {}), true); assert.equal(count, 1);
  });
  it('reconnects pending prompts once and keeps their request snapshots isolated', async () => {
    const broker = new CodexNativeApprovals(), events: CodexNativeApprovalEvent[] = [];
    broker.openInteraction(request, { normalize: () => true, accept() {} });
    const native = broker.attach(event => { events.push(event); if (event.kind === 'request') event.request.params.threadId = 'changed'; });
    await Promise.resolve(); assert.equal(events.length, 1);
    native.detach(); const next: CodexNativeApprovalEvent[] = []; broker.attach(event => next.push(event));
    assert.equal(next.length, 1); assert.equal(next[0]?.kind, 'request');
    if (next[0]?.kind === 'request') assert.equal(next[0].request.params.threadId, 'owned');
    broker.close(); assert.deepEqual(next.map(e => e.kind), ['request', 'resolved']);
  });
});
