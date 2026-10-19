import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { AgentNativeRuntimeBinding } from './native-runtime.js';
import type { AgentNativeRuntimeRequest } from './native-runtime.js';
function request(patch = { model: 'chosen' }): AgentNativeRuntimeRequest {
  return { nativeSessionId: 'owned', patch, signal: new AbortController().signal };
}
function held() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('native runtime product ownership', () => {
  it('requires the actual active task owner and preserves native identity', async () => {
    const binding = new AgentNativeRuntimeBinding(() => 'owned', () => true);
    await assert.rejects(binding.resolve(request()), /no product owner/);
    const seen: AgentNativeRuntimeRequest[] = [];
    binding.bind(async input => { seen.push(input); });
    assert.throws(() => binding.bind(async () => {}), /already owned/);
    await assert.rejects(binding.resolve({ ...request(), nativeSessionId: 'foreign' }), /owner changed/);
    await binding.resolve(request());
    assert.equal(seen.length, 1); assert.equal(seen[0]!.nativeSessionId, 'owned');
    assert.deepEqual(seen[0]!.patch, { model: 'chosen' });
  });
  it('retires in-flight work without allowing an old disposer to retire the next owner', async () => {
    const binding = new AgentNativeRuntimeBinding(() => 'owned', () => true), gate = held();
    let signal: AbortSignal | undefined;
    const dispose = binding.bind(async input => { signal = input.signal; await gate.promise; });
    const old = assert.rejects(binding.resolve(request()), /owner changed/);
    binding.retire(); assert.equal(signal?.aborted, true);
    let count = 0; binding.bind(async () => { count++; }); dispose();
    gate.resolve(); await old; await binding.resolve(request()); assert.equal(count, 1);
  });
  it('refuses late success when the session or its native thread changes', async () => {
    for (const kind of ['session', 'thread']) {
      let active = true, nativeId = 'owned'; const gate = held();
      const binding = new AgentNativeRuntimeBinding(() => nativeId, () => active);
      binding.bind(async () => { await gate.promise; });
      const result = assert.rejects(binding.resolve(request()), /owner changed/);
      if (kind === 'session') active = false; else nativeId = 'replacement';
      gate.resolve(); await result;
    }
  });
  it('freezes the submitted selection and forwards cancellation', async () => {
    const binding = new AgentNativeRuntimeBinding(() => 'owned', () => true), gate = held(), controller = new AbortController();
    let seen: AgentNativeRuntimeRequest | undefined;
    binding.bind(async input => { seen = input; await gate.promise; });
    const original = request();
    const result = assert.rejects(binding.resolve({ ...original, signal: controller.signal }), /owner changed/);
    (original.patch as { model: string }).model = 'changed'; controller.abort();
    assert.equal(seen!.patch.model, 'chosen'); assert.equal(seen!.signal.aborted, true);
    assert.equal(Object.isFrozen(seen!.patch), true); gate.resolve(); await result;
  });
});
