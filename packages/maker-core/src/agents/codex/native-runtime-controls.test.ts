import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexNativeRuntimeControls, decodeCodexNativeRuntimePatch as decode } from './native-runtime-controls.js';
import type { AgentNativeRuntimeRequest } from '../native-runtime.js';
function held() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const signal = () => new AbortController().signal;
describe('Codex native runtime menu', () => {
  it('decodes the observed model and mode fields without injecting task instructions', () => {
    assert.deepEqual(decode({ threadId: 'owned', model: 'chosen', effort: null, approvalPolicy: null,
      collaborationMode: { mode: 'plan', settings: { model: 'chosen', reasoning_effort: 'high', developer_instructions: null } } }, 'owned'),
      { model: 'chosen', effort: 'high', planMode: true });
    assert.deepEqual(decode({ threadId: 'owned', effort: 'none' }, 'owned'), { effort: null });
    assert.deepEqual(decode({ threadId: 'owned', serviceTier: null }, 'owned'), { fastMode: false });
    assert.deepEqual(decode({ threadId: 'owned', serviceTier: 'priority' }, 'owned'), { fastMode: true });
    assert.deepEqual(decode({ threadId: 'owned', model: null, effort: null }, 'owned'), {});
    for (const patch of [
      { model: 'selected', collaborationMode: { mode: 'default', settings: { model: 'other' } } },
      { effort: 'high', collaborationMode: { mode: 'default', settings: { reasoning_effort: 'low' } } },
      { collaborationMode: { mode: 'plan', settings: { developer_instructions: 'replace the prompt' } } },
      { model: '' }, { model: 'bad\nmodel' }, { effort: 'unknown' }, { serviceTier: 'unsupported' },
      { approvalPolicy: 'never' }, { permissions: ':full-access' }, { modelProvider: 'foreign' },
    ]) assert.throws(() => decode({ threadId: 'owned', ...patch }, 'owned'));
    assert.throws(() => decode({ threadId: 'foreign', model: 'chosen' }, 'owned'), /another task/);
  });
  it('requires a product owner and confirms only after the product control finishes', async () => {
    const gate = held(), seen: AgentNativeRuntimeRequest[] = []; let confirmed = 0, done = false;
    const control = new CodexNativeRuntimeControls(() => 'owned', async run => { confirmed++; return run(); });
    await assert.rejects(control.apply({ threadId: 'owned', model: 'chosen' }, signal()), /product owner/);
    control.bind(async input => { seen.push(input); await gate.promise; });
    const pending = control.apply({ threadId: 'owned', model: 'chosen' }, signal()).then(result => { done = true; return result; });
    await Promise.resolve(); assert.equal(done, false); assert.equal(confirmed, 1);
    assert.equal(seen[0]!.nativeSessionId, 'owned'); assert.deepEqual(seen[0]!.patch, { model: 'chosen' });
    gate.resolve(); assert.deepEqual(await pending, {}); assert.equal(done, true);
  });
  it('serializes menu changes and a failed operation does not poison the next selection', async () => {
    const gate = held(), seen: string[] = [];
    const control = new CodexNativeRuntimeControls(() => 'owned', run => run());
    control.bind(async input => {
      seen.push(input.patch.model!);
      if (input.patch.model === 'first') { await gate.promise; throw new Error('not applied'); }
    });
    const first = assert.rejects(control.apply({ threadId: 'owned', model: 'first' }, signal()), /not applied/);
    const second = control.apply({ threadId: 'owned', model: 'second' }, signal());
    await Promise.resolve(); assert.deepEqual(seen, ['first']); gate.resolve();
    await first; await second; assert.deepEqual(seen, ['first', 'second']);
  });
  it('fences queued changes and late receipts at owner replacement, retirement and cancellation', async () => {
    for (const boundary of ['replace', 'close', 'thread', 'cancel']) {
      let thread = 'owned', count = 0; const gate = held(), controller = new AbortController();
      const control = new CodexNativeRuntimeControls(() => thread, run => run());
      control.bind(async () => { count++; await gate.promise; });
      const first = assert.rejects(control.apply({ threadId: 'owned', model: 'first' }, controller.signal), /product owner/);
      const second = assert.rejects(control.apply({ threadId: 'owned', model: 'second' }, controller.signal), /product owner/);
      await Promise.resolve();
      if (boundary === 'replace') control.bind(async () => { count++; });
      else if (boundary === 'close') control.close();
      else if (boundary === 'thread') thread = 'replacement';
      else controller.abort();
      gate.resolve(); await Promise.all([first, second]); assert.equal(count, 1);
    }
  });
});
