/**
 * Managed remote OMP connectivity check.
 *
 * This is intentionally not a shell one-shot: OMP needs its private runtime
 * HOME, managed models.yml, session-bound proxy credential and SSH provider
 * forward. The caller supplies the Main-owned dependencies so this module can
 * be tested without Electron, a real SSH host, or a provider credential.
 */

import {
  isTerminalAgentErrorEvent,
  type AgentEvent,
  type EphemeralSession,
  type StartEphemeralSessionOptions,
} from '@cindy/maker-core';
import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';

export interface RemoteOmpQuickTestResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: null;
  readonly durationMs: number;
}

export interface ManagedRemoteOmpQuickTestOptions {
  readonly hostId: string;
  readonly prompt: string;
  /** Test-only override; production uses the same two-minute budget as SSH one-shots. */
  readonly timeoutMs?: number;
}

export interface ManagedRemoteOmpQuickTestDeps {
  ensureProviderReady(): Promise<boolean>;
  listProviders(): Promise<ProviderView[]>;
  generateSessionId(): string;
  setSessionProvider(sessionId: string, providerId: string): void;
  clearSessionProvider(sessionId: string): void;
  startEphemeralSession(
    options: StartEphemeralSessionOptions,
  ): Promise<EphemeralSession>;
  now?(): number;
}

interface OmpQuickTestRoute {
  readonly providerId: string;
  readonly model: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
// OmpAgent replaces this before native startup with a newly created
// `<private-runtime-home>/workdir`. Keeping the placeholder internal avoids a
// Quick Test stat/read of the remote user's actual HOME or project path.
const ISOLATED_PROBE_WORKING_DIR = '/__lex_omp_isolated_probe__';

/** Pick the same connected/selectable provider rail exposed by the model picker. */
export function selectManagedRemoteOmpQuickTestRoute(
  providers: readonly ProviderView[],
): OmpQuickTestRoute | null {
  for (const provider of connectedProvidersForAgent([...providers], 'omp')) {
    const model = (provider.models.omp ?? []).find((candidate) =>
      isModelSelectableForNewRoute(candidate, { userProvider: provider.source === 'user' }),
    );
    if (model) return { providerId: provider.id, model: model.id };
  }
  return null;
}

function eventText(event: AgentEvent): string | undefined {
  if (event.type !== 'text' || !event.data || typeof event.data !== 'object') return undefined;
  const text = (event.data as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

async function collectQuickTestOutput(session: EphemeralSession): Promise<string> {
  let stdout = '';
  for await (const event of session.handle.events()) {
    const text = eventText(event);
    if (text !== undefined) stdout += text;
    if (event.type === 'done') return stdout;
    if (isTerminalAgentErrorEvent(event)) {
      // The adapter owns any vendor-specific redaction. Keep the IPC-facing
      // failure generic so a remote/provider diagnostic never turns into a
      // credentials or path disclosure in Settings.
      throw new Error('OMP remote quick test ended with an agent error');
    }
  }
  throw new Error('OMP remote quick test ended before the agent completed');
}

async function awaitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OMP remote quick test timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run exactly one prompt through OMP's normal managed SSH runtime, without a
 * durable task row or host-tool surface.
 */
export async function runManagedRemoteOmpQuickTest(
  deps: ManagedRemoteOmpQuickTestDeps,
  options: ManagedRemoteOmpQuickTestOptions,
): Promise<RemoteOmpQuickTestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('Invalid OMP remote quick test timeout');
  }
  if (!(await deps.ensureProviderReady())) {
    throw new Error('Cindy AI provider is not ready for an OMP remote quick test');
  }
  const route = selectManagedRemoteOmpQuickTestRoute(await deps.listProviders());
  if (!route) {
    throw new Error('No connected OMP model is available for the remote quick test');
  }

  const sessionId = deps.generateSessionId();
  const startedAt = (deps.now ?? Date.now)();
  let providerBound = false;
  let session: EphemeralSession | undefined;
  let events: Promise<string> | undefined;
  try {
    // OMP resolves the proxy credential/models.yml during start, so the source
    // route must exist before the temporary runtime is created.
    deps.setSessionProvider(sessionId, route.providerId);
    providerBound = true;
    session = await deps.startEphemeralSession({
      agentKind: 'omp',
      sessionId,
      remoteHostId: options.hostId,
      // This is only a syntactic StartSessionOptions value. `isolatedProbe`
      // makes OmpAgent derive and materialize the actual native cwd beneath
      // the fresh private runtime HOME before any discovery can run.
      workingDir: ISOLATED_PROBE_WORKING_DIR,
      model: route.model,
      providerId: route.providerId,
      permissionMode: 'ask',
      // Connectivity probes never expose MCP-backed host tools. Native tool
      // interactions are separately rejected below. The agent also derives a
      // fresh cwd beneath its private remote HOME and skips user/global Skill
      // projection, so this is not a read of the remote user's OMP project
      // configuration.
      disableHostTools: true,
      isolatedProbe: true,
    });
    session.handle.setInteractionResolver(async (request) => {
      if (request.kind === 'permission') {
        return { kind: 'permission', behavior: 'deny', reason: 'remote_quick_test' };
      }
      if (request.kind === 'ask_user_question') {
        return { kind: 'ask_user_question', answers: {}, dismissed: true };
      }
      return {
        kind: 'plan_review',
        behavior: 'deny',
        reason: 'remote_quick_test',
        dismissed: true,
      };
    });
    // Begin consumption before prompt dispatch so a very fast terminal frame
    // cannot be lost between send acceptance and subscription. Always attach a
    // rejection observer: timeout/send failures may win the caller race first.
    events = collectQuickTestOutput(session);
    void events.catch(() => undefined);
    await session.handle.send({ type: 'user', content: options.prompt });
    const stdout = await awaitWithin(events, timeoutMs);
    return {
      stdout,
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: (deps.now ?? Date.now)() - startedAt,
    };
  } finally {
    // Close before dropping the session-provider mapping: OMP may still emit a
    // final provider-bound cleanup request while its transport is stopping.
    if (session) {
      await session.close({ reason: 'navigation' }).catch(() => undefined);
    }
    if (providerBound) deps.clearSessionProvider(sessionId);
    // `events` stays locally handled even when close causes the async iterator
    // to reject after the caller has already received a timeout/start error.
    void events?.catch(() => undefined);
  }
}
