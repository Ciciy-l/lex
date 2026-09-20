import { describe, expect, it, vi } from 'vitest';

import { Maker } from './maker.js';
import { AgentStartupCleanupPendingError, type AgentSessionHandle, type BaseAgent } from './agents/base-agent.js';
import type { Logger } from './interfaces/logger.js';
import type { SessionMeta, SessionStorage } from './interfaces/session-storage.js';

function createStorage(): SessionStorage & { create: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(async (meta) => ({ ...meta, createdAt: 1, updatedAt: 1 })),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    update: vi.fn(async (_id, patch) => ({ id: 'unexpected', ...patch, createdAt: 1, updatedAt: 1 } as SessionMeta)),
    compareAndClearSdkSessionId: vi.fn(async () => false),
    delete: vi.fn(async () => undefined),
  };
}

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function createHandle(close = vi.fn(async () => undefined)): AgentSessionHandle {
  return {
    id: 'native-omp-session',
    agentKind: 'omp',
    model: 'model-a',
    send: async () => undefined,
    steer: async () => undefined,
    abort: async () => undefined,
    close,
    events: async function* () {},
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: () => undefined,
  };
}

function createAgent(startSession: BaseAgent['startSession']): BaseAgent {
  return {
    kind: 'omp',
    capabilities: {} as BaseAgent['capabilities'],
    startSession,
    dispose: vi.fn(async () => undefined),
    filterActiveSkillCommands: (result: never) => result,
  } as unknown as BaseAgent;
}

describe('Maker.startEphemeralSession', () => {
  it('starts a managed runtime without a task row, lifecycle hooks, or active Session', async () => {
    const storage = createStorage();
    const handle = createHandle();
    const startSession = vi.fn(async () => handle);
    const onBeforeStart = vi.fn();
    const onStartSucceeded = vi.fn();
    const maker = new Maker({
      agents: { omp: createAgent(startSession) },
      storage,
      logger: createLogger(),
      lifecycleHooks: { onBeforeStart, onStartSucceeded },
    });

    const runtime = await maker.startEphemeralSession({
      agentKind: 'omp',
      sessionId: 'quick-test-session',
      remoteHostId: 'host-a',
      workingDir: '/home/lex',
      model: 'model-a',
      providerId: 'provider-a',
      disableHostTools: true,
    });

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'quick-test-session',
      sessionInstanceId: expect.any(String),
      remoteHostId: 'host-a',
      disableHostTools: true,
    }));
    expect(storage.create).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
    expect(onBeforeStart).not.toHaveBeenCalled();
    expect(onStartSucceeded).not.toHaveBeenCalled();
    expect(maker.listActiveSessions()).toEqual([]);

    await runtime.close({ reason: 'navigation' });
    await runtime.close({ reason: 'navigation' });
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledWith({ reason: 'navigation' });
  });

  it('closes an in-flight ephemeral handle when shutdown wins its startup race', async () => {
    let resolveStart!: (handle: AgentSessionHandle) => void;
    const startingHandle = new Promise<AgentSessionHandle>((resolve) => { resolveStart = resolve; });
    const close = vi.fn(async () => undefined);
    const handle = createHandle(close);
    const startSession = vi.fn(async () => startingHandle);
    const maker = new Maker({
      agents: { omp: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });

    const starting = maker.startEphemeralSession({
      agentKind: 'omp',
      sessionId: 'quick-test-race',
      workingDir: '/home/lex',
      model: 'model-a',
    });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledOnce());
    const shutdown = maker.shutdown({ reason: 'app-quit' });
    resolveStart(handle);

    await expect(starting).rejects.toThrow('Maker is shutting down');
    await shutdown;
    expect(close).toHaveBeenCalledWith({ reason: 'app-quit' });
    expect(maker.listActiveSessions()).toEqual([]);
  });

  it('observes deferred adapter cleanup instead of leaking an unhandled rejection', async () => {
    let rejectStopped!: (reason: unknown) => void;
    const whenStopped = new Promise<void>((_resolve, reject) => { rejectStopped = reject; });
    const pending = new AgentStartupCleanupPendingError('cleanup pending', {
      cause: new Error('adapter failed'),
      whenStopped,
    });
    const logger = createLogger();
    const maker = new Maker({
      agents: { omp: createAgent(async () => { throw pending; }) },
      storage: createStorage(),
      logger,
    });

    await expect(maker.startEphemeralSession({
      agentKind: 'omp',
      workingDir: '/home/lex',
      model: 'model-a',
    })).rejects.toBe(pending);
    rejectStopped(new Error('transport did not stop'));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      'ephemeral adapter startup cleanup remains unconfirmed',
      expect.objectContaining({ agentKind: 'omp' }),
    ));
  });
});
