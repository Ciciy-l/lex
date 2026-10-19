import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  nativeRuntimeBindingDepsHolder = {');
const end = source.indexOf('  registerSessionSetModelHandler(', start);
assert(start >= 0 && end > start);
const code = ts.transpileModule('let nativeRuntimeBindingDepsHolder;' + source.slice(start, end) + ';return nativeRuntimeBindingDepsHolder;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const events: Array<{ kind: string; args?: unknown[] }> = [];
  let current = true, locked = false, result: Record<string, unknown> = { deferred: false, superseded: false };
  let selectionError: Error | undefined;
  const profile = { agentKind: 'codex', model: 'original', providerId: 'chosen-provider', effort: 'high', fastMode: true };
  const deps = {
    assertReviewSettingsUnlocked: async () => { events.push({ kind: 'review-policy' }); },
    assertNotRetiredCompanionSession: async () => { events.push({ kind: 'task-policy' }); },
    withSessionPermissionChange: async (_id: string, run: () => unknown) => { events.push({ kind: 'permission-queue' }); return run(); },
    hasSendToSessionLock: () => locked,
    withSendToSessionLock: async (_id: string, run: () => unknown) => { events.push({ kind: 'send-lock' }); return run(); },
    throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
    readSessionRuntimeProfiles: async () => ({ effective: profile }),
    applySessionRuntimeSelection: async (...args: unknown[]) => {
      events.push({ kind: 'runtime', args }); if (selectionError) throw selectionError; return result;
    },
    runtimeSelectionRequiresModelWindowConfirmation: (value: Record<string, unknown>) => value.contextWindowConfirmationRequired !== undefined,
    handleSetPlanMode: async (...args: unknown[]) => { events.push({ kind: 'plan', args }); },
  };
  const binding = new Function(...Object.keys(deps), code)(...Object.values(deps));
  const session = { id: 'task', getPlanMode: () => false };
  const check = () => { if (!current) throw new Error('owner changed'); };
  return { events, deps, binding, profile, session, check, lock: () => { locked = true; }, retire: () => { current = false; },
    result: (value: typeof result) => { result = value; }, fail: () => { selectionError = new Error('write rejected'); },
    run: (patch: object) => binding.apply(session, { nativeSessionId: 'native', patch, signal: new AbortController().signal }, check) };
}
describe('native menus use Main task setting transactions', () => {
  it('retains the current provider and untouched axes while requesting an immediate confirmed change', async () => {
    const f = fixture(); await f.run({ model: 'selected', effort: 'low' });
    const args = f.events.find(e => e.kind === 'runtime')!.args!;
    assert.deepEqual(args.slice(0, 4), ['task', 'selected', 'chosen-provider', { effort: 'low', fastMode: true }]);
    assert.deepEqual(args[4], { source: 'user', sessionLockHeld: true, nativeImmediateSelection: true,
      assertSelectionCurrent: f.check, effectiveProfile: f.profile, routeExplicit: true, effortExplicit: true, fastExplicit: false });
  });
  it('uses the shared Plan handler within the already-held permission queue', async () => {
    const f = fixture(); await f.run({ planMode: true });
    assert.deepEqual(f.events, [{ kind: 'plan', args: ['task', true, { permissionLockHeld: true, assertCurrent: f.check }] }]);
  });
  it('does not acknowledge deferred, superseded or window-confirmation results, or proceed to Plan', async () => {
    for (const result of [{ deferred: true }, { superseded: true }, { contextWindowConfirmationRequired: 64000 }]) {
      const f = fixture(); f.result(result);
      await assert.rejects(f.run({ model: 'selected', planMode: true }), /not applied/);
      assert.equal(f.events.some(e => e.kind === 'plan'), false);
    }
  });
  it('rejects failed selection and stale ownership rather than showing success', async () => {
    const f = fixture(); f.fail(); await assert.rejects(f.run({ effort: 'low' }), /write rejected/);
    const g = fixture(); g.retire(); await assert.rejects(g.run({ model: 'selected' }), /owner changed/);
    assert.equal(g.events.length, 0);
  });
  it('holds permission ordering and refuses a contended send instead of deadlocking', async () => {
    const f = fixture(); let ran = false; f.lock();
    await assert.rejects(f.binding.withChangeLock('task', async () => { ran = true; }), /already in progress/);
    assert.equal(ran, false); assert.deepEqual(f.events, [{ kind: 'permission-queue' }]);
  });
});
