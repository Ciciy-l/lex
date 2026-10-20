import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexSettingsQueue } from './native-settings-queue.js';
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('native settings require an actual receipt', () => {
  it('cannot redirect queued writes to a replacement native thread', async () => {
    let owner = 'thread-a'; const gate = held<void>(), writes: unknown[] = [];
    const q = new CodexSettingsQueue(() => owner, async patch => { writes.push(patch); await gate.promise; }, () => {});
    const first = assert.rejects(q.confirmed(() => q.update({ model: 'first' })), /owner changed/);
    const second = assert.rejects(q.confirmed(() => q.update({ model: 'second' })), /owner changed/);
    await Promise.resolve(); owner = 'thread-b'; gate.resolve(); await Promise.all([first, second]);
    assert.deepEqual(writes, [{ model: 'first' }]);
  });
  it('does not dispatch cancelled native writes after an earlier GUI update', async () => {
    const gate = held<void>(), writes: unknown[] = [], controller = new AbortController();
    const q = new CodexSettingsQueue(() => true, async patch => { writes.push(patch); await gate.promise; }, () => {});
    const first = q.update({ model: 'gui' });
    const cancelled = assert.rejects(q.confirmed(() => q.update({ model: 'native' }), controller.signal), /owner changed/);
    controller.abort(); gate.resolve(); await first; await cancelled;
    assert.deepEqual(writes, [{ model: 'gui' }]); assert.equal(q.requiresConfirmation, false);
  });
  it('preserves GUI desired-state fallback but reports an unconfirmed native change', async () => {
    const errors: unknown[] = [];
    const q = new CodexSettingsQueue(() => true, async () => { throw new Error('fixture failure'); }, (_keys, error) => errors.push(error));
    await q.update({ model: 'gui' });
    await assert.rejects(q.confirmed(() => q.update({ model: 'native' })), /fixture failure/);
    assert.equal(errors.length, 2);
  });
  it('serializes writes and isolates strict native scope from a concurrent GUI caller', async () => {
    const writes: unknown[] = [], gate = held<void>();
    const q = new CodexSettingsQueue(() => true, async patch => {
      writes.push(patch);
      if (patch.model === 'held') await gate.promise;
      if (patch.model === 'fail') throw new Error('fixture failure');
    }, () => {});
    const first = q.update({ model: 'held' });
    const strict = assert.rejects(q.confirmed(() => q.update({ model: 'fail' })), /fixture failure/);
    const gui = q.update({ model: 'fail' });
    const final = q.confirmed(() => q.update({ model: 'final' }));
    await Promise.resolve(); assert.deepEqual(writes, [{ model: 'held' }]);
    gate.resolve(); await Promise.all([first, strict, gui, final]);
    assert.deepEqual(writes, [{ model: 'held' }, { model: 'fail' }, { model: 'fail' }, { model: 'final' }]);
  });
  it('rejects stale native ownership before dispatch and after an awaited receipt', async () => {
    let current = true; const gate = held<void>(); const writes: unknown[] = [];
    const q = new CodexSettingsQueue(() => current, async patch => { writes.push(patch); await gate.promise; }, () => {});
    const first = assert.rejects(q.confirmed(() => q.update({ model: 'first' })), /owner changed/);
    const second = assert.rejects(q.confirmed(() => q.update({ model: 'second' })), /owner changed/);
    await Promise.resolve(); current = false; gate.resolve();
    await Promise.all([first, second]); assert.deepEqual(writes, [{ model: 'first' }]);
  });
  it('freezes patches before a blocked prior write releases', async () => {
    const gate = held<void>(), writes: unknown[] = [];
    const q = new CodexSettingsQueue(() => true, async patch => { writes.push(patch); await gate.promise; }, () => {});
    const first = q.update({ model: 'first' });
    const patch = { model: 'second' }; const second = q.update(patch); patch.model = 'changed';
    gate.resolve(); await Promise.all([first, second]); assert.deepEqual(writes, [{ model: 'first' }, { model: 'second' }]);
  });
});
