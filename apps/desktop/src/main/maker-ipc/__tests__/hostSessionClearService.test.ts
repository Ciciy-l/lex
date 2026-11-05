import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { AgentInputProjection } from '../../../shared/agentInputQueue.js';
import { commitSessionContextClear } from '../../localDb/sessionContextClear.js';
import * as schema from '../../localDb/schema.js';
import { createHostSessionClearService, type HostSessionClearDeps } from '../hostSessionClearService.js';

function projection(sessionId = 's1'): AgentInputProjection {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: { status: 'none' } as never,
    errorRetryText: null,
    credentialSwitchWait: null,
  } as AgentInputProjection;
}

function createDeps(overrides: Partial<HostSessionClearDeps> = {}) {
  const order: string[] = [];
  const nativeClear = {
    root: '/tmp/native-history',
    sessionId: 's1',
    assertCurrent: vi.fn(() => order.push('native-assert')),
    readState: vi.fn(async () => ({ nativeId: 'native-1', clearedAt: 100 })),
  };
  const deps: HostSessionClearDeps = {
    beginRemoteInputClearGate: vi.fn(() => order.push('gate-begin')),
    endRemoteInputClearGate: vi.fn(() => order.push('gate-end')),
    captureNativeHistoryClearDependencies: vi.fn(() => nativeClear as never),
    readNativeHistoryForClear: vi.fn(() => null),
    withNativeHistoryClear: vi.fn(async (_deps, _at, commit) => {
      order.push('native-clear');
      return commit({ expected: { nativeId: 'native-1', clearedAt: 100 }, at: 200 });
    }),
    clearSessionContextInDb: vi.fn(async () => {
      order.push('db');
    }),
    clearInputProjection: vi.fn(() => {
      order.push('projection');
      return projection();
    }),
    discardWorkingDirectoryRecovery: vi.fn(() => order.push('workdir-discard')),
    resetAutomaticRecoveryForExplicitStop: vi.fn(() => order.push('recovery-reset')),
    invalidateAgentHandoff: vi.fn(() => order.push('handoff-invalidate')),
    sealAgentHandoffClearBoundary: vi.fn(() => order.push('handoff-seal')),
    notifyQueueEmptied: vi.fn(() => order.push('queue-emptied')),
    clearGoal: vi.fn(() => order.push('goal-clear')),
    logError: vi.fn(),
    ...overrides,
  };
  return { deps, nativeClear, order, service: createHostSessionClearService(deps) };
}

describe('hostSessionClearService', () => {
  it('commits the ordinary clear in the /clear order and reports the boundary', async () => {
    const h = createDeps();
    const result = await h.service.clearSession('s1', { isRemoteInvoke: false, clearedAt: '2026-01-01T00:00:00.000Z' });
    expect(result).toMatchObject({ native: false });
    expect(result.projection.sessionId).toBe('s1');
    expect(h.order).toEqual([
      'gate-begin',
      'native-assert',
      'projection',
      'workdir-discard',
      'recovery-reset',
      'handoff-invalidate',
      'queue-emptied',
      'goal-clear',
      'db',
      'handoff-seal',
      'gate-end',
    ]);
  });

  it('propagates a strict persistence failure while still sealing the in-memory generation', async () => {
    const h = createDeps({
      clearSessionContextInDb: vi.fn(async () => {
        throw new Error('DB unavailable');
      }),
    });
    await expect(
      h.service.clearSession('s1', { isRemoteInvoke: false, strictPersistence: true }),
    ).rejects.toThrow('DB unavailable');
    // Strict failures must not publish a queue projection; accepted input is
    // preserved until the clear is proven durable.
    expect(h.deps.clearInputProjection).not.toHaveBeenCalled();
    expect(h.deps.sealAgentHandoffClearBoundary).toHaveBeenCalledOnce();
    expect(h.deps.endRemoteInputClearGate).toHaveBeenCalledOnce();
  });

  it('rejects a strict clear when the real SQLite update matches zero rows', async () => {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, sdk_session_id TEXT, codex_plan_json TEXT,
        cleared_at INTEGER, updated_at INTEGER, list_preview TEXT, list_preview_role TEXT
      );
      CREATE TABLE bot_session_links (session_id TEXT);
      CREATE TABLE bot_profiles (canonical_session_id TEXT);
      CREATE TABLE bot_delegations (child_session_id TEXT);
      INSERT INTO sessions(id, source, sdk_session_id, updated_at)
        VALUES('s1', 'desktop', 'old-native', 0);
      INSERT INTO bot_session_links VALUES('s1');
    `);
    const client = { drizzle: drizzle(raw, { schema }) };
    try {
      const h = createDeps({
        clearSessionContextInDb: async (id, at, expected) => {
          await commitSessionContextClear(client as never, id, at, expected);
        },
      });
      await expect(
        h.service.clearSession('s1', { isRemoteInvoke: false, strictPersistence: true }),
      ).rejects.toBeDefined();
      expect(h.deps.clearInputProjection).not.toHaveBeenCalled();
      expect(raw.prepare('SELECT sdk_session_id, cleared_at FROM sessions WHERE id = ?').get('s1'))
        .toEqual({ sdk_session_id: 'old-native', cleared_at: null });
    } finally {
      raw.close();
    }
  });

  it('keeps the existing best-effort /clear semantics when strictness is not requested', async () => {
    const h = createDeps({
      clearSessionContextInDb: vi.fn(async () => {
        throw new Error('DB unavailable');
      }),
    });
    await expect(
      h.service.clearSession('s1', { isRemoteInvoke: false }),
    ).resolves.toMatchObject({ native: false });
    expect(h.deps.logError).toHaveBeenCalledWith(
      'clear session context persist failed',
      expect.objectContaining({ sessionId: 's1' }),
    );
  });

  it('uses the native clear transaction and reports its boundary', async () => {
    const h = createDeps();
    vi.mocked(h.deps.captureNativeHistoryClearDependencies).mockReturnValue({
      ...h.nativeClear,
      executor: { nativeId: 'native-1', agentKind: 'codex', workingDir: '/repo', close: vi.fn() },
    } as never);
    const onNative = vi.fn();
    const onCommitted = vi.fn();
    const result = await h.service.clearSession('s1', { isRemoteInvoke: false, onNative, onCommitted });
    expect(result).toMatchObject({ native: true, boundaryMs: 100 });
    expect(onNative).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith({ boundaryMs: 100, native: true });
    expect(h.order).toContain('native-clear');
    expect(h.deps.clearSessionContextInDb).toHaveBeenCalledWith(
      's1',
      200,
      { nativeId: 'native-1', clearedAt: 100 },
    );
  });

  it('orders strict projection after the durable commit', async () => {
    const h = createDeps();
    await h.service.clearSession('s1', { isRemoteInvoke: false, strictPersistence: true });
    const persistAt = h.order.indexOf('db');
    const projectionAt = h.order.indexOf('projection');
    expect(persistAt).toBeGreaterThan(-1);
    expect(projectionAt).toBeGreaterThan(persistAt);
  });

  it('reports a committed native clear when journal retirement fails afterward', async () => {
    const h = createDeps({
      withNativeHistoryClear: vi.fn(async (_deps, _at, commit) => {
        await commit({ expected: { nativeId: 'native-1', clearedAt: 100 }, at: 200 });
        throw new Error('tombstone failed');
      }),
    });
    vi.mocked(h.deps.captureNativeHistoryClearDependencies).mockReturnValue({
      ...h.nativeClear,
      executor: { nativeId: 'native-1', agentKind: 'codex', workingDir: '/repo', close: vi.fn() },
    } as never);
    await expect(h.service.clearSession('s1', { isRemoteInvoke: false, strictPersistence: true }))
      .rejects.toMatchObject({ applied: 'cleared' });
    expect(h.deps.clearInputProjection).not.toHaveBeenCalled();
    expect(h.deps.clearSessionContextInDb).toHaveBeenCalledOnce();
    expect(h.deps.sealAgentHandoffClearBoundary).toHaveBeenCalledOnce();
  });

  it('ends both gates when the native transaction fails', async () => {
    const h = createDeps({
      withNativeHistoryClear: vi.fn(async () => {
        throw new Error('native retirement failed');
      }),
    });
    vi.mocked(h.deps.captureNativeHistoryClearDependencies).mockReturnValue({
      ...h.nativeClear,
      executor: { nativeId: 'native-1', agentKind: 'codex', workingDir: '/repo', close: vi.fn() },
    } as never);
    await expect(h.service.clearSession('s1', { isRemoteInvoke: false })).rejects.toThrow(
      'native retirement failed',
    );
    expect(h.deps.sealAgentHandoffClearBoundary).toHaveBeenCalledOnce();
    expect(h.deps.endRemoteInputClearGate).toHaveBeenCalledOnce();
  });
});
