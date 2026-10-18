import { AgentPresentationRuntime, type AgentTerminalDriver } from '../presentation.js';
import { ClaudeNativeBridge, type ClaudeBridgeEvent, type ClaudeNativeRequest } from './native-bridge.js';
import { prepareClaudeNativePlugin } from './native-plugin.js';
import { ClaudeNativeHooks } from './native-hooks.js';
import { ClaudeNativeMessages, type ClaudeNativeSubmission, type ClaudeNativeUserMessage } from './native-messages.js';
import { ClaudeNativeTurns, type ClaudeNativeTurn } from './native-turns.js';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeNativeLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}
export interface ClaudeNativeRuntimeOptions {
  nativeSessionId: string;
  executable: string;
  cwd: string;
  /** Existing adapter's resolved flags; no print/SDK transport flags. */
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** The same callbacks used by the existing Claude adapter, not a replacement policy. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Host-owned PTY factory, local or remote; never obtained from renderer input. */
  launch(spec: ClaudeNativeLaunch): AgentTerminalDriver | Promise<AgentTerminalDriver>;
  onEvent(event: ClaudeBridgeEvent): void;
  /** Host history pipeline; receives the actual native row and authenticated display association. */
  onUserMessage?(message: ClaudeNativeUserMessage): void;
  /** Awaited before the first provider call, for GUI and original TUI turns. */
  onTurnAdmission?(turn: ClaudeNativeTurn, signal: AbortSignal): Promise<void>;
  onRequest(request: ClaudeNativeRequest, signal: AbortSignal): Promise<unknown>;
  onExit(exit: { code: number | null; signal?: string }): void;
  onFault(reason: string): void;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
}

/** One native process, its semantic channel and presentation share one lifetime. */
export interface ClaudeNativeRuntime {
  presentation: AgentPresentationRuntime;
  ready: Promise<void>;
  command(kind: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  submit(input: ClaudeNativeSubmission, timeoutMs?: number): Promise<{ nativeMessageId: string }>;
  close(): Promise<void>;
}

export async function createClaudeNativeRuntime(options: ClaudeNativeRuntimeOptions): Promise<ClaudeNativeRuntime> {
  if (options.signal?.aborted) throw new Error('Native Claude launch cancelled');
  if (options.args.some(arg => ['--', '-p', '--print', '--input-format', '--output-format', '--session-id', '--resume', '--continue'].includes(arg)
    || ['--input-format=', '--output-format=', '--session-id='].some(prefix => arg.startsWith(prefix)))) {
    throw new Error('Native Claude requires one interactive session identity');
  }
  const hooks = options.hooks ? new ClaudeNativeHooks(options.nativeSessionId, options.hooks) : undefined;
  const turns = options.onTurnAdmission ? new ClaudeNativeTurns(options.nativeSessionId, options.onTurnAdmission) : undefined;
  const messages = new ClaudeNativeMessages(options.nativeSessionId, message => {
    turns?.record(message); options.onUserMessage?.(message);
  });
  // prepareClaudeNativePlugin owns its random temporary root and cleanup. No
  // shared plugin registry, user settings or existing agent home is modified.
  const plugin = await prepareClaudeNativePlugin();
  let presentation: AgentPresentationRuntime | undefined;
  let driver: AgentTerminalDriver | undefined;
  let launchPromise: Promise<AgentTerminalDriver> | undefined;
  let stopExit: (() => void) | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined, closed = false, exited = false, observedReady = false;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A TUI may be attached during startup before a GUI sender awaits readiness.
  void ready.catch(() => {});
  const fail = (reason: string) => {
    if (closed) return;
    rejectReady(new Error(reason));
    try { options.onFault(reason); } finally { void close().catch(() => {}); }
  };
  const bridge = new ClaudeNativeBridge({
    sessionId: options.nativeSessionId,
    onEvent(event) {
      if (closed) return;
      if (event.kind === 'ready') {
        const value = event.value as { sessionId?: string; isInteractive?: boolean; hostHooksEnabled?: boolean; hostTurnAdmission?: boolean };
        if (observedReady || value.sessionId !== options.nativeSessionId || value.isInteractive !== true
          || (hooks && value.hostHooksEnabled !== true) || (turns && value.hostTurnAdmission !== true)) {
          fail('Native Claude session identity changed'); return;
        }
        observedReady = true; clearTimeout(readyTimer); resolveReady();
      }
      messages.accept(event);
      turns?.accept(event);
      options.onEvent(event);
    },
    onRequest: (request, signal) => request.kind === 'hook'
      ? hooks ? hooks.run(request.input, signal) : Promise.reject(new Error('Native host hooks are not configured'))
      : request.kind === 'turn-admission'
        ? turns ? turns.request(request.input, signal) : Promise.reject(new Error('Native host admission is not configured'))
        : options.onRequest(request, signal),
    onFault: () => fail('Native Claude semantic transport interrupted'),
  });
  const abort = () => { void close().catch(() => {}); };
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    turns?.close();
    rejectReady(new Error('Native Claude runtime closed'));
    clearTimeout(readyTimer); options.signal?.removeEventListener('abort', abort);
    stopExit?.();
    closing = Promise.resolve().then(async () => {
      // Stop the owned process before removing its plugin. A detached view never
      // calls this method; only task shutdown, failed startup or runtime fault.
      let processStopped = false;
      try {
        const launched = await launchPromise?.catch(() => undefined);
        if (presentation) await presentation.close(); else await launched?.close();
        processStopped = true;
      }
      finally {
        messages.close();
        try { await bridge.close(); } finally { if (processStopped) await plugin.dispose(); }
      }
    });
    return closing;
  }
  try {
    await bridge.start();
    if (options.signal?.aborted) throw new Error('Native Claude launch cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const spec = { executable: options.executable, cwd: options.cwd,
      args: [...options.args, '--session-id', options.nativeSessionId, '--plugin-dir', plugin.root],
      env: { ...options.env, ...bridge.environment(), LEX_CLAUDE_BRIDGE_HOST_HOOKS: hooks ? '1' : '0',
        LEX_CLAUDE_BRIDGE_TURN_ADMISSION: turns ? '1' : '0' }, cols: 120, rows: 36 };
    launchPromise = Promise.resolve().then(() => options.launch(spec));
    driver = await launchPromise;
    if (closed || options.signal?.aborted) throw new Error('Native Claude launch cancelled');
    presentation = new AgentPresentationRuntime(options.nativeSessionId, driver);
    stopExit = driver.onExit((exit) => {
      if (closed) return;
      exited = true; clearTimeout(readyTimer);
      turns?.close();
      if (!observedReady) rejectReady(new Error('Native Claude exited before initialization'));
      void bridge.close().catch(() => {});
      options.onExit(exit);
    });
    if (!observedReady) {
      readyTimer = setTimeout(() => fail('Native Claude initialization timed out'), options.readyTimeoutMs ?? 30_000);
      readyTimer.unref();
    }
    return { presentation, ready, close,
      async submit(input, timeoutMs) {
        await ready;
        if (closed || exited) throw new Error('Native Claude runtime closed');
        return messages.submit(input, payload => bridge.enqueueCommand('submit', payload, timeoutMs));
      },
      async command(kind, payload, timeoutMs) {
        await ready;
        if (closed || exited) throw new Error('Native Claude runtime closed');
        return bridge.command(kind, payload, timeoutMs);
      } };
  } catch (error) { await close(); throw error; }
}
