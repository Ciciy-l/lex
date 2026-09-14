import { describe, expect, it } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent, InteractionRequest } from '../../types/events.js';
import { isOmpRecord } from './commands.js';
import { OmpRpcClient, type OmpRpcTransport } from './rpc-client.js';
import type { OmpProcessHost } from './process-host.js';
import { OmpPermissionBridge } from './permission-bridge.js';
import { OmpSessionHandle, toOmpPromptText } from './session-handle.js';
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
  bridge: OmpPermissionBridge;
  events: AgentEvent[];
  requests: InteractionRequest[];
  setResolver(resolver: (request: InteractionRequest) => Promise<PermissionAnswer>): void;
  /** 回一个成功响应，让 await 中的 RPC 落地。 */
  answer(command: string): void;
}

function harness(): Harness {
  const transport = createFakeTransport();
  const events: AgentEvent[] = [];
  const requests: InteractionRequest[] = [];
  const client = new OmpRpcClient(
    transport,
    () => undefined,
    () => undefined,
  );
  const translator = new OmpTranslator({ logger: createConsoleLogger('omp-handle-test') });
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
  const handle = new OmpSessionHandle({
    sessionId: '',
    model: 'MiniMax-M2',
    providerId: 'cindy',
    workingDir: 'C:\\work',
    approvalMode: 'always-ask',
    host,
    translator,
    bridge,
    logger: createConsoleLogger('omp-handle-test'),
  });
  handle.adoptSessionFile('C:\\omp-home\\sessions\\abc.jsonl');
  return {
    handle,
    transport,
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
    expect(seen.map((event) => event.type)).toEqual(['text', 'status', 'done']);
    await test.handle.close({ reason: 'navigation' });
    await consuming;
  });

  it('rejects a mid-session permission-mode change instead of pretending it applied', async () => {
    const test = harness();
    await expect(test.handle.setPermissionMode()).rejects.toThrow(/not supported/i);
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
