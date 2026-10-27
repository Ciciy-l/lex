import { createCodexNativeTaskRouting, type CodexNativeTaskRoutingOptions, type CodexNativePresentationLaunch, type CodexNativeFreshPresentationLaunch, type CodexNativePreparedPresentation } from '@cindy/maker-core';
import { createDesktopCodexNativeCatalog } from './codexNativeCatalog.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentPresentationRuntime, type AgentTerminalDriver } from '@cindy/maker-core';
import type { CodexNativeSessionHandle } from '@cindy/maker-core';
import type { CodexNativeEndpoint } from '@cindy/maker-core';
import { AgentTerminalPtyDriver, type AgentTerminalLaunch } from '../terminal/agentTerminalDriver.js';
import { createCodexLoopbackTransport } from './codex-loopback-transport.js';
import { connectCodexNativeFrontend, type CodexNativeFrontendOptions } from '@cindy/maker-core';
import { createCodexNativeGateway } from './codex-native-gateway.js';

type OwnedTerminal = AgentTerminalDriver & { readonly pid: number };
export interface CodexNativePresentationOptions {
  handle: Pick<CodexNativeSessionHandle, 'id' | 'attachNativeApprovalFrontend' | 'attachNativeToolFrontend'>;
  endpoint: CodexNativeEndpoint;
  executable: string;
  cwd: string;
  env: Record<string, string>;
  isCurrent(): boolean;
  request: CodexNativeFrontendOptions['request'];
  notification: CodexNativeFrontendOptions['notification'];
  responseDelivered?: CodexNativeFrontendOptions['responseDelivered'];
  closed?: CodexNativeFrontendOptions['closed'];
  owningHost?: CodexNativeFrontendOptions['owningHost'];
  owningNotifications?: CodexNativeFrontendOptions['owningNotifications'];
  logger: { warn(message: string): void };
  registerProcess?(pid: number): void | (() => void);
  tempRoot?: string;
  signal?: AbortSignal;
}

/** Native UI is a frontend only. It receives no service/provider credentials. */
export async function createCodexNativePresentation(
  options: CodexNativePresentationOptions,
  launch: (spec: AgentTerminalLaunch) => OwnedTerminal = spec => new AgentTerminalPtyDriver(spec),
): Promise<{ presentation: AgentPresentationRuntime; close(): Promise<void> }> {
  const threadId = options.handle.id;
  if (!threadId || threadId === '<pending>') throw new Error('Native Codex task owner unavailable');
  const frontend = await prepareCodexNativeFrontend(options, ['resume', threadId], launch);
  return { presentation: frontend.bind(threadId), close: frontend.close };
}

/** Starts only the original UI. No native id or synthetic handle is needed. */
async function prepareCodexNativeFrontend(
  options: Omit<CodexNativePresentationOptions, 'handle'> & { handle: Pick<CodexNativeSessionHandle, 'attachNativeApprovalFrontend' | 'attachNativeToolFrontend'> },
  command: string[],
  launch: (spec: AgentTerminalLaunch) => OwnedTerminal = spec => new AgentTerminalPtyDriver(spec),
) {
  const current = () => !options.signal?.aborted && options.isCurrent();
  const check = () => { if (!current()) throw new Error('Native Codex task owner unavailable'); };
  check();
  const home = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), 'lex-codex-frontend-'));
  let gateway: Awaited<ReturnType<typeof createCodexNativeGateway>> | undefined;
  let terminal: OwnedTerminal | undefined, presentation: AgentPresentationRuntime | undefined;
  let unregister: (() => void) | undefined, stopExit: (() => void) | undefined;
  let release: Promise<void> | undefined, closing: Promise<void> | undefined;
  let revoked = false;
  const releaseAfterExit = () => release ??= Promise.resolve().then(async () => {
    revoked = true; stopExit?.();
    options.signal?.removeEventListener('abort', abort);
    try { unregister?.(); } catch { /* Process observation is best effort. */ }
    await gateway?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const close = () => {
    if (closing) return closing;
    revoked = true;
    closing = Promise.resolve().then(async () => {
      options.signal?.removeEventListener('abort', abort);
      // A failed connection cleanup must not prevent the owned PTY from closing.
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => gateway?.close()),
        Promise.resolve().then(() => presentation ? presentation.close() : terminal?.close()),
      ]);
      // Rejected close does not prove native exit; keep its home on that path.
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      await releaseAfterExit();
    });
    return closing;
  };
  const abort = () => { void close().catch(() => { options.logger.warn('native Codex frontend close unconfirmed'); }); };
  try {
    await mkdir(path.join(home, '.codex'));
    check();
    gateway = await createCodexNativeGateway({ isCurrent: () => !revoked && current(), attach(frontend) {
      check();
      const upstream = createCodexLoopbackTransport(options.endpoint);
      try { return connectCodexNativeFrontend({ frontend, upstream, handle: options.handle,
        isCurrent: () => !revoked && current(), request: options.request, notification: options.notification,
        owningHost: options.owningHost, owningNotifications: options.owningNotifications,
        responseDelivered: options.responseDelivered, closed: options.closed }); }
      catch (error) { void upstream.close().catch(() => {}); throw error; }
    } });
    check();
    // Inherit only OS/terminal essentials. The native server owns API keys,
    // OAuth, provider routes and the authoritative history/config home.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)) env[key] = value;
    }
    Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      TERM: 'xterm-256color', NO_PROXY: '127.0.0.1,localhost', LEX_CODEX_FRONTEND_TOKEN: gateway.endpoint.token });
    terminal = launch({ executable: options.executable, cwd: options.cwd, env,
      args: [...command, '--remote', gateway.endpoint.url, '--remote-auth-token-env', 'LEX_CODEX_FRONTEND_TOKEN'] });
    try { const cleanup = options.registerProcess?.(terminal.pid); if (typeof cleanup === 'function') unregister = cleanup; }
    catch { /* Same best-effort process observation as the native service. */ }
    stopExit = terminal.onExit(() => {
      try { options.closed?.(); } catch { /* Keep resource cleanup independent. */ }
      void releaseAfterExit().catch(() => {
      options.logger.warn('native Codex frontend resource cleanup failed');
    }); });
    options.signal?.addEventListener('abort', abort, { once: true });
    check();
    return { bind(threadId: string) {
      check();
      if (revoked || presentation || !threadId || threadId === '<pending>') throw new Error('Native Codex frontend already bound or retired');
      presentation = new AgentPresentationRuntime(threadId, terminal!);
      return presentation;
    }, close };
  } catch (error) {
    await close(); throw error;
  }
}

/** Main selects catalog/controls while Core supplies actual task lineage. */
function taskRouting(launch: CodexNativePresentationLaunch,
  catalog: CodexNativeTaskRoutingOptions['catalog'], control: CodexNativeTaskRoutingOptions['control'],
  fresh?: CodexNativeTaskRoutingOptions['fresh']) {
  return createCodexNativeTaskRouting({ handle: launch.handle, cwd: launch.cwd,
    isCurrent: launch.isCurrent, ...launch.routingContext, catalog, fresh,
    control: (call, scope) => call.request.method === 'thread/settings/update' && scope === 'task'
      ? launch.handle.applyNativeRuntimeSettings(call.request.params, call.signal)
      : call.request.method === 'turn/interrupt' && scope === 'task'
        ? launch.handle.interruptNativeTurn(call.request.params, call.signal)
        : call.request.method === 'thread/compact/start' && scope === 'task'
          ? launch.handle.acceptNativeCompact(call.request.params, call.signal)
        : call.request.method === 'turn/steer' && scope === 'task'
          ? launch.handle.acceptNativeSteer({ params: call.request.params as Parameters<CodexNativeSessionHandle['acceptNativeSteer']>[0]['params'], signal: call.signal,
            dispatch: params => call.forward(params) as ReturnType<CodexNativeSessionHandle['acceptNativeSteer']> }) : control(call, scope),
  });
}

export function createTaskCodexNativePresentation(launch: CodexNativePresentationLaunch,
  options: Omit<CodexNativePresentationOptions, 'handle' | 'endpoint' | 'cwd' | 'isCurrent' | 'signal' | 'request' | 'notification'> & {
    catalog?: CodexNativeTaskRoutingOptions['catalog'];
    control: CodexNativeTaskRoutingOptions['control'];
  }) {
  const nativeSessionId = launch.handle.id;
  const catalog = options.catalog ?? createDesktopCodexNativeCatalog({
    nativeSessionId, cwd: launch.cwd,
    isCurrent: () => launch.isCurrent() && launch.handle.id === nativeSessionId,
    readRuntime: () => {
      const runtime = launch.handle.readNativeRuntimeSnapshot();
      return { model: runtime.catalogModel, nativeModel: runtime.nativeModel, providerId: runtime.providerId,
        nativeModelProvider: runtime.nativeModelProvider, effort: runtime.effort, fastMode: runtime.fastMode };
    },
  });
  const routing = taskRouting(launch, catalog, options.control);
  return createCodexNativePresentation({ ...options, handle: launch.handle, endpoint: launch.service.endpoint,
    cwd: launch.cwd, signal: launch.signal, isCurrent: launch.isCurrent,
    request: routing.request, notification: routing.notification,
    responseDelivered: routing.responseDelivered, closed: routing.closed }).then(
      owner => ({ ...owner, ready: routing.ready }),
      error => { routing.closed(); throw error; });
}

/** The native UI supplies its original codex_tui MCP executor at fresh start. */
export async function prepareTaskCodexNativePresentation(launch: CodexNativeFreshPresentationLaunch,
  options: Pick<CodexNativePresentationOptions, 'executable' | 'env' | 'logger' | 'registerProcess' | 'tempRoot'> & {
    catalog?: CodexNativeTaskRoutingOptions['catalog'];
  }): Promise<CodexNativePreparedPresentation> {
  let routing: ReturnType<typeof taskRouting> | undefined;
  const creation = launch.creation;
  const catalog = options.catalog ?? createDesktopCodexNativeCatalog({
    nativeSessionId: () => creation.threadId, taskIdentity: launch.sessionId, cwd: launch.cwd, isCurrent: launch.isCurrent,
    readRuntime: () => {
      const runtime = launch.readRuntime();
      return { model: runtime.catalogModel, nativeModel: runtime.nativeModel, providerId: runtime.providerId,
        nativeModelProvider: runtime.nativeModelProvider, effort: runtime.effort, fastMode: runtime.fastMode };
    },
  });
  const frontend = await prepareCodexNativeFrontend({ ...options, handle: launch, endpoint: launch.service.endpoint,
    cwd: launch.cwd, signal: launch.signal, isCurrent: launch.isCurrent,
    owningHost: { host: launch.host, timeoutMs: 30_000 }, owningNotifications: creation,
    request: call => creation.route(call, { cwd: launch.cwd, prepareStart: launch.prepareStart,
      catalog: call => ['config/read', 'model/list', 'mcpServerStatus/list'].includes(call.request.method)
        ? catalog(call) : call.forward(),
      bound: call => {
        if (!routing) throw new Error('Native task handle is not bound');
        // Root operations use the same owning client and its event/approval owner.
        return routing.request({ ...call, forward: (params = call.request.params) => call.dispatchToHost!(params) });
      },
    }),
    notification: () => null, responseDelivered: (request, result) => creation.responseDelivered(request, result),
    closed: () => creation.close(),
  }, []);
  return { close: frontend.close, bind(bound) {
    if (routing || !launch.isCurrent() || bound.handle.id !== creation.threadId) throw new Error('Native fresh handle owner changed');
    const control: CodexNativeTaskRoutingOptions['control'] = (call, scope) => {
      if (!bound.routingContext.control) throw new Error('Native task control is unavailable');
      return bound.routingContext.control(call, scope);
    };
    routing = taskRouting(bound, catalog, control, { ready: creation.ready, isReady: () => creation.inputReady });
    return { presentation: frontend.bind(bound.handle.id), ready: creation.ready, close: frontend.close };
  } };
}
