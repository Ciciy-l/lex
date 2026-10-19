import { createCodexNativeTaskRouting, type CodexNativeTaskRoutingOptions, type CodexNativePresentationLaunch } from '@cindy/maker-core';
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
  handle: Pick<CodexNativeSessionHandle, 'id' | 'attachNativeApprovalFrontend'>;
  endpoint: CodexNativeEndpoint;
  executable: string;
  cwd: string;
  env: Record<string, string>;
  isCurrent(): boolean;
  request: CodexNativeFrontendOptions['request'];
  notification: CodexNativeFrontendOptions['notification'];
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
  const current = () => !options.signal?.aborted && options.handle.id === threadId && options.isCurrent();
  const check = () => { if (!current() || !threadId || threadId === '<pending>') throw new Error('Native Codex task owner unavailable'); };
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
        isCurrent: () => !revoked && current(), request: options.request, notification: options.notification }); }
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
      args: ['resume', threadId, '--remote', gateway.endpoint.url, '--remote-auth-token-env', 'LEX_CODEX_FRONTEND_TOKEN'] });
    try { const cleanup = options.registerProcess?.(terminal.pid); if (typeof cleanup === 'function') unregister = cleanup; }
    catch { /* Same best-effort process observation as the native service. */ }
    stopExit = terminal.onExit(() => { void releaseAfterExit().catch(() => {
      options.logger.warn('native Codex frontend resource cleanup failed');
    }); });
    presentation = new AgentPresentationRuntime(threadId, terminal);
    options.signal?.addEventListener('abort', abort, { once: true });
    check();
    return { presentation, close };
  } catch (error) {
    await close(); throw error;
  }
}

/** Main selects catalog/controls while Core supplies actual task lineage. */
export function createTaskCodexNativePresentation(launch: CodexNativePresentationLaunch,
  options: Omit<CodexNativePresentationOptions, 'handle' | 'endpoint' | 'cwd' | 'isCurrent' | 'signal' | 'request' | 'notification'> & {
    catalog: CodexNativeTaskRoutingOptions['catalog'];
    control: CodexNativeTaskRoutingOptions['control'];
  }) {
  const routing = createCodexNativeTaskRouting({ handle: launch.handle, cwd: launch.cwd,
    isCurrent: launch.isCurrent, ...launch.routingContext, catalog: options.catalog,
    control: (call, scope) => call.request.method === 'thread/settings/update' && scope === 'task'
      ? launch.handle.applyNativeRuntimeSettings(call.request.params, call.signal) : options.control(call, scope),
  });
  return createCodexNativePresentation({ ...options, handle: launch.handle, endpoint: launch.service.endpoint,
    cwd: launch.cwd, signal: launch.signal, isCurrent: launch.isCurrent,
    request: routing.request, notification: routing.notification });
}
