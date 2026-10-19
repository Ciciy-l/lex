import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const start = source.indexOf('  async function abortSessionFromProduct(');
const end = source.indexOf('  ipcMain.handle(MAKER_INVOKE.ABORT_SESSION', start);
const code = ts.transpileModule('let nativeStopBindingDepsHolder;' + source.slice(start, end)
  + ';return { abortSessionFromProduct, nativeStopBindingDepsHolder };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function held() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const events: string[] = [], controller = new AbortController();
  let generation = 1, db: object = {}, alive = true;
  const session = { id: 'task', getCurrentTurnId: () => 'turn', getTurnGeneration: () => generation,
    abort: vi.fn(async (_options?: unknown) => { events.push('abort'); }) };
  let current: typeof session | null = session;
  const deps = {
    getCurrentDbClientSnapshot: () => db,
    getStableSessionForTurnBoundary: () => current,
    markWorkerManualInterruptIfKnown: () => { events.push('manual'); },
    resetAutomaticRecoveryForExplicitStop: () => { events.push('recovery'); },
    pauseGoalBeforeExplicitStop: vi.fn(async () => { events.push('goal'); }),
    handleAgentIslandSessionStopped: () => { events.push('island'); },
    beginDirectAbortReconciliation: () => ({}),
    reconcileDirectAbortBoundary: () => { events.push('reconcile'); },
    cleanupPendingInteractionsForSession: () => { events.push('cleanup'); },
    throwIpcError: (_code: string, message: string) => { throw new Error(message); },
    log: { error: vi.fn() },
  };
  const product = new Function(...Object.keys(deps), code)(...Object.values(deps));
  const check = () => { if (!alive) throw new Error('owner changed'); };
  return { events, session, deps, controller, product,
    replace: () => { current = { ...session }; }, next: () => { generation++; }, account: () => { db = {}; }, retire: () => { alive = false; },
    run: () => product.nativeStopBindingDepsHolder.stop(session, { nativeTurnId: 'turn', signal: controller.signal }, check),
  };
}
describe('native Stop shares the GUI product lifecycle', () => {
  it('starts abort without waiting for Goal persistence, then reconciles and cleans the same task', async () => {
    const f = fixture(), goal = held();
    f.deps.pauseGoalBeforeExplicitStop.mockImplementation(async () => { f.events.push('goal'); await goal.promise; });
    let done = false; const stopped = f.run().then(() => { done = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(f.events).toEqual(['manual', 'recovery', 'goal', 'island', 'abort', 'reconcile', 'cleanup']);
    expect(done).toBe(false); expect(f.session.abort).toHaveBeenCalledWith({ expectedTurnId: 'turn', signal: f.controller.signal });
    goal.resolve(); await stopped;
  });
  it('does not acknowledge Goal persistence or vendor abort failure', async () => {
    for (const boundary of ['goal', 'abort']) {
      const f = fixture();
      if (boundary === 'goal') f.deps.pauseGoalBeforeExplicitStop.mockRejectedValueOnce(new Error('goal failed'));
      else f.session.abort.mockRejectedValueOnce(new Error('abort failed'));
      await expect(f.run()).rejects.toThrow(boundary + ' failed');
      expect(f.events.slice(-2)).toEqual(['reconcile', 'cleanup']);
    }
  });
  it('refuses a replaced owner before any product side effect', async () => {
    const f = fixture(); f.replace(); await expect(f.run()).rejects.toThrow('turn changed'); expect(f.events).toEqual([]);
  });
  it('does not clear another account, replacement Session or next turn when Stop finishes late', async () => {
    for (const boundary of ['account', 'replace', 'next'] as const) {
      const f = fixture(), gate = held();
      f.session.abort.mockImplementation(async () => { await gate.promise; });
      const stopped = f.run(); f[boundary](); gate.resolve(); await stopped;
      expect(f.events).toContain('reconcile'); expect(f.events).not.toContain('cleanup');
    }
  });
});
