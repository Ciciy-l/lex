import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { withSessionPermissionChange } from '../sessionPermissionChange.js';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_CONTEXT_WINDOW_BUDGET,');
const end = source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.GET_CONTEXT_WINDOW_BOUNDS,');
if (start < 0 || end <= start) throw new Error('context-budget IPC source boundaries changed');
const handlerSource = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

interface OwnerProfile {
  scope: string;
  budgets: Map<string, number | null>;
  db: {
    client: {
      drizzle: {
        select: () => {
          from: () => {
            where: () => { limit: () => Promise<unknown[]> };
          };
        };
      };
    };
  };
}

function fixture(options: { boundary?: boolean; live?: boolean } = {}) {
  let current = 'owner-a:1';
  let boundary = options.boundary ?? false;
  const pending: Array<(rows: unknown[]) => void> = [];
  const profiles = new Map<string, OwnerProfile>();
  const makeProfile = (scope: string): OwnerProfile => ({
    scope,
    budgets: new Map(),
    db: {
      client: {
        drizzle: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => new Promise<unknown[]>((resolve) => pending.push(resolve)),
              }),
            }),
          }),
        },
      },
    },
  });
  profiles.set('owner-a:1', makeProfile('owner-a:1'));
  profiles.set('owner-b:2', makeProfile('owner-b:2'));
  const writes: Array<{ scope: string; budget: number | null }> = [];
  const runtime = vi.fn(async () => {});
  const live = options.live ? { model: 'model-a' } : null;
  let handler!: (event: unknown, sessionId: unknown, budget: unknown) => Promise<unknown>;

  const deps = {
    ipcMain: { handle: (_name: string, fn: typeof handler) => { handler = fn; } },
    MAKER_INVOKE: { SET_CONTEXT_WINDOW_BUDGET: 'set-budget' },
    MIN_CONTEXT_WINDOW_BUDGET: 1_000,
    MAX_CONTEXT_WINDOW_BUDGET: 100_000_000,
    isDeviceLinkInvoke: () => true,
    assertTrustedAppRendererEvent: () => {},
    throwIpcError: (code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    },
    getCurrentDbClientSnapshot: () => profiles.get(current)!.db,
    activeOwnerScopeKey: () => current,
    isAppSessionBoundaryPending: () => boundary,
    withSessionPermissionChange,
    assertReviewSettingsUnlocked: async () => {},
    sessions: { agentKind: 'agent', model: 'model', providerId: 'provider' },
    eq: () => true,
    dbToMakerAgentKind: () => 'codex',
    maker: { getSession: () => live },
    getSessionProvider: () => null,
    readSessionContextWindowBudget: (sessionId: string) => profiles.get(current)!.budgets.get(sessionId) ?? null,
    contextWindowBudgetChangesEffectiveWindow: () => true,
    getActiveCatalog: () => ({ providers: [] }),
    writeSessionContextWindowBudget: (sessionId: string, budget: number | null) => {
      profiles.get(current)!.budgets.set(sessionId, budget);
      writes.push({ scope: current, budget });
      return budget;
    },
    applyRuntimeSetModelChange: runtime,
    isSessionInTurn: () => false,
    registerPendingCredentialSwitchForSession: () => {},
    clearPendingCredentialSwitchForSession: () => {},
    getPendingCredentialSwitchTarget: () => null,
    wakeSessionInputAfterCredentialSwitch: () => {},
    getCodexProxyAuthInjectionState: () => null,
    log: { warn: vi.fn() },
  };
  new Function(...Object.keys(deps), handlerSource)(...Object.values(deps));

  return {
    call: (budget: number, sessionId = 'task') => handler({}, sessionId, budget),
    pending,
    profiles,
    writes,
    runtime,
    switchOwner(next: string) { current = next; },
    setBoundary(next: boolean) { boundary = next; },
  };
}

const row = [{ agentKind: 'codex', model: 'model', providerId: 'provider' }];

describe('context budget owner boundary', () => {
  it('drops a delayed write after the database snapshot changes owner', async () => {
    const h = fixture();
    const operation = h.call(64_000);
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.switchOwner('owner-b:2');
    h.pending.shift()!(row);
    await expect(operation).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.profiles.get('owner-b:2')!.budgets.size).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it('fails closed while an owner boundary is pending', async () => {
    const h = fixture({ boundary: true });
    await expect(h.call(64_000)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.pending).toHaveLength(0);
    expect(h.writes).toEqual([]);
  });

  it('serializes concurrent setters for the same task', async () => {
    const h = fixture();
    const first = h.call(64_000, 'serialized-task');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    const second = h.call(128_000, 'serialized-task');
    await Promise.resolve();
    expect(h.pending).toHaveLength(1);

    h.pending.shift()!(row);
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.pending.shift()!(row);
    await expect(second).resolves.toBe(true);
    expect(h.writes.map(({ budget }) => budget)).toEqual([64_000, 128_000]);
  });

  it('never rolls a failed runtime update into the next owner', async () => {
    const h = fixture({ live: true });
    let rejectRuntime!: (error: Error) => void;
    h.runtime.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRuntime = reject; }));
    const operation = h.call(64_000, 'rollback-task');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.pending.shift()!(row);
    await vi.waitFor(() => expect(h.runtime).toHaveBeenCalledOnce());
    h.switchOwner('owner-b:2');
    rejectRuntime(new Error('runtime failed'));
    await expect(operation).rejects.toThrow('runtime failed');
    expect(h.profiles.get('owner-b:2')!.budgets.size).toBe(0);
    expect(h.writes).toEqual([{ scope: 'owner-a:1', budget: 64_000 }]);
  });
});
