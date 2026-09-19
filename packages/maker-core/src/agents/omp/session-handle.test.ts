import { describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { PermissionMode } from '../../types/common.js';
import type { AgentEvent, InteractionRequest } from '../../types/events.js';
import { isOmpRecord, OmpCommandCatalog } from './commands.js';
import { OmpRpcClient, type OmpRpcTransport } from './rpc-client.js';
import type { OmpProcessHost } from './process-host.js';
import { OmpPermissionBridge } from './permission-bridge.js';
import {
  OmpSessionHandle,
  toOmpPromptText,
  type OmpSessionRuntime,
  type OmpSessionRuntimeCallbacks,
} from './session-handle.js';
import { OmpTranslator } from './translator.js';

/** `JSON.parse` 返回 unknown；这里用运行时守卫收窄，不做断言式 cast。 */
function parseFrameObject(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isOmpRecord(parsed)) throw new Error('expected an OMP object frame');
  return parsed;
}

interface FakeTransport extends OmpRpcTransport {
  emit(line: string): void;
  written(): Array<Record<string, unknown>>;
}

function createFakeTransport(): FakeTransport {
  const lineListeners: ((line: string) => void)[] = [];
  const written: Array<Record<string, unknown>> = [];
  return {
    writeLine(line: string) {
      written.push(parseFrameObject(line));
    },
    onLine(listener: (line: string) => void) {
      lineListeners.push(listener);
      return () => {
        const index = lineListeners.indexOf(listener);
        if (index >= 0) lineListeners.splice(index, 1);
      };
    },
    onClose() {
      return () => undefined;
    },
    emit(line: string) {
      for (const listener of [...lineListeners]) listener(line);
    },
    written() {
      return written;
    },
  };
}

type PermissionAnswer = { kind: 'permission'; behavior: 'allow' | 'deny' };

interface Harness {
  handle: OmpSessionHandle;
  transport: FakeTransport;
  vendorOptions: Record<string, unknown>;
  bridge: OmpPermissionBridge;
  events: AgentEvent[];
  requests: InteractionRequest[];
  setResolver(resolver: (request: InteractionRequest) => Promise<PermissionAnswer>): void;
  /** 回一个成功响应，让 await 中的 RPC 落地。 */
  answer(command: string): void;
}

function harness(options: {
  providerId?: string;
  ompProviderId?: string;
  commandCatalog?: OmpCommandCatalog;
  vendorOptions?: Record<string, unknown>;
  contextWindow?: number;
} = {}): Harness {
  const transport = createFakeTransport();
  const vendorOptions = options.vendorOptions ?? {};
  const events: AgentEvent[] = [];
  const requests: InteractionRequest[] = [];
  const client = new OmpRpcClient(
    transport,
    () => undefined,
    () => undefined,
  );
  const translator = new OmpTranslator({
    logger: createConsoleLogger('omp-handle-test'),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  });
  const bridge = new OmpPermissionBridge({
    logger: createConsoleLogger('omp-handle-test'),
    respond: (id, response, correlation) => client.respondToUi(id, response, correlation),
    emit: (event: AgentEvent) => events.push(event),
  });
  const host: OmpProcessHost = {
    client,
    pid: 4242,
    getState: () => 'ready',
    stopAndWait: () => Promise.resolve(true),
  };
  const runtime: OmpSessionRuntime = {
    sessionFile: 'C:\\omp-home\\sessions\\abc.jsonl',
    permissionMode: 'ask',
    approvalMode: 'always-ask',
    host,
    translator,
    bridge,
    ...(options.commandCatalog ? { commandCatalog: options.commandCatalog } : {}),
    stopAndDispose: () => host.stopAndWait(),
  };
  const handle = new OmpSessionHandle({
    sessionId: '',
    model: 'MiniMax-M2',
    providerId: options.providerId ?? 'cindy',
    ...(options.ompProviderId === undefined ? {} : { ompProviderId: options.ompProviderId }),
    workingDir: 'C:\\work',
    vendorOptions,
    runtime,
    logger: createConsoleLogger('omp-handle-test'),
  });
  return {
    handle,
    transport,
    vendorOptions,
    bridge,
    events,
    requests,
    setResolver(next) {
      bridge.setResolver(async (request) => {
        requests.push(request);
        return next(request);
      });
    },
    answer(command: string) {
      const frame = transport
        .written()
        .find((entry) => entry.type === command || entry.command === undefined);
      const pending = transport
        .written()
        .filter((entry) => entry.command === undefined)
        .find((entry) => entry.type === command);
      const target = pending ?? frame;
      transport.emit(
        JSON.stringify({
          type: 'response',
          id: target?.id,
          command,
          success: true,
        }),
      );
    },
  };
}

interface RuntimeFixture {
  readonly runtime: OmpSessionRuntime;
  readonly stopAndDispose: ReturnType<typeof vi.fn>;
  emitFrame(frame: Readonly<Record<string, unknown>>): void;
  emitExit(state: string): void;
}

function runtimeFixture(options: {
  sessionFile?: string;
  permissionMode?: PermissionMode;
  approvalMode?: 'always-ask' | 'write' | 'yolo';
  stopResult?: boolean;
  commandCatalog?: OmpCommandCatalog;
} = {}): RuntimeFixture {
  const transport = createFakeTransport();
  const client = new OmpRpcClient(transport, () => undefined, () => undefined);
  const translator = new OmpTranslator({ logger: createConsoleLogger('omp-restart-test') });
  let callbacks: OmpSessionRuntimeCallbacks | undefined;
  const bridge = new OmpPermissionBridge({
    logger: createConsoleLogger('omp-restart-test'),
    respond: (id, response, correlation) => client.respondToUi(id, response, correlation),
    emit: (event) => callbacks?.emit(event),
  });
  const host: OmpProcessHost = {
    client,
    pid: 4242,
    getState: () => 'ready',
    stopAndWait: () => Promise.resolve(options.stopResult ?? true),
  };
  const stopAndDispose = vi.fn(() => host.stopAndWait());
  const runtime: OmpSessionRuntime = {
    sessionFile: options.sessionFile ?? 'C:/omp-home/sessions/abc.jsonl',
    permissionMode: options.permissionMode ?? 'ask',
    approvalMode: options.approvalMode ?? 'always-ask',
    host,
    translator,
    bridge,
    ...(options.commandCatalog ? { commandCatalog: options.commandCatalog } : {}),
    activate: (next) => { callbacks = next; },
    stopAndDispose,
  };
  return {
    runtime,
    stopAndDispose,
    emitFrame(frame) { callbacks?.onFrame(frame); },
    emitExit(state) { callbacks?.onProcessExit(state); },
  };
}

function restartableHandle(
  initial: RuntimeFixture,
  restartRuntime: (input: { permissionMode: PermissionMode; sessionFile: string }) => Promise<OmpSessionRuntime>,
): OmpSessionHandle {
  return new OmpSessionHandle({
    sessionId: initial.runtime.sessionFile,
    model: 'MiniMax-M2',
    providerId: 'cindy',
    ompProviderId: 'cindy',
    workingDir: 'C:/work',
    vendorOptions: {},
    runtime: initial.runtime,
    restartRuntime,
    logger: createConsoleLogger('omp-restart-test'),
  });
}

function selectFrame(id: string, toolName: string): Record<string, unknown> {
  return parseFrameObject(
    JSON.stringify({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: `Allow tool: ${toolName}\nPath: hello.txt`,
      options: ['Approve', 'Deny'],
    }),
  );
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `toolName` 只存在于 permission kind 上；测试里按 kind 收窄，不做 cast。 */
function toolNameOf(request: InteractionRequest | undefined): string {
  return request?.kind === 'permission' ? request.toolName : '';
}

function uiResponses(test: Harness): Array<Record<string, unknown>> {
  return test.transport.written().filter((entry) => entry.type === 'extension_ui_response');
}

function lastRequest(
  test: Harness,
  command: string,
): Record<string, unknown> | undefined {
  return test.transport
    .written()
    .filter((entry) => entry.command === undefined)
    .find((entry) => entry.type === command);
}

describe('OmpSessionHandle identity', () => {
  it('keeps the first adopted session file as the durable sdkSessionId', () => {
    const test = harness();
    expect(test.handle.id).toBe('C:\\omp-home\\sessions\\abc.jsonl');
    test.handle.adoptSessionFile('C:\\other\\later.jsonl');
    expect(test.handle.id).toBe('C:\\omp-home\\sessions\\abc.jsonl');
    expect(test.handle.agentKind).toBe('omp');
  });
});

describe('OmpSessionHandle context usage', () => {
  it('projects only the usage and effective window reported by the native runtime', async () => {
    const test = harness({ contextWindow: 128_000 });
    test.handle.dispatchFrame({
      type: 'message_end',
      message: {
        id: 'usage-1',
        role: 'assistant',
        usage: { input: 1_000, output: 200, cacheRead: 50, cacheWrite: 25 },
      },
    });

    await expect(test.handle.getContextUsage()).resolves.toMatchObject({
      categories: [{ name: 'Messages', tokens: 1_075 }],
      totalTokens: 1_075,
      maxTokens: 128_000,
      rawMaxTokens: 128_000,
      model: 'MiniMax-M2',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: null,
    });
  });
});

describe('OmpSessionHandle model selection', () => {
  it("keeps the Lex source separate from OMP's managed provider", async () => {
    const test = harness({ providerId: 'minimax', ompProviderId: 'cindy' });
    const pending = test.handle.setModel('MiniMax-M3', { providerId: 'minimax' });
    await drain();

    expect(lastRequest(test, 'set_model')).toMatchObject({
      type: 'set_model',
      provider: 'cindy',
      modelId: 'MiniMax-M3',
    });

    test.answer('set_model');
    await expect(pending).resolves.toBeUndefined();
  });

  it('uses the shared rebuild path when a startup-scoped OMP route changes', () => {
    const test = harness({ providerId: 'minimax', ompProviderId: 'cindy' });

    expect(
      test.handle.requiresModelSwitchRebuild('MiniMax-M2', { providerId: 'minimax' }),
    ).toBe(false);
    expect(
      test.handle.requiresModelSwitchRebuild('MiniMax-M3', { providerId: 'minimax' }),
    ).toBe(true);
    expect(
      test.handle.requiresModelSwitchRebuild('MiniMax-M2', { providerId: 'other-source' }),
    ).toBe(true);
    // An omitted source means keep the already-materialized source.
    expect(test.handle.requiresModelSwitchRebuild('MiniMax-M2', { providerId: null })).toBe(false);
  });
});

describe('OmpSessionHandle runtime vendor options', () => {
  it('updates the session-owned host-tool context by reference without a new RPC command', async () => {
    const initialOptions: Record<string, unknown> = { source: 'local' };
    const test = harness({ vendorOptions: initialOptions });

    await test.handle.setVendorOptions({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'session-1',
    });

    expect(test.vendorOptions).toBe(initialOptions);
    expect(initialOptions).toMatchObject({
      source: 'local',
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'session-1',
    });
    // The OMP host-tool manifest is fixed at startup. Role updates are local
    // closure changes, exactly like the other three engine adapters.
    expect(test.transport.written()).toEqual([]);
  });

  it('rejects a live context update after the OMP session is closed', async () => {
    const test = harness();
    await test.handle.close({ reason: 'navigation' });

    await expect(test.handle.setVendorOptions({ orcaRole: 'lead' })).rejects.toThrow(
      'OMP session is closed',
    );
  });
});

describe('OmpSessionHandle send / steer / abort', () => {
  it('sends a prompt frame and settles when OMP accepts it', async () => {
    const test = harness();
    const pending = test.handle.send({ type: 'user', content: 'create hello.txt' });
    await drain();
    const frame = lastRequest(test, 'prompt');
    expect(frame?.type).toBe('prompt');
    expect(frame?.message).toBe('create hello.txt');
    test.transport.emit(
      JSON.stringify({ type: 'response', id: frame?.id, command: 'prompt', success: true }),
    );
    await pending;
  });

  it('flattens structured user content into text', () => {
    expect(
      toOmpPromptText({
        type: 'user',
        content: [
          { type: 'text', text: 'look at' },
          { type: 'file', path: 'a.ts' },
        ],
      }),
    ).toBe('look at\n[file: a.ts]');
  });

  it('steers through the steer channel', async () => {
    const test = harness();
    const pending = test.handle.steer({ type: 'user', content: 'also add a license' });
    await drain();
    const frame = lastRequest(test, 'steer');
    expect(frame?.type).toBe('steer');
    test.transport.emit(
      JSON.stringify({ type: 'response', id: frame?.id, command: 'steer', success: true }),
    );
    await pending;
  });

  it('aborts and fails closed on every pending permission card', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    // 卡片还挂在那里就 abort —— 这才是「用户按了 Stop」的真实时序。
    test.handle.dispatchFrame(selectFrame('aaa', 'write'));
    const aborting = test.handle.abort();
    await drain();
    const abortFrame = lastRequest(test, 'abort');
    test.transport.emit(
      JSON.stringify({ type: 'response', id: abortFrame?.id, command: 'abort', success: true }),
    );
    await aborting;
    expect(uiResponses(test)).toHaveLength(1);
    expect(uiResponses(test)[0]).toMatchObject({ cancelled: true });
  });
});

describe('OmpSessionHandle permission bridge integration', () => {
  it('routes a select approval frame through the Lex interaction resolver', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    test.handle.dispatchFrame(selectFrame('157cf60a9ce9ac08', 'write'));
    await drain();
    expect(test.requests).toHaveLength(1);
    expect(toolNameOf(test.requests[0])).toBe('write');
    expect(uiResponses(test)[0]).toMatchObject({ id: '157cf60a9ce9ac08', value: 'Approve' });
  });

  it('does not invent an authorization when OMP auto-approves the read tier', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    // read tier 由 OMP 直接执行，不会发审批帧（spike §9.3）—— 因此这里一帧都没有。
    test.handle.dispatchFrame({
      type: 'tool_execution_start',
      toolCallId: 'r1',
      toolName: 'read',
      args: { path: 'hello.txt' },
    });
    await drain();
    expect(test.requests).toHaveLength(0);
    expect(uiResponses(test)).toHaveLength(0);
  });

  it('survives the upstream retry ladder after a denial without crashing', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'deny' }));
    // OMP 被拒后依次换 write → bash → eval 重试，每次都是独立审批帧（spike §9.6）。
    const ladder: Array<[string, string]> = [
      ['id-1', 'write'],
      ['id-2', 'bash'],
      ['id-3', 'eval'],
    ];
    for (const [id, toolName] of ladder) {
      test.handle.dispatchFrame(selectFrame(id, toolName));
      await drain();
    }
    expect(uiResponses(test)).toHaveLength(3);
    expect(uiResponses(test).map((entry) => entry.value)).toEqual(['Deny', 'Deny', 'Deny']);
    expect(test.requests.map(toolNameOf)).toEqual(['write', 'bash', 'eval']);
    expect(test.bridge.pendingCount).toBe(0);
  });

  it('fails closed when the approval options cannot be recognized', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    test.handle.dispatchFrame({
      type: 'extension_ui_request',
      id: 'weird',
      method: 'select',
      title: 'Allow tool: write',
      options: ['Proceed', 'Later'],
    });
    await drain();
    expect(test.requests).toHaveLength(0);
    expect(uiResponses(test)[0]).toMatchObject({ id: 'weird', cancelled: true });
  });
});

describe('OmpSessionHandle event stream', () => {
  it('projects frames into a single event outlet and ends it on close', async () => {
    const test = harness();
    const seen: AgentEvent[] = [];
    const consuming = (async () => {
      for await (const event of test.handle.events()) seen.push(event);
    })();
    test.handle.dispatchFrame({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
    });
    test.handle.dispatchFrame({ type: 'agent_start' });
    test.handle.dispatchFrame({ type: 'agent_end', isTerminal: true });
    await drain();
    expect(seen.map((event) => event.type)).toEqual(['text', 'status', 'status', 'done']);
    expect(seen[2]?.data).toMatchObject({ status: 'Done', isRunning: false });
    await test.handle.close({ reason: 'navigation' });
    await consuming;
  });

  it('rejects a mid-session permission-mode change when no restart factory is available', async () => {
    const test = harness();
    await expect(test.handle.setPermissionMode('auto')).rejects.toThrow(/restart is unavailable/i);
  });

  it('exports the session through the native export_html RPC', async () => {
    const test = harness();
    const exported = test.handle.exportSessionHtml('C:\\tmp\\out.html');
    await drain();
    const frame = lastRequest(test, 'export_html');
    expect(frame?.outputPath).toBe('C:\\tmp\\out.html');
    test.transport.emit(
      JSON.stringify({
        type: 'response',
        id: frame?.id,
        command: 'export_html',
        success: true,
      }),
    );
    await expect(exported).resolves.toBe('C:\\tmp\\out.html');
  });
});

describe('OmpSessionHandle permission-mode restart', () => {
  it('retires the old runtime before building a strictly resumed replacement', async () => {
    const initial = runtimeFixture();
    const replacement = runtimeFixture({ permissionMode: 'auto', approvalMode: 'write' });
    const factory = vi.fn(async (input: { permissionMode: PermissionMode; sessionFile: string }) => {
      expect(initial.stopAndDispose).toHaveBeenCalledOnce();
      expect(input).toEqual({
        permissionMode: 'auto',
        sessionFile: 'C:/omp-home/sessions/abc.jsonl',
      });
      return replacement.runtime;
    });
    const handle = restartableHandle(initial, factory);

    await handle.setPermissionMode('auto');

    expect(handle.approvalMode).toBe('write');
    expect(initial.stopAndDispose).toHaveBeenCalledOnce();
    expect(replacement.stopAndDispose).not.toHaveBeenCalled();
    await handle.close();
    expect(replacement.stopAndDispose).toHaveBeenCalledOnce();
  });

  it('does not restart when the requested mode is already active', async () => {
    const initial = runtimeFixture();
    const factory = vi.fn(async () => runtimeFixture().runtime);
    const handle = restartableHandle(initial, factory);

    await handle.setPermissionMode('ask');

    expect(factory).not.toHaveBeenCalled();
    expect(initial.stopAndDispose).not.toHaveBeenCalled();
    await handle.close();
  });

  it('refuses a restart during a native turn before stopping or constructing anything', async () => {
    const initial = runtimeFixture();
    const factory = vi.fn(async () => runtimeFixture().runtime);
    const handle = restartableHandle(initial, factory);
    initial.emitFrame({ type: 'agent_start' });

    await expect(handle.setPermissionMode('auto')).rejects.toThrow(/idle/);

    expect(factory).not.toHaveBeenCalled();
    expect(initial.stopAndDispose).not.toHaveBeenCalled();
    await handle.close();
  });

  it('fails closed instead of starting a second runtime after an unconfirmed old exit', async () => {
    const initial = runtimeFixture({ stopResult: false });
    const factory = vi.fn(async () => runtimeFixture().runtime);
    const handle = restartableHandle(initial, factory);

    await expect(handle.setPermissionMode('auto')).rejects.toThrow(/exit could not be confirmed/);

    expect(factory).not.toHaveBeenCalled();
    await expect(handle.send({ type: 'user', content: 'must not reach old process' })).rejects.toThrow(
      /session is closed/,
    );
  });

  it('disposes a replacement that reports a different session file and closes the logical session', async () => {
    const initial = runtimeFixture();
    const replacement = runtimeFixture({
      sessionFile: 'C:/omp-home/sessions/other.jsonl',
      permissionMode: 'auto',
      approvalMode: 'write',
    });
    const handle = restartableHandle(initial, async () => replacement.runtime);

    await expect(handle.setPermissionMode('auto')).rejects.toThrow(/different session/);

    expect(replacement.stopAndDispose).toHaveBeenCalledOnce();
    await expect(handle.setPermissionMode('ask')).rejects.toThrow(/session is closed/);
  });

  it('fences delayed callbacks from a retired runtime after a successful restart', async () => {
    const initial = runtimeFixture();
    const replacement = runtimeFixture({ permissionMode: 'auto', approvalMode: 'write' });
    const finalRuntime = runtimeFixture({
      permissionMode: 'bypassPermissions',
      approvalMode: 'yolo',
    });
    const factory = vi.fn(async (input: { permissionMode: PermissionMode }) =>
      input.permissionMode === 'auto' ? replacement.runtime : finalRuntime.runtime,
    );
    const handle = restartableHandle(initial, factory);

    await handle.setPermissionMode('auto');
    initial.emitFrame({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'stale' },
    });
    initial.emitExit('exited');
    await handle.setPermissionMode('bypassPermissions');

    expect(handle.approvalMode).toBe('yolo');
    expect(finalRuntime.stopAndDispose).not.toHaveBeenCalled();
    await handle.close();
  });

  it('reclaims a replacement that finishes after the user closes during restart', async () => {
    const initial = runtimeFixture();
    const replacement = runtimeFixture({ permissionMode: 'auto', approvalMode: 'write' });
    let resolveReplacement: ((runtime: OmpSessionRuntime) => void) | undefined;
    const gate = new Promise<OmpSessionRuntime>((resolve) => { resolveReplacement = resolve; });
    const factory = vi.fn(async () => gate);
    const handle = restartableHandle(initial, factory);

    const changing = handle.setPermissionMode('auto');
    await drain();
    expect(factory).toHaveBeenCalledOnce();
    await handle.close();
    resolveReplacement?.(replacement.runtime);

    await expect(changing).rejects.toThrow(/session closed/);
    expect(replacement.stopAndDispose).toHaveBeenCalledOnce();
  });
});

describe('OmpSessionHandle native command catalog', () => {
  it('projects live catalog revisions and retires observers with the session', async () => {
    const catalog = new OmpCommandCatalog();
    const test = harness({ commandCatalog: catalog });
    const seen: Array<{
      revision?: number;
      status?: string;
      commands?: string[];
    }> = [];
    test.handle.onRuntimeCommandCatalogChange((snapshot) => {
      seen.push(snapshot === undefined
        ? {}
        : {
            revision: snapshot.revision,
            status: snapshot.status,
            commands: snapshot.commands.map((command) => command.name),
          });
    });

    catalog.replace([{ name: 'compact', source: 'builtin', description: 'Compact' }]);
    expect(test.handle.getRuntimeCommandCatalog()).toMatchObject({
      revision: 1,
      status: 'loaded',
      commands: [{ kind: 'agent-builtin', name: 'compact', description: 'Compact' }],
    });

    await test.handle.close({ reason: 'navigation' });
    catalog.replace([{ name: 'model', source: 'builtin' }]);

    expect(seen).toEqual([
      { revision: 0, status: 'unknown', commands: [] },
      { revision: 1, status: 'loaded', commands: ['compact'] },
      {},
    ]);
  });

  it('adopts pushed native command updates without exposing them as chat events', async () => {
    const catalog = new OmpCommandCatalog();
    const test = harness({ commandCatalog: catalog });
    const seen: AgentEvent[] = [];
    const consuming = (async () => {
      for await (const event of test.handle.events()) seen.push(event);
    })();

    test.handle.dispatchFrame({
      type: 'available_commands_update',
      commands: [{
        name: 'skill:review',
        source: 'skill',
        description: 'Review the current change',
      }],
    });
    await drain();

    expect(catalog.getSnapshot()).toMatchObject({
      status: 'loaded',
      commands: [{ name: 'skill:review', source: 'skill' }],
    });
    expect(seen).toEqual([]);
    await test.handle.close({ reason: 'navigation' });
    await consuming;
  });

  it('revokes a stale command catalog when a pushed update is malformed', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'compact', source: 'builtin' }]);
    const test = harness({ commandCatalog: catalog });

    test.handle.dispatchFrame({
      type: 'available_commands_update',
      commands: [{ name: 'bad\tcommand', source: 'builtin' }],
    });

    expect(catalog.getSnapshot()).toEqual({ status: 'failed', commands: [] });
  });
});
