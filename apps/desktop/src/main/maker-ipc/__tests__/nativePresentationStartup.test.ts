import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import { Session, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { createSessionBindingLifecycle } from '../sessionBindingLifecycle.js';
import { persistAndHydrateSessionProvider } from '../sessionProviderBootstrap.js';
import { hasLocalNativePresentation } from '../../../shared/agentPresentation.js';
import {
  clearAllSessionProviders, freezeSessionProviderAtStart, getSessionProvider, hydrateSessionProvider,
} from '../../maker-host/session-provider-store.js';
import {
  clearAllSessionRuntimeAxes, getSessionEffort, getSessionFastMode, setSessionEffort, setSessionFastMode,
} from '../../maker-host/session-effort-store.js';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(/\r\n?/g, '\n');
const sessionsToClose: Session[] = [];
const noop = () => {};
const nativeThreadId = '0199ae4e-d6b0-7755-a755-66754cd7a847';

/** Execute the production adapters without importing register's Electron singletons. */
function productionFunction<T>(name: string, code: string, dependencies: Record<string, unknown>): T {
  const js = transpileModule(code.replace(/^export /, ''), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), js + '; return ' + name + ';')(...Object.values(dependencies));
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(sessionsToClose.splice(0).map(session => session.close()));
  clearAllSessionProviders();
  clearAllSessionRuntimeAxes();
});

function fixture(engine: 'codex' | 'pi' = 'codex') {
  const providerRead = deferred<void>(), axesRead = deferred<void>(), providerEntered = deferred<void>(), axesEntered = deferred<void>();
  const ended = deferred<void>();
  let generation = 1, accountDb = {}, currentSession: Session | undefined, running = false;
  const nativeInputs: Array<{ threadId: string; provider: string | null; effort: string | null; fastMode: boolean; model: string; cwd: string; permission: string | null }> = [];
  const logger = { trace: noop, debug: noop, info: noop, warn: vi.fn(), error: noop, fatal: noop, child: () => logger };
  let nativeResolver: Parameters<NonNullable<AgentSessionHandle['setNativeInputResolver']>>[0];
  const activate = vi.fn<NonNullable<AgentSessionHandle['activatePresentation']>>(async owner => {
    expect(owner.isCurrent()).toBe(true);
    await nativeResolver({
      nativeSessionId: nativeThreadId, nativeMessageId: 'first-native-input',
      signal: owner.signal, message: { type: 'user', content: 'TUI first input' },
      accept: async () => {
        nativeInputs.push({ threadId: nativeThreadId, provider: getSessionProvider(session.id),
          effort: getSessionEffort(session.id), fastMode: getSessionFastMode(session.id),
          model: session.model, cwd: session.workDir, permission: session.permissionModeState.mode });
        running = true;
      },
    });
    return { status: 'ready' };
  });
  const handle: AgentSessionHandle = {
    id: nativeThreadId, agentKind: engine, model: 'gpt-5.4',
    send: vi.fn(async () => { running = true; }),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => { running = false; }),
    close: vi.fn(async () => { ended.resolve(); }),
    async *events(): AsyncGenerator<AgentEvent> { await ended.promise; },
    isTurnRunning: () => running, setInteractionResolver: vi.fn(),
    setNativeInputResolver: resolver => { nativeResolver = resolver; },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    activatePresentation: activate,
  };
  const session = new Session({ id: 'native-startup-task', agentKind: engine, workDir: '/selected/work', handle,
    capabilities: {} as never, logger, permissionMode: 'ask', turnStallMs: 0 });
  sessionsToClose.push(session);
  currentSession = session;
  const bindings = createSessionBindingLifecycle<Session, null>({
    log: logger, restoreInteractionListener: s => s.setInteractionListener(vi.fn()),
    beforeReplace: noop, onBind: noop, broadcastStatus: noop, captureCloseContext: () => null,
    cleanupClosedSession: noop, beforeCloseTeardown: noop, finalizeClosedSession: noop,
  });
  const wireStart = source.indexOf('export function wireSessionToIpc(');
  const wireEnd = source.indexOf('\n/**', source.indexOf('session.activatePresentation(', wireStart));
  expect(wireStart).toBeGreaterThan(-1);
  expect(wireEnd).toBeGreaterThan(wireStart);
  const wire = productionFunction<(session: Session, startup?: Session['presentationInitialization']) => void>(
    'wireSessionToIpc', source.slice(wireStart, wireEnd), {
      sessionBindings: bindings, installSessionTurnObserver: () => noop, sessionTurnObserverDependencies: {},
      noteSessionAgentKind: noop, makerToDbAgentKind: (kind: string) => kind,
      createGhostSessionTap: () => ({ dispose: noop, handleEvent: noop, interactionObserver: { onStart: noop, onEnd: noop } }),
      installInteractionLifecycleObserver: noop, clearPendingTurnChangeSets: noop,
      isFencedStaleSessionTerminal: () => false, noteTurnDiffEvent: noop, handleSessionEvent: noop,
      getCurrentDbClientSnapshot: () => accountDb, getActiveAppSession: () => ({ generation }),
      isAppSessionBoundaryPending: () => false,
      nativeInputBindingDepsHolder: {}, nativeStopBindingDepsHolder: {}, nativeRuntimeBindingDepsHolder: {},
      bindNativeSessionInput: (s: Session) => s.onNativeInput(async input => { await s.acceptNativeInput(input); }),
      bindNativeSessionStop: () => noop, bindNativeSessionRuntime: () => noop,
      sessionEventDependencies: {}, installDesktopInteractionListener: (s: Session) => s.setInteractionListener(vi.fn()),
    },
  );
  let storedProvider: string | null = 'previous-provider';
  const db = {
    update: () => ({ set: (patch: { providerId?: string | null }) => ({ where: async () => {
      if (patch.providerId !== undefined) storedProvider = patch.providerId;
    } }) }),
    select: (fields: Record<string, unknown>) => ({ from: () => ({ where: () => ({ limit: async () => {
      if ('providerId' in fields) { providerEntered.resolve(); await providerRead.promise; return [{ providerId: storedProvider }]; }
      axesEntered.resolve(); await axesRead.promise; return [{ effort: 'high', fastMode: true }];
    } }) }) }),
  };
  const create = vi.fn(async (opts: { providerId?: string | null }) => {
    freezeSessionProviderAtStart(session.id, opts.providerId);
    return session;
  });
  const bootstrapStart = source.indexOf('  async function bootstrapSession(');
  const bootstrapEnd = source.indexOf('\n  // switchFocus', bootstrapStart);
  expect(bootstrapStart).toBeGreaterThan(-1);
  expect(bootstrapEnd).toBeGreaterThan(bootstrapStart);
  const bootstrap = productionFunction<(opts: Record<string, unknown>) => Promise<{ session: Session }>>(
    'bootstrapSession', source.slice(bootstrapStart, bootstrapEnd), {
      getCurrentDbClientSnapshot: () => accountDb, getActiveAppSession: () => ({ generation }),
      isAppSessionBoundaryPending: () => false,
      maker: { createSession: create, getSession: () => currentSession },
      options: { waitForAccountProviderModelsReady: async () => {} },
      workingDirectoryRecovery: { resolve: (_id: string, directory: string) => directory, observe: async () => {}, isFallback: () => false },
      getSessionRuntimeControlSnapshot: () => ({ effectiveOverride: null }),
      applyPersistedReviewMode: async () => {}, applyOrcaInstructions: () => false, applyProjectContextInjection: async () => false,
      prepareDirectoryGrantsForBootstrap: async () => {}, readSessionWritableDirsFromDb: async () => [],
      hydrateProviderIdBeforeSessionStart: async () => {}, ensureManagedOllamaReadyForSession: async () => {},
      app: { getPath: () => '/isolated/test' }, assertModelRouteUsable: async () => undefined,
      shouldApplyExclusiveProviderRerouteLive: () => false, markProjectContextIfNeeded: async () => {},
      hasLocalNativePresentation,
      wireSessionToIpc: wire, markOrcaMcpHydratedIfNeeded: noop,
      getDbClient: () => ({ drizzle: db }),
      sessions: { id: 'id', providerId: 'providerId', effort: 'effort', fastMode: 'fastMode' }, eq: () => true,
      persistAndHydrateSessionProvider, hydrateSessionProvider, setSessionEffort, setSessionFastMode, getSessionProvider,
      getActiveCatalog: () => ({ providers: [] }), findCatalogModel: () => undefined,
      worktreeStore: { get: () => undefined }, log: logger,
    },
  );
  return { session, handle, activate, nativeInputs, providerRead, axesRead, providerEntered, axesEntered, create, logger,
    start: (resume = false, native = engine === 'pi') => bootstrap({ id: session.id, agentKind: engine, workingDir: session.workDir, model: session.model,
      providerId: 'selected-provider', permissionMode: 'ask', ...(native ? { requireNativePresentation: true } : {}), ...(resume ? { resumeSessionId: nativeThreadId } : {}) }),
    changeAccount: () => { generation++; accountDb = {}; },
    replaceSession: () => { currentSession = undefined; },
    wireDirect: () => wire(session),
  };
}

describe('native activation at the actual Main startup boundary', () => {
  it.each([false, true])('selects Pi native preparation for new and legacy ordinary tasks (resume=%s)', async resume => {
    const f = fixture('pi'); f.providerRead.resolve(); f.axesRead.resolve();
    expect((await f.start(resume)).session).toBe(f.session);
    expect(await f.session.presentationInitialization).toEqual({ status: 'ready' });
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'pi', nativePresentation: true,
      ...(resume ? { resumeSessionId: nativeThreadId } : {}) }), undefined);
    expect(f.nativeInputs).toHaveLength(1); expect(f.nativeInputs[0]!.threadId).toBe(nativeThreadId);
    expect(f.handle.send).not.toHaveBeenCalled();
  });
  it('keeps ordinary Pi GUI startup on its existing adapter until native presentation is explicitly requested', async () => {
    const f = fixture('pi'); f.providerRead.resolve(); f.axesRead.resolve(); await f.start(false, false);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'pi', nativePresentation: false }), undefined);
  });
  it.each([false, true])('holds first native input through provider and effort/fast hydration (resume=%s)', async resume => {
    const f = fixture();
    const startup = f.start(resume);
    await f.providerEntered.promise;
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.nativeInputs).toEqual([]);
    f.providerRead.resolve();
    await f.axesEntered.promise;
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.nativeInputs).toEqual([]);
    f.axesRead.resolve();
    expect((await startup).session).toBe(f.session);
    expect(await f.session.presentationInitialization).toEqual({ status: 'ready' });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ nativePresentation: true }), undefined);
    expect(f.nativeInputs).toEqual([{ threadId: nativeThreadId, provider: 'selected-provider', effort: 'high', fastMode: true,
      model: 'gpt-5.4', cwd: '/selected/work', permission: 'ask' }]);
    expect(f.handle.send).not.toHaveBeenCalled();
  });

  it('keeps the original GUI task available after a non-fatal hydration failure, without releasing TUI input', async () => {
    const f = fixture(), startup = f.start();
    await f.providerEntered.promise;
    f.providerRead.reject(new Error('isolated provider read failure'));
    expect((await startup).session).toBe(f.session);
    expect(await f.session.presentationInitialization).toEqual({ status: 'unavailable', reason: 'startup-failed' });
    expect(f.activate).not.toHaveBeenCalled(); expect(f.nativeInputs).toEqual([]);
    expect(f.handle.close).not.toHaveBeenCalled();
    expect(await f.session.send('GUI remains available')).toEqual({ accepted: true });
    expect(f.handle.send).toHaveBeenCalledOnce();
  });

  it.each(['close', 'account', 'replacement'] as const)('does not release first input after %s while initialization is pending', async boundary => {
    const f = fixture(), startup = f.start();
    await f.providerEntered.promise;
    if (boundary === 'close') await f.session.close();
    else if (boundary === 'account') f.changeAccount();
    else f.replaceSession();
    f.providerRead.resolve(); f.axesRead.resolve();
    await startup;
    expect(await f.session.presentationInitialization).toEqual({ status: 'unavailable', reason: 'owner-changed' });
    expect(f.activate).not.toHaveBeenCalled(); expect(f.nativeInputs).toEqual([]);
    expect(f.handle.close).toHaveBeenCalledTimes(boundary === 'close' ? 1 : 0);
  });

  it('retains direct creator activation when its selected runtime is already frozen before Main wiring', async () => {
    const f = fixture();
    freezeSessionProviderAtStart(f.session.id, 'direct-provider');
    setSessionEffort(f.session.id, 'low'); setSessionFastMode(f.session.id, false);
    f.wireDirect();
    expect(await f.session.presentationInitialization).toEqual({ status: 'ready' });
    expect(f.nativeInputs).toEqual([{ threadId: nativeThreadId, provider: 'direct-provider', effort: 'low', fastMode: false,
      model: 'gpt-5.4', cwd: '/selected/work', permission: 'ask' }]);
    expect(f.create).not.toHaveBeenCalled(); expect(f.handle.send).not.toHaveBeenCalled();
  });
});
