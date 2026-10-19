import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { AgentNativeRuntimeResolver, Session } from '@cindy/maker-core';
import { bindNativeSessionRuntime, type NativeRuntimeBindingDeps } from '../nativeRuntimeBinding.js';
function fixture() {
  let resolve!: AgentNativeRuntimeResolver, alive = true, calls = 0;
  const session = { id: 'task', sdkSessionId: 'native',
    onNativeRuntimeSelection(next: AgentNativeRuntimeResolver) { resolve = next; return () => { alive = false; }; } } as Session;
  const order: string[] = [], controller = new AbortController();
  const deps: NativeRuntimeBindingDeps = {
    isCurrent: () => alive, assertAllowed: async () => { order.push('allowed'); },
    withChangeLock: async (_id, run) => { order.push('lock'); return run(); },
    apply: async (_session, request, check) => { check(); calls++; order.push('apply:' + request.patch.model); },
  };
  const dispose = bindNativeSessionRuntime(session, deps);
  return { session, deps, order, controller, dispose, calls: () => calls,
    run: () => resolve({ nativeSessionId: 'native', patch: { model: 'selected' }, signal: controller.signal }) };
}
describe('Main native task settings ownership', () => {
  it('uses the same task lock and settings transaction', async () => {
    const f = fixture(); await f.run();
    assert.deepEqual(f.order, ['lock', 'allowed', 'apply:selected']); assert.equal(f.calls(), 1);
  });
  it('does not write if the account, native thread or request changes while acquiring the lock', async () => {
    for (const boundary of ['account', 'thread', 'cancel']) {
      const f = fixture();
      f.deps.withChangeLock = async (_id, run) => {
        if (boundary === 'account') f.dispose();
        else if (boundary === 'thread') Object.defineProperty(f.session, 'sdkSessionId', { value: 'other' });
        else f.controller.abort();
        return run();
      };
      await assert.rejects(f.run(), /no longer belong/); assert.equal(f.calls(), 0);
    }
  });
  it('checks the captured owner after awaiting task policy', async () => {
    const f = fixture(); f.deps.assertAllowed = async () => { f.dispose(); };
    await assert.rejects(f.run(), /no longer belong/); assert.equal(f.calls(), 0);
  });
  it('propagates failed persistence and never reports an obsolete transaction as successful', async () => {
    const f = fixture(); f.deps.apply = async () => { throw new Error('database failed'); };
    await assert.rejects(f.run(), /database failed/);
    f.deps.apply = async () => { f.dispose(); };
    await assert.rejects(f.run(), /no longer belong/);
  });
  it('does not queue behind a held provider send when the idle lock refuses it', async () => {
    const f = fixture(); f.deps.withChangeLock = async () => { throw new Error('busy'); };
    await assert.rejects(f.run(), /busy/); assert.equal(f.calls(), 0);
  });
});
