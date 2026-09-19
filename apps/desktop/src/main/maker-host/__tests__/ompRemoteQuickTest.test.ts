import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentSessionHandle, EphemeralSession, InteractionResolver } from '@cindy/maker-core';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import {
  runManagedRemoteOmpQuickTest,
  selectManagedRemoteOmpQuickTestRoute,
  type ManagedRemoteOmpQuickTestDeps,
} from '../omp-remote-quick-test.js';

function ompModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'model-a',
    name: 'Model A',
    contextWindow: 128_000,
    efforts: [],
    defaultEffort: null,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'provider-a',
    name: 'Provider A',
    source: 'builtin',
    connected: true,
    agents: ['omp'],
    routing: { omp: {} },
    models: { omp: [ompModel()] },
    ...overrides,
  } as ProviderView;
}

function sessionWithEvents(events: readonly AgentEvent[]) {
  let resolver: InteractionResolver | undefined;
  const close = vi.fn(async () => undefined);
  const handle = {
    id: 'native-omp-session',
    agentKind: 'omp',
    model: 'model-a',
    send: vi.fn(async () => undefined),
    steer: async () => undefined,
    abort: async () => undefined,
    close,
    events: async function* () {
      yield* events;
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: (next: InteractionResolver) => { resolver = next; },
  } as unknown as AgentSessionHandle;
  const session: EphemeralSession = Object.freeze({
    sessionId: 'quick-session',
    sessionInstanceId: 'quick-instance',
    handle,
    close,
  });
  return { handle, session, close, getResolver: () => resolver };
}

function depsFor(
  session: EphemeralSession,
  providers: ProviderView[] = [provider()],
): ManagedRemoteOmpQuickTestDeps & {
  setSessionProvider: ReturnType<typeof vi.fn>;
  clearSessionProvider: ReturnType<typeof vi.fn>;
  startEphemeralSession: ReturnType<typeof vi.fn>;
} {
  return {
    ensureProviderReady: vi.fn(async () => true),
    listProviders: vi.fn(async () => providers),
    generateSessionId: vi.fn(() => 'quick-session'),
    setSessionProvider: vi.fn(),
    clearSessionProvider: vi.fn(),
    startEphemeralSession: vi.fn(async () => session),
    now: vi.fn(() => 100),
  };
}

describe('managed SSH OMP quick test', () => {
  it('uses a session-bound managed OMP runtime, denies interactions, and cleans up', async () => {
    const fixture = sessionWithEvents([
      { type: 'text', data: { text: 'hello ' }, source: 'omp' },
      { type: 'text', data: { text: 'from OMP' }, source: 'omp' },
      { type: 'done', data: {}, source: 'omp' },
    ]);
    const deps = depsFor(fixture.session);

    const result = await runManagedRemoteOmpQuickTest(deps, {
      hostId: 'ssh-a',
      prompt: 'Say hello',
    });

    expect(deps.setSessionProvider).toHaveBeenCalledWith('quick-session', 'provider-a');
    expect(deps.startEphemeralSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'omp',
      sessionId: 'quick-session',
      remoteHostId: 'ssh-a',
      workingDir: '/__lex_omp_isolated_probe__',
      model: 'model-a',
      providerId: 'provider-a',
      permissionMode: 'ask',
      disableHostTools: true,
      isolatedProbe: true,
    }));
    expect(fixture.handle.send).toHaveBeenCalledWith({ type: 'user', content: 'Say hello' });
    await expect(fixture.getResolver()?.({
      kind: 'permission', requestId: 'permission-1', toolName: 'write', input: {},
    }) ?? Promise.reject(new Error('resolver missing'))).resolves.toEqual({
      kind: 'permission', behavior: 'deny', reason: 'remote_quick_test',
    });
    expect(result).toEqual({
      stdout: 'hello from OMP', stderr: '', exitCode: 0, signal: null, durationMs: 0,
    });
    expect(fixture.close).toHaveBeenCalledWith({ reason: 'navigation' });
    expect(deps.clearSessionProvider).toHaveBeenCalledWith('quick-session');
  });

  it('closes and clears the temporary provider mapping after a terminal agent error', async () => {
    const fixture = sessionWithEvents([
      { type: 'error', data: { message: 'redacted', isTerminal: true }, source: 'omp' },
    ]);
    const deps = depsFor(fixture.session);

    await expect(runManagedRemoteOmpQuickTest(deps, {
      hostId: 'ssh-a', prompt: 'Say hello',
    })).rejects.toThrow('OMP remote quick test ended with an agent error');

    expect(fixture.close).toHaveBeenCalledWith({ reason: 'navigation' });
    expect(deps.clearSessionProvider).toHaveBeenCalledWith('quick-session');
  });

  it('selects only connected, non-suspended providers with a selectable OMP model', () => {
    expect(selectManagedRemoteOmpQuickTestRoute([
      provider({ connected: false }),
      provider({ id: 'suspended', suspended: true }),
      provider({ id: 'non-chat', models: { omp: [ompModel({ id: 'image', mode: 'image_generation' })] } }),
      provider({ id: 'usable', models: { omp: [ompModel({ id: 'model-z' })] } }),
    ])).toEqual({ providerId: 'usable', model: 'model-z' });
  });
});
