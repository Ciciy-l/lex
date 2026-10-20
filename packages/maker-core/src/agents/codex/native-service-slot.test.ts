import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexNativeServiceSlot } from './native-service-slot.js';

function service(ready = true) {
  let resolve!: (endpoint: { url: string; token: string }) => void;
  const endpoint = new Promise<{ url: string; token: string }>(r => { resolve = r; });
  const listeners = new Set<(info: { reason: string }) => void>();
  let closed = 0, detached = 0;
  const transport = { endpoint, get closed() { return closed; }, get detached() { return detached; },
    async writeLine() {}, onLine() { return () => {}; },
    onClose(fn: (info: { reason: string }) => void) { listeners.add(fn); return () => { detached++; listeners.delete(fn); }; },
    async close() { closed++; }, exit() { for (const fn of [...listeners]) fn({ reason: 'fixture exit' }); },
    ready(token = 'invalid-fixture-token') { resolve({ url: 'ws://127.0.0.1:1', token }); },
  };
  if (ready) transport.ready();
  return transport;
}
describe('native frontend concrete service generation', () => {
  it('captures a read-only service snapshot without owning its lifetime', async () => {
    const slot = new CodexNativeServiceSlot(), s = service(); slot.bind(s);
    const a = (await slot.capture())!, b = (await slot.capture())!;
    assert.equal(a.isCurrent(), true); assert.equal(a.signal.aborted, false);
    assert.deepEqual(a.endpoint, b.endpoint); assert.ok(Object.isFrozen(a.endpoint));
    slot.clear(); assert.equal(a.isCurrent(), false); assert.equal(b.signal.aborted, true);
    assert.equal(s.closed, 0); assert.equal(s.detached, 1);
  });
  it('revokes old frontends on replacement and ignores old process exits', async () => {
    const slot = new CodexNativeServiceSlot(), old = service(), fresh = service();
    slot.bind(old); const a = (await slot.capture())!; slot.bind(fresh); const b = (await slot.capture())!;
    old.exit(); assert.equal(a.signal.aborted, true); assert.equal(b.isCurrent(), true);
    fresh.exit(); assert.equal(b.isCurrent(), false); assert.equal(b.signal.aborted, true);
    assert.equal(await slot.capture(), undefined); assert.equal(old.closed + fresh.closed, 0);
  });
  it('does not return a late endpoint after its service was replaced', async () => {
    const slot = new CodexNativeServiceSlot(), old = service(false), fresh = service();
    slot.bind(old); const pending = slot.capture(); const rejection = assert.rejects(pending, /retired/);
    slot.bind(fresh); await rejection; old.ready('stale');
    assert.notEqual((await slot.capture())!.endpoint.token, 'stale'); slot.clear();
  });
  it('settles waiting attachment when the native process closes before port discovery', async () => {
    const slot = new CodexNativeServiceSlot(), s = service(false); slot.bind(s);
    const pending = assert.rejects(slot.capture(), /retired/); s.exit(); await pending;
    assert.equal(s.closed, 0);
  });
  it('retires native capabilities when boot changes back to ordinary transport', async () => {
    const slot = new CodexNativeServiceSlot(), s = service(); slot.bind(s); const binding = (await slot.capture())!;
    const { endpoint: _endpoint, ...ordinary } = service(); slot.bind(ordinary);
    assert.equal(binding.signal.aborted, true); assert.equal(await slot.capture(), undefined);
  });
  it('releases subscriptions when onClose fires synchronously during binding', async () => {
    const slot = new CodexNativeServiceSlot(), s = service(); let stops = 0;
    slot.bind({ ...s, onClose(fn) { fn({ reason: 'already closed' }); return () => { stops++; }; } });
    assert.equal(await slot.capture(), undefined); assert.equal(stops, 1);
  });
});
