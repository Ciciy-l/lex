import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostSessionClearService } from '../hostSessionClearService.js';
import {
  __resetOrcaContextOperationFenceForTest,
  activeOrcaContextOperation,
  beginOrcaContextOperation,
  releaseOrcaContextOperation,
} from '../orcaContextOperationFence.js';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.Latest, true);
let prepareText = '';
let timeoutText = '';
let timeoutErrorText = '';
const visit = (node: ts.Node): void => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'prepareOrcaWorkerContext') {
    prepareText = node.getText(ast);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'withContextTimeout') {
    timeoutText = node.getText(ast);
  }
  ts.forEachChild(node, visit);
};
visit(ast);

function compilePrepare(deps: Record<string, unknown>) {
  const code = ts.transpileModule(
    `${timeoutText}\n${prepareText}\nreturn prepareOrcaWorkerContext;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return new Function(...Object.keys(deps), code)(...Object.values(deps)) as (
    params: { worker: { sessionId: string }; link: object; policy: 'clear' | 'compact' },
    assertCurrent?: () => Promise<void>,
  ) => Promise<Record<string, unknown>>;
}

function createCompactHarness(options: {
  compact?: () => Promise<{ noop?: boolean }>;
  graceMs?: number;
  timeoutMs?: number;
} = {}) {
  let current: Record<string, unknown> | undefined;
  const listeners = new Set<(event: { type: string; data?: { trigger?: string } }) => void>();
  const live = {
    remoteHostId: null,
    agentKind: 'pi',
    presentation: null,
    capabilities: { manualCompact: { supported: true } },
    isTurnRunning: () => false,
    onEvent: (listener: (event: { type: string; data?: { trigger?: string } }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatusChange: () => () => undefined,
    compactSession: options.compact ?? (async () => ({ noop: true })),
  };
  current = live;
  const prepare = compilePrepare({
    maker: {
      getSession: () => current,
      closeSession: async () => {
        current = undefined;
      },
    },
    hasOrcaWorkerPendingInput: async () => false,
    withContextTimeout: (promise: Promise<unknown>) => promise,
    ORCA_CONTEXT_COMPACT_TIMEOUT_MS: options.timeoutMs ?? 600_000,
    ORCA_CONTEXT_COMPACT_BOUNDARY_GRACE_MS: options.graceMs ?? 10,
    delay: (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
    ContextOperationTimeoutError: class extends Error {},
    hostSessionClearHolder: { clearSession: async () => undefined },
    hostInputClearInFlightSessions: new Set<string>(),
    withRehydrateCloseSuppressed: async (_id: string, fn: () => Promise<void>) => fn(),
    cleanupPendingInteractionsForSession: () => undefined,
  });
  return {
    prepare,
    emit: (event: { type: string; data?: { trigger?: string } }) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('prepareOrcaWorkerContext', () => {
  afterEach(() => {
    __resetOrcaContextOperationFenceForTest();
  });

  it('refuses a competing operation without replacing the existing fence', async () => {
    const first = beginOrcaContextOperation('s', 'clear');
    expect(() => beginOrcaContextOperation('s', 'compact')).toThrow(/already active/);
    expect(activeOrcaContextOperation('s')?.token).toBe(first);
    releaseOrcaContextOperation(first);
  });

  it('returns BUSY instead of throwing when a second prepare races the fence', async () => {
    const h = createCompactHarness({ compact: async () => ({ noop: true }) });
    const first = beginOrcaContextOperation('s', 'compact');
    try {
      await expect(
        h.prepare({ worker: { sessionId: 's' }, link: {}, policy: 'clear' }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'BUSY' });
      expect(activeOrcaContextOperation('s')?.token).toBe(first);
    } finally {
      releaseOrcaContextOperation(first);
    }
  });

  it('treats a real Pi nothing-to-compact result as a completed noop', async () => {
    const h = createCompactHarness({ compact: async () => ({ noop: true }) });
    const started = Date.now();
    const result = await h.prepare({ worker: { sessionId: 's' }, link: {}, policy: 'compact' });
    expect(result).toMatchObject({ ok: true, outcome: 'compacted', compactNoop: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    const token = (result as { operationToken?: symbol }).operationToken;
    releaseOrcaContextOperation(token);
  });

  it('does not accept an unrelated automatic compact boundary as manual completion', async () => {
    let finish!: (value: { noop?: boolean }) => void;
    const compact = () => new Promise<{ noop?: boolean }>((resolveCompact) => {
      finish = resolveCompact;
    });
    const h = createCompactHarness({ compact, graceMs: 20 });
    const pending = h.prepare({ worker: { sessionId: 's' }, link: {}, policy: 'compact' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    h.emit({ type: 'compact_boundary', data: { trigger: 'auto' } });
    finish({ noop: false });
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'FAILED' });
  });

  it('keeps the fence after clear close failure and reports applied clear', async () => {
    let current: Record<string, unknown> | undefined;
    const clear = createHostSessionClearService({
      beginRemoteInputClearGate: () => undefined,
      endRemoteInputClearGate: () => undefined,
      captureNativeHistoryClearDependencies: () => ({
        root: '/tmp/synthetic',
        sessionId: 's',
        assertCurrent: () => undefined,
        readState: async () => ({ nativeId: 'old', clearedAt: null }),
      } as never),
      readNativeHistoryForClear: () => null,
      withNativeHistoryClear: async () => {
        throw new Error('unexpected native');
      },
      clearSessionContextInDb: async () => undefined,
      clearInputProjection: () => ({ pendingQueue: [] } as never),
      discardWorkingDirectoryRecovery: () => undefined,
      resetAutomaticRecoveryForExplicitStop: () => undefined,
      invalidateAgentHandoff: () => undefined,
      sealAgentHandoffClearBoundary: () => undefined,
      notifyQueueEmptied: () => undefined,
      clearGoal: () => undefined,
      logError: () => undefined,
    });
    current = { agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false };
    const prepare = compilePrepare({
      maker: {
        getSession: () => current,
        closeSession: async () => {
          throw new Error('close failed');
        },
      },
      hasOrcaWorkerPendingInput: async () => false,
      hostSessionClearHolder: clear,
      hostInputClearInFlightSessions: new Set<string>(),
      withRehydrateCloseSuppressed: async (_id: string, fn: () => Promise<void>) => fn(),
      cleanupPendingInteractionsForSession: () => undefined,
      withContextTimeout: async (promise: Promise<unknown>) => promise,
      ORCA_CONTEXT_COMPACT_TIMEOUT_MS: 600_000,
      ORCA_CONTEXT_COMPACT_BOUNDARY_GRACE_MS: 10,
      delay: (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
      ContextOperationTimeoutError: class extends Error {},
    });
    const result = await prepare({ worker: { sessionId: 's' }, link: {}, policy: 'clear' });
    expect(result).toMatchObject({
      ok: false,
      applied: 'cleared',
      keepFence: true,
    });
    expect(activeOrcaContextOperation('s')).toBeDefined();
    releaseOrcaContextOperation((result as { operationToken?: symbol }).operationToken);
    expect(activeOrcaContextOperation('s')).toBeUndefined();
  });
});
