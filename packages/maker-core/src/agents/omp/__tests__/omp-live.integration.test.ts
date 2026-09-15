/**
 * OMP 真机端到端集成测试 —— 真 spawn `omp.exe` + 本地回显 provider。
 *
 * 这一组用例证明的不是「代码能编译」,而是「OMP 真的能跑起来一次对话」:
 * 走 `OmpAgent` 的真实代码路径(spawn → RPC 握手 → new_session → prompt →
 * 帧投影 → 权限桥),provider 是本机 loopback 的 Anthropic messages 兼容回显
 * 服务器,因此不依赖外网与真实 key。
 *
 * 覆盖的四条能力边界:
 *  1. `startSession` 成功(子进程起来、握手完成、拿到会话文件);
 *  2. `send()` 后收到流式文本增量并最终收敛;
 *  3. 工具审批走 Lex 权限链:allow / deny / **不挂 resolver 时 fail-closed**;
 *  4. `abort()` 能中断正在进行的 turn。
 *
 * 真机事实(见 `docs/omp-rpc-spike.md` §9/§10):
 *  - 工具审批帧是 `method:'select'`,`options`形如 `["Approve","Deny"]`;
 *  - read tier 被 OMP 自动放行、根本不发帧,所以「没收到帧」不能当授权证据;
 *  - 被拒后 OMP 会换路径重试(write → bash → eval),这是上游行为,不是绕过权限。
 *
 * 依赖 `apps/omp-bin/<platform>/omp.exe` 就位(`pnpm install:omp`);二进制缺失
 * 时整组 skip(未 opt-in 的环境不红)。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { OmpAgent } from '../index.js';
import { buildOmpCindyModelsYaml, OMP_CINDY_API_KEY_ENV } from '../models-config.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import type {
  AgentEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
} from '../../../types/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const OMP_BINARY = path.join(
  REPO_ROOT,
  'apps',
  'omp-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'omp.exe' : 'omp',
);
const ompAvailable = existsSync(OMP_BINARY);

const MODEL_ID = 'omp-live-model';
const PROXY_KEY = 'omp-live-proxy-key';
const SESSION_ID = 'omp-live-session';

/** 每轮 provider 响应剧本;请求按顺序消费,用尽后重复最后一条。 */
interface TurnScript {
  /** 流式文本增量;非空时 assistant 先说这些片段。 */
  readonly textChunks?: readonly string[];
  /** 请求执行的工具(Anthropic tool_use block)。 */
  readonly toolUse?: {
    readonly id: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
  };
  /** 每个 SSE 分片之间的延迟(毫秒),用于构造"慢流"以便中断。 */
  readonly chunkDelayMs?: number;
}

interface CapturedRequest {
  readonly url: string;
  readonly authorization: string;
  readonly stream: boolean;
  readonly body: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}

function readStringField(value: unknown, key: string): string | undefined {
  const found = toRecord(value)[key];
  return typeof found === 'string' ? found : undefined;
}

/** 事件流里所有 `text` 事件的文本拼接(流式增量 + 兜底全量)。 */
function concatenatedText(events: readonly AgentEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type !== 'text') continue;
    const text = readStringField(event.data, 'text');
    if (text !== undefined) parts.push(text);
  }
  return parts.join('');
}

function countType(events: readonly AgentEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

/** `send()` 收的是 `UserMessage`,不是裸字符串。 */
function userText(text: string): { type: 'user'; content: string } {
  return { type: 'user', content: text };
}

/** 按判别式收窄到 permission 形态(不用 as)。 */
function asPermission(
  request: InteractionRequest,
): { toolName: string; metadata: Record<string, unknown> } | undefined {
  if (request.kind !== 'permission') return undefined;
  return { toolName: request.toolName, metadata: request.metadata ?? {} };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ── 本地回显 provider ────────────────────────────────────────────────────────

class FakeOmpProvider {
  private server: Server | undefined;
  private scriptIndex = 0;
  private mutableScript: readonly TurnScript[] = [];
  readonly requests: CapturedRequest[] = [];

  get port(): number {
    const address = this.server?.address();
    if (address !== null && typeof address === 'object' && address !== undefined) {
      return address.port;
    }
    throw new Error('fake OMP provider is not listening');
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  setScript(script: readonly TurnScript[]): void {
    this.mutableScript = script;
    this.scriptIndex = 0;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    let stream = false;
    try {
      const parsed: unknown = JSON.parse(body);
      stream = toRecord(parsed).stream === true;
    } catch {
      stream = false;
    }
    this.requests.push({
      url: req.url ?? '/',
      authorization: String(req.headers.authorization ?? ''),
      stream,
      body,
    });
    if (process.env.OMP_LIVE_DEBUG === '1') {
      console.log(`[provider] ${req.method ?? 'GET'} ${req.url ?? '/'} stream=${String(stream)}`);
      console.log(`[provider] body=${body.slice(0, 1200)}`);
    }

    const script = this.mutableScript[Math.min(this.scriptIndex, this.mutableScript.length - 1)];
    this.scriptIndex += 1;
    if (stream) await this.writeStream(res, script);
    else this.writeJson(res, script);
  }

  private contentBlocks(script: TurnScript): unknown[] {
    const blocks: unknown[] = [];
    let index = 0;
    for (const chunk of script.textChunks ?? []) {
      blocks.push({ type: 'text', text: chunk, index });
      index += 1;
    }
    const toolUse = script.toolUse;
    if (toolUse !== undefined) {
      blocks.push({
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: { ...toolUse.input },
        index,
      });
      index += 1;
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '', index: 0 });
    return blocks;
  }

  private stopReason(script: TurnScript): string {
    return script.toolUse === undefined ? 'end_turn' : 'tool_use';
  }

  private writeJson(res: ServerResponse, script: TurnScript): void {
    const payload = JSON.stringify({
      id: `msg_live_${String(this.scriptIndex)}`,
      type: 'message',
      role: 'assistant',
      model: MODEL_ID,
      content: this.contentBlocks(script),
      stop_reason: this.stopReason(script),
      stop_sequence: null,
      usage: {
        input_tokens: 16,
        output_tokens: 8,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  }

  private async writeStream(res: ServerResponse, script: TurnScript): Promise<void> {
    const messageId = `msg_live_${String(this.scriptIndex)}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 16, output_tokens: 1 },
      },
    });

    const delay = script.chunkDelayMs ?? 0;
    let index = 0;
    for (const chunk of script.textChunks ?? []) {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: chunk },
      });
      send('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
      if (delay > 0) await sleep(delay);
    }
    const toolUse = script.toolUse;
    if (toolUse !== undefined) {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) },
      });
      send('content_block_stop', { type: 'content_block_stop', index });
    }
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason(script), stop_sequence: null },
      usage: { output_tokens: 8 },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }
}

// ── 测试夹具 ─────────────────────────────────────────────────────────────────

const provider = new FakeOmpProvider();
const sandboxes: string[] = [];

function makeSandbox(): { home: string; workingDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-live-'));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  const workingDir = path.join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  return { home, workingDir };
}

function buildDeps(home: string): AgentDeps {
  return {
    auth: {
      getState: async () => ({ authenticated: true, identity: 'omp-live', authSource: 'api-key' }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: {},
    binaryPath: OMP_BINARY,
    logger: silentLogger,
    resolveOmpAgentHome: () => home,
    // 与 desktop host 同口径:凭证只给值、不落盘(models.yml 里只有 env 名)。
    resolveOmpCredentials: () => ({ proxyKey: PROXY_KEY, sessionId: SESSION_ID }),
    resolveOmpModelsYaml: (context) =>
      buildOmpCindyModelsYaml({
        baseUrl: provider.baseUrl,
        api: 'anthropic-messages',
        sessionId: SESSION_ID,
        models: [{ id: context.model, name: context.model, input: ['text'] }],
      }),
  };
}

interface LiveSession {
  readonly handle: AgentSessionHandle;
  readonly events: AgentEvent[];
  readonly workingDir: string;
  readonly drained: Promise<void>;
  close(): Promise<void>;
}

async function startLiveSession(workingDir: string): Promise<LiveSession> {
  const sandbox = makeSandbox();
  const agent = new OmpAgent(buildDeps(sandbox.home));
  const handle = await agent.startSession({
    sessionId: SESSION_ID,
    workingDir,
    model: MODEL_ID,
    permissionMode: 'ask',
  });
  const events: AgentEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events()) events.push(event);
  })();
  return {
    handle,
    events,
    workingDir,
    drained,
    close: async () => {
      await handle.close();
      await drained;
    },
  };
}

beforeAll(async () => {
  if (ompAvailable) await provider.start();
});

afterEach(() => {
  provider.setScript([]);
});

afterAll(async () => {
  await provider.stop();
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe.skipIf(!ompAvailable)('OmpAgent live end-to-end (real omp binary)', () => {
  it(
    'starts a session and streams assistant text back through the translator',
    { timeout: 120_000 },
    async () => {
      const workingDir = makeSandbox().workingDir;
      provider.setScript([{ textChunks: ['HELLO-', 'OMP-', 'LIVE-STREAM'] }]);
      const live = await startLiveSession(workingDir);
      try {
        // 1) 会话文件必须真的落盘(id = OMP 会话文件绝对路径,架构 §5)。
        expect(live.handle.id.length).toBeGreaterThan(0);
        expect(existsSync(live.handle.id)).toBe(true);

        await live.handle.send(userText('say hello'));

        // 2) 至少 2 条流式增量 → 证明走的是流式通道而不是一次性全量。
        await waitUntil(() => countType(live.events, 'text') >= 2, 60_000, 'streaming text deltas');
        await waitUntil(
          () => countType(live.events, 'done') > 0 || countType(live.events, 'error') > 0,
          60_000,
          'turn completion',
        );

        const text = concatenatedText(live.events);
        expect(countType(live.events, 'text')).toBeGreaterThanOrEqual(2);
        expect(text).toContain('HELLO-OMP-LIVE-STREAM');
        expect(countType(live.events, 'done')).toBeGreaterThan(0);

        // 3) 凭证通道:models.yml 只写 env 名,值经子进程 env 注入 → 回显服务器
        //    应当看到 `Authorization: Bearer <proxyKey>`(spike §10 实测行为)。
        expect(provider.requests.length).toBeGreaterThan(0);
        expect(provider.requests[0]?.authorization).toBe(`Bearer ${PROXY_KEY}`);
      } finally {
        await live.close();
      }
    },
  );

  it(
    'routes a tool approval through the Lex permission chain (allow)',
    { timeout: 120_000 },
    async () => {
      const workingDir = makeSandbox().workingDir;
      const target = path.join(workingDir, 'approved-target.txt');
      provider.setScript([
        {
          textChunks: ['writing now'],
          toolUse: {
            id: 'toolu_live_allow',
            name: 'write',
            input: { path: 'approved-target.txt', content: 'APPROVED-BY-LEX' },
          },
        },
        { textChunks: ['ALL-DONE'] },
        { textChunks: ['ALL-DONE'] },
        { textChunks: ['ALL-DONE'] },
      ]);

      const seen: InteractionRequest[] = [];
      const resolver: InteractionResolver = async (request) => {
        seen.push(request);
        const decision: InteractionDecision = { kind: 'permission', behavior: 'allow' };
        return decision;
      };

      const live = await startLiveSession(workingDir);
      live.handle.setInteractionResolver(resolver);
      try {
        await live.handle.send(userText('create approved-target.txt'));

        // 审批帧必须真的到达 resolver(不是"没收到帧"的假通过)。
        await waitUntil(() => seen.length > 0, 60_000, 'an InteractionRequest');
        const first = seen[0];
        if (first === undefined) throw new Error('no InteractionRequest reached the resolver');
        const permission = asPermission(first);
        expect(first.kind).toBe('permission');
        expect(permission?.metadata.source).toBe('omp');

        await waitUntil(
          () => concatenatedText(live.events).includes('ALL-DONE'),
          60_000,
          'post-approval text',
        );

        // allow 之后 OMP 应当真的执行了写文件。
        await waitUntil(() => existsSync(target), 60_000, 'the approved write to land');
        expect(permission?.toolName.length ?? 0).toBeGreaterThan(0);
      } finally {
        await live.close();
      }
    },
  );

  it(
    'honours a deny decision: OMP receives the refusal and does not execute',
    { timeout: 120_000 },
    async () => {
      const workingDir = makeSandbox().workingDir;
      const target = path.join(workingDir, 'denied-target.txt');
      provider.setScript([
        {
          toolUse: {
            id: 'toolu_live_deny',
            name: 'write',
            input: { path: 'denied-target.txt', content: 'SHOULD-NOT-EXIST' },
          },
        },
        { textChunks: ['GAVE-UP'] },
        { textChunks: ['GAVE-UP'] },
        { textChunks: ['GAVE-UP'] },
      ]);

      const seen: InteractionRequest[] = [];
      const resolver: InteractionResolver = async (request) => {
        seen.push(request);
        const decision: InteractionDecision = { kind: 'permission', behavior: 'deny' };
        return decision;
      };

      const live = await startLiveSession(workingDir);
      live.handle.setInteractionResolver(resolver);
      try {
        await live.handle.send(userText('create denied-target.txt'));

        await waitUntil(() => seen.length > 0, 60_000, 'an InteractionRequest');
        // 拒绝被上游换路径重试(write → bash → eval)是已知的上游行为,重试同样
        // 会被 resolver 拒掉;等到轮次收敛再断言副作用。
        await waitUntil(
          () =>
            concatenatedText(live.events).includes('GAVE-UP') ||
            countType(live.events, 'error') > 0 ||
            seen.length >= 3,
          60_000,
          'the denied turn to settle',
        );
        await sleep(2_000);

        expect(seen.length).toBeGreaterThan(0);
        expect(existsSync(target)).toBe(false);
        // OMP 侧应当看到一次失败的工具结果(拒绝),而不是静默成功。
        const deniedResult = live.events.some(
          (event) => event.type === 'tool_result_full' && toRecord(event.data).isError === true,
        );
        expect(deniedResult).toBe(true);
      } finally {
        await live.close();
      }
    },
  );

  it(
    'fails closed when no interaction resolver is attached',
    { timeout: 120_000 },
    async () => {
      const workingDir = makeSandbox().workingDir;
      const target = path.join(workingDir, 'noresolver-target.txt');
      provider.setScript([
        {
          toolUse: {
            id: 'toolu_live_noresolver',
            name: 'write',
            input: { path: 'noresolver-target.txt', content: 'SHOULD-NOT-EXIST' },
          },
        },
        { textChunks: ['GAVE-UP'] },
        { textChunks: ['GAVE-UP'] },
        { textChunks: ['GAVE-UP'] },
      ]);

      const live = await startLiveSession(workingDir);
      // 刻意不调用 setInteractionResolver:没有权限链 = 没有授权源。
      try {
        await live.handle.send(userText('create noresolver-target.txt'));
        await waitUntil(
          () =>
            concatenatedText(live.events).includes('GAVE-UP') ||
            countType(live.events, 'error') > 0 ||
            countType(live.events, 'tool_result_full') > 0,
          60_000,
          'the fail-closed turn to settle',
        );
        await sleep(3_000);

        // 关键断言:没有 resolver 时工具一次都没被放行 → 文件不存在。
        expect(existsSync(target)).toBe(false);
        const anySuccess = live.events.some(
          (event) => event.type === 'tool_result_full' && toRecord(event.data).isError !== true,
        );
        expect(anySuccess).toBe(false);
      } finally {
        await live.close();
      }
    },
  );

  it(
    'abort() interrupts an in-flight turn',
    { timeout: 120_000 },
    async () => {
      const workingDir = makeSandbox().workingDir;
      const chunks = Array.from({ length: 40 }, (_unused, index) => `C${String(index)}-`);
      provider.setScript([{ textChunks: chunks, chunkDelayMs: 400 }]);

      const live = await startLiveSession(workingDir);
      try {
        await live.handle.send(userText('stream forever'));
        await waitUntil(() => countType(live.events, 'text') >= 1, 60_000, 'the first delta');
        const seenBeforeAbort = countType(live.events, 'text');

        await live.handle.abort();
        await sleep(5_000);

        const seenAfterAbort = countType(live.events, 'text');
        expect(seenBeforeAbort).toBeGreaterThan(0);
        // 中断生效:后续分片不再到达(否则说明 abort 没起作用)。
        expect(seenAfterAbort - seenBeforeAbort).toBeLessThan(5);
        expect(concatenatedText(live.events).length).toBeLessThan(
          chunks.join('').length,
        );
      } finally {
        await live.close();
      }
    },
  );
});

describe('OmpAgent live test prerequisites', () => {
  it('reports whether the managed OMP binary is present (informational)', () => {
    // 二进制缺失时上面整组 skip;这条常量用例让「跳过」在报告里可见,
    // 而不是让集成分级静默地什么都不跑。
    expect(typeof ompAvailable).toBe('boolean');
    expect(OMP_BINARY.endsWith('omp.exe') || OMP_BINARY.endsWith('omp')).toBe(true);
  });

  it('keeps the session secret out of the materialized models.yml', () => {
    // 与 desktop host 的 assertOmpModelsYamlHasNoSecrets 同口径:落盘文件里
    // 只有 apiKey 的 env **名**,绝不出现值(值只进子进程 env)。
    const yaml = buildOmpCindyModelsYaml({
      baseUrl: 'http://127.0.0.1:1',
      api: 'anthropic-messages',
      sessionId: SESSION_ID,
      models: [{ id: MODEL_ID, name: MODEL_ID, input: ['text'] }],
    });
    expect(yaml).toContain(OMP_CINDY_API_KEY_ENV);
    expect(yaml).not.toContain(PROXY_KEY);
  });
});
