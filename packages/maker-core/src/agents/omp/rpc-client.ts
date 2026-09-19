import { isOmpRecord } from './commands.js';
import { OMP_MAX_FRAME_BYTES } from './jsonl-reader.js';

export interface OmpRpcTransport {
  /** Local stdio writes synchronously; SSH writes can settle asynchronously. */
  writeLine(line: string): void | Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

/** 无载荷请求；带 message / path / 标识符的请求在下面各自展开并单独校验。 */
type OmpRpcRequestType =
  | 'get_available_commands'
  | 'get_state'
  | 'abort'
  | 'new_session'
  | 'compact'
  | 'get_messages';

/** OMP v18.1.18 RPC `set_host_tools` payload (the executable shape only). */
export interface OmpRpcHostToolDefinition {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type OmpRpcRequest =
  | { type: OmpRpcRequestType }
  | { type: 'prompt' | 'steer' | 'follow_up'; message: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'export_html'; outputPath: string }
  | { type: 'set_host_tools'; tools: readonly OmpRpcHostToolDefinition[] };

export interface OmpRpcResponse {
  type: 'response';
  id: string;
  command: OmpRpcRequest['type'];
  success: true;
  data?: unknown;
}

export type OmpUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true; timedOut?: boolean };

/**
 * 交互响应的关联信息。v18.1.18 的 `extension_ui_request` 帧**没有**
 * `requestGeneration`（spike §9.2 实证），因此这里全部字段可选：
 * 帧里有才 echo，没有就不带 —— 既不盲信文档，也不丢弃已出现的字段。
 */
export interface OmpUiCorrelation {
  requestGeneration?: unknown;
}

interface PendingRequest {
  command: OmpRpcRequest['type'];
  resolve: (response: OmpRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_REQUESTS = 64;
const REQUEST_TYPES = new Set([
  'get_available_commands',
  'get_state',
  'abort',
  'prompt',
  'steer',
  'follow_up',
  'new_session',
  'switch_session',
  'set_model',
  'set_thinking_level',
  'compact',
  'export_html',
  'get_messages',
  'set_host_tools',
]);

// 文本载荷的上界刻意比帧上界(1 MiB)宽：真正卡住大消息的是 encode() 的字节检查，
// 这里只拦"明显不合理"的长度，避免与既有 1 MiB 帧错误语义分叉。
const MAX_REQUEST_TEXT_LENGTH = 1_000_000;

function requestText(value: unknown, name: string, limit: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > limit ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid OMP RPC ${name}`);
  }
  return value;
}

const HOST_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const MAX_HOST_TOOLS = 32;
const MAX_HOST_TOOL_SCHEMA_BYTES = 64 * 1024;

function hostToolText(value: unknown, name: string, limit: number): string {
  const text = requestText(value, name, limit);
  if (Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new Error(`Invalid OMP RPC ${name}`);
  }
  return text;
}

function hostToolDefinitions(value: unknown): OmpRpcHostToolDefinition[] {
  if (!Array.isArray(value) || value.length > MAX_HOST_TOOLS)
    throw new Error('Invalid OMP RPC host tools');
  const names = new Set<string>();
  return value.map((candidate) => {
    if (!isOmpRecord(candidate) || !isOmpRecord(candidate.parameters))
      throw new Error('Invalid OMP RPC host tools');
    const name = hostToolText(candidate.name, 'host tool name', 128);
    if (!HOST_TOOL_NAME.test(name) || names.has(name))
      throw new Error('Invalid OMP RPC host tools');
    names.add(name);
    const description = hostToolText(candidate.description, 'host tool description', 16_384);
    const label = candidate.label === undefined
      ? undefined
      : hostToolText(candidate.label, 'host tool label', 128);
    let parameters: string;
    try {
      parameters = JSON.stringify(candidate.parameters);
    } catch {
      throw new Error('Invalid OMP RPC host tools');
    }
    if (typeof parameters !== 'string' || Buffer.byteLength(parameters, 'utf8') > MAX_HOST_TOOL_SCHEMA_BYTES)
      throw new Error('Invalid OMP RPC host tools');
    return {
      name,
      ...(label === undefined ? {} : { label }),
      description,
      parameters: candidate.parameters,
    };
  });
}

function hostToolResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (!isOmpRecord(value) || !Array.isArray(value.content) || value.content.length === 0 || value.content.length > 64)
    throw new Error('Invalid OMP host tool result');
  let bytes = 0;
  const content = value.content.map((part) => {
    if (!isOmpRecord(part) || part.type !== 'text')
      throw new Error('Invalid OMP host tool result');
    const text = hostToolText(part.text, 'host tool result text', 256 * 1024);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 256 * 1024) throw new Error('Invalid OMP host tool result');
    return { type: 'text' as const, text };
  });
  return { content };
}

/**
 * 按请求类型组装并校验载荷。每个新类型都走自己的校验，
 * 与 `prompt` 的 `message` 校验同范式（不允许把任意对象透传到子进程）。
 */
function buildRequestPayload(
  command: OmpRpcRequest,
  id: string,
): Record<string, unknown> {
  switch (command.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
      return {
        type: command.type,
        id,
        message: requestText(command.message, command.type, MAX_REQUEST_TEXT_LENGTH),
      };
    case 'switch_session':
      return {
        type: command.type,
        id,
        sessionPath: requestText(command.sessionPath, 'switch_session', 4096),
      };
    case 'set_model':
      return {
        type: command.type,
        id,
        provider: requestText(command.provider, 'set_model provider', 256),
        modelId: requestText(command.modelId, 'set_model modelId', 256),
      };
    case 'set_thinking_level':
      return {
        type: command.type,
        id,
        level: requestText(command.level, 'set_thinking_level', 64),
      };
    case 'export_html':
      return {
        type: command.type,
        id,
        outputPath: requestText(command.outputPath, 'export_html', 4096),
      };
    case 'set_host_tools':
      return { type: command.type, id, tools: hostToolDefinitions(command.tools) };
    default:
      return { type: command.type, id };
  }
}

/** v18.1.18 不存在该字段；未来若出现则原样 echo，避免旧响应套到新请求上。 */
function isEchoableGeneration(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string') return false;
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32)
  );
}

export class OmpRpcClient {
  private sequence = 0;
  private closed = false;
  private acceptingRequests = true;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly prompts = new Set<string>();
  /** UI 请求 id → 该请求帧携带的 requestGeneration（帧里没有就不登记）。 */
  private readonly generations = new Map<string, unknown>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly transport: OmpRpcTransport,
    private readonly onEvent: (
      event: Readonly<Record<string, unknown>>,
    ) => void,
    private readonly onClosed: () => void,
  ) {
    try {
      this.registerCleanup(transport.onLine((line) => this.receive(line)));
      if (!this.closed)
        this.registerCleanup(transport.onClose(() => this.close()));
    } catch {
      this.close();
    }
  }

  request(
    command: OmpRpcRequest,
    timeoutMs = 30_000,
  ): { id: string; response: Promise<OmpRpcResponse> } {
    if (this.closed) throw new Error('OMP RPC is closed');
    if (!this.acceptingRequests) throw new Error('OMP RPC is draining');
    if (
      !isOmpRecord(command) ||
      !REQUEST_TYPES.has(command.type) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600_000
    ) {
      throw new Error('Invalid OMP RPC request');
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error('OMP RPC request limit reached');
    if (command.type === 'prompt' && this.prompts.size >= MAX_PENDING_REQUESTS)
      throw new Error('OMP unresolved prompt limit reached');
    if (command.type === 'prompt' && typeof command.message !== 'string')
      throw new Error('Invalid OMP prompt');
    const id = 'omp-' + ++this.sequence;
    // 校验 + 组装在此收口：未知类型不可能进入 REQUEST_TYPES，载荷字段逐个校验。
    const payload = buildRequestPayload(command, id);
    const line = this.encode(payload);
    if (command.type === 'prompt') this.prompts.add(id);
    const response = new Promise<OmpRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error('OMP RPC request timed out; execution outcome is unknown'),
        );
      }, timeoutMs);
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      this.writeTransportLine(line);
    });
    return { id, response };
  }

  respondToUi(
    id: string,
    response: OmpUiResponse,
    correlation?: OmpUiCorrelation,
  ): void {
    if (this.closed) throw new Error('OMP RPC is closed');
    if (!this.acceptingRequests) throw new Error('OMP RPC is draining');
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 256 ||
      Array.from(id).some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new Error('Invalid OMP interaction identity');
    }
    if (!isOmpRecord(response))
      throw new Error('Invalid OMP interaction response');
    const variants = ['value', 'confirmed', 'cancelled'].filter(
      (key) => key in response,
    );
    if (variants.length !== 1)
      throw new Error('Invalid OMP interaction response');
    const allowedKeys =
      variants[0] === 'cancelled' ? ['cancelled', 'timedOut'] : variants;
    if (Object.keys(response).some((key) => !allowedKeys.includes(key))) {
      throw new Error('Invalid OMP interaction response');
    }
    let payload: Record<string, unknown>;
    if ('cancelled' in response && response.cancelled === true) {
      if (
        response.timedOut !== undefined &&
        typeof response.timedOut !== 'boolean'
      ) {
        throw new Error('Invalid OMP interaction response');
      }
      payload = {
        cancelled: true,
        ...(response.timedOut === true ? { timedOut: true } : {}),
      };
    } else if ('value' in response && typeof response.value === 'string') {
      payload = { value: response.value };
    } else if (
      'confirmed' in response &&
      typeof response.confirmed === 'boolean'
    ) {
      payload = { confirmed: response.confirmed };
    } else {
      throw new Error('Invalid OMP interaction response');
    }
    // requestGeneration：v18.1.18 的帧里不存在（spike §9.2 实证），因此默认不带；
    // 只有"请求帧里确实出现过"才 echo，且优先取调用方显式传入的快照。
    // 调用方显式传了 correlation 就以它为准(允许用它把 generation 显式置空);
    // 没传才退回"请求帧里出现过什么就 echo 什么"。
    const generation =
      correlation !== undefined ? correlation.requestGeneration : this.generations.get(id);
    const out: Record<string, unknown> = { ...payload };
    if (generation !== undefined) {
      if (!isEchoableGeneration(generation))
        throw new Error('Invalid OMP interaction correlation');
      out.requestGeneration = generation;
    }
    this.generations.delete(id);
    const line = this.encode({ ...out, type: 'extension_ui_response', id });
    if (!this.writeTransportLine(line)) {
      throw new Error('OMP interaction transport failed');
    }
  }

  /** Complete an OMP RPC host-tool call without creating a normal request slot. */
  respondToHostTool(
    id: string,
    result: { readonly content: readonly { readonly type: 'text'; readonly text: string }[] },
    isError?: boolean,
  ): void {
    if (this.closed) throw new Error('OMP RPC is closed');
    if (!this.acceptingRequests) throw new Error('OMP RPC is draining');
    const callId = hostToolText(id, 'host tool call identity', 256);
    const normalized = hostToolResult(result);
    if (isError !== undefined && typeof isError !== 'boolean')
      throw new Error('Invalid OMP host tool result');
    const line = this.encode({
      type: 'host_tool_result',
      id: callId,
      result: normalized,
      ...(isError === true ? { isError: true } : {}),
    });
    if (!this.writeTransportLine(line)) {
      throw new Error('OMP host tool transport failed');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('OMP RPC closed; execution outcome is unknown'));
    }
    this.pending.clear();
    this.prompts.clear();
    this.generations.clear();
    for (const unsubscribe of this.unsubscribe.splice(0))
      this.cleanup(unsubscribe);
    this.cleanup(this.onClosed);
  }

  releasePrompt(id: string): void {
    this.prompts.delete(id);
  }

  stopAcceptingRequests(): void {
    this.acceptingRequests = false;
  }

  private cleanup(callback: () => void): void {
    try {
      callback();
    } catch {
      return;
    }
  }

  private registerCleanup(callback: () => void): void {
    if (this.closed) this.cleanup(callback);
    else this.unsubscribe.push(callback);
  }

  private emit(event: Readonly<Record<string, unknown>>): void {
    try {
      this.onEvent(event);
    } catch {
      this.close();
    }
  }

  /**
   * Own asynchronous SSH write failures immediately.  Otherwise the rejected
   * transport promise would be detached from its pending RPC response and can
   * surface as an unhandled rejection in the Desktop main process.
   */
  private writeTransportLine(line: string): boolean {
    try {
      const write = this.transport.writeLine(line);
      if (write && typeof (write as PromiseLike<void>).then === 'function') {
        void Promise.resolve(write).catch(() => this.close());
      }
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  private encode(payload: Record<string, unknown>): string {
    const line = JSON.stringify(payload);
    if (Buffer.byteLength(line, 'utf8') > OMP_MAX_FRAME_BYTES)
      throw new Error('OMP RPC frame exceeds limit');
    return line;
  }

  private receive(line: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(line, 'utf8') > OMP_MAX_FRAME_BYTES) {
      this.close();
      return;
    }
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.close();
      return;
    }
    if (!isOmpRecord(event) || typeof event.type !== 'string') {
      this.close();
      return;
    }
    if (event.type === 'rpc_chunk') {
      this.close();
      return;
    }
    // 我们自己的响应若被服务端 echo 回来，绝不能当成新的 UI 请求再走一遍事件流。
    if (
      event.type === 'extension_ui_response' ||
      event.type === 'host_tool_result' ||
      event.type === 'host_tool_update'
    ) return;
    if (event.type === 'extension_ui_request') {
      const requestId = event.id;
      if (typeof requestId === 'string' && requestId && requestId.length <= 256) {
        const generation = event.requestGeneration;
        if (generation === undefined) this.generations.delete(requestId);
        else if (isEchoableGeneration(generation))
          this.generations.set(requestId, generation);
      }
    }
    if (event.type !== 'response') {
      this.emit(event);
      return;
    }
    if (typeof event.id !== 'string') return;
    const pending = this.pending.get(event.id);
    if (!pending) {
      if (!this.prompts.has(event.id)) return;
      if (event.command !== 'prompt' || typeof event.success !== 'boolean') {
        this.close();
        return;
      }
      if (!event.success) {
        this.prompts.delete(event.id);
        this.emit({
          type: 'omp_prompt_failure',
          id: event.id,
          command: 'prompt',
          message: 'OMP prompt execution failed',
        });
      }
      return;
    }
    if (
      event.command !== pending.command ||
      typeof event.success !== 'boolean'
    ) {
      this.close();
      return;
    }
    this.pending.delete(event.id);
    clearTimeout(pending.timer);
    if (!event.success) {
      this.prompts.delete(event.id);
      pending.reject(new Error('OMP RPC command failed'));
    } else
      pending.resolve({
        type: 'response',
        id: event.id,
        command: pending.command,
        success: true,
        data: event.data,
      });
  }
}
