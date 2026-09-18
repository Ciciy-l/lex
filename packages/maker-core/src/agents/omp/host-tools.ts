import type { Logger } from '../../interfaces/logger.js';
import type {
  OmpHostToolDefinition,
  OmpHostToolResult,
} from '../../interfaces/mcp-provider.js';
import { isOmpRecord } from './commands.js';

/**
 * Host-tool side of OMP's RPC bridge.
 *
 * This stays deliberately independent of Orca, Desktop, and MCP SDK classes:
 * maker-core only validates a fixed startup snapshot and executes the exact
 * registered handler.  The host chooses what a tool means through
 * `McpProvider.toOmpRpcHostTools`; OMP frames never select an arbitrary host
 * operation.
 */

const MAX_HOST_TOOLS = 32;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 16_384;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_PENDING_HOST_TOOLS = 32;
const MAX_TOOL_RESULT_PARTS = 64;
const MAX_TOOL_RESULT_TEXT_LENGTH = 256 * 1024;
const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/u;

export interface OmpHostToolBridgeOptions {
  readonly logger: Logger;
  /** Write a terminal result to the OMP RPC peer. */
  readonly respond: (id: string, result: OmpHostToolResult) => void;
}

function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || !value || value.length > limit || value.includes('\0'))
    return undefined;
  if (Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) return undefined;
  return value;
}

function validateDefinition(value: OmpHostToolDefinition): OmpHostToolDefinition {
  const name = safeText(value?.name, MAX_TOOL_NAME_LENGTH);
  const description = safeText(value?.description, MAX_TOOL_DESCRIPTION_LENGTH);
  if (!name || !SAFE_TOOL_NAME.test(name) || !description)
    throw new Error('Invalid OMP host tool definition');
  if (!isOmpRecord(value.parameters)) throw new Error('Invalid OMP host tool definition');
  let schema: string;
  try {
    schema = JSON.stringify(value.parameters);
  } catch {
    throw new Error('Invalid OMP host tool definition');
  }
  if (typeof schema !== 'string' || Buffer.byteLength(schema, 'utf8') > MAX_TOOL_SCHEMA_BYTES)
    throw new Error('Invalid OMP host tool definition');
  if (typeof value.execute !== 'function') throw new Error('Invalid OMP host tool definition');
  const label = value.label === undefined ? undefined : safeText(value.label, MAX_TOOL_NAME_LENGTH);
  if (value.label !== undefined && label === undefined)
    throw new Error('Invalid OMP host tool definition');
  return Object.freeze({
    name,
    ...(label === undefined ? {} : { label }),
    description,
    parameters: Object.freeze({ ...value.parameters }),
    execute: value.execute,
  });
}

function failure(message: string): OmpHostToolResult {
  return Object.freeze({
    content: Object.freeze([{ type: 'text' as const, text: message }]),
    isError: true,
  });
}

function normalizeResult(value: unknown): OmpHostToolResult | undefined {
  if (!isOmpRecord(value) || !Array.isArray(value.content) || value.content.length > MAX_TOOL_RESULT_PARTS)
    return undefined;
  const content: Array<{ type: 'text'; text: string }> = [];
  let total = 0;
  for (const part of value.content) {
    if (!isOmpRecord(part) || part.type !== 'text') return undefined;
    const body = safeText(part.text, MAX_TOOL_RESULT_TEXT_LENGTH);
    if (body === undefined) return undefined;
    total += Buffer.byteLength(body, 'utf8');
    if (total > MAX_TOOL_RESULT_TEXT_LENGTH) return undefined;
    content.push({ type: 'text', text: body });
  }
  if (content.length === 0 || (value.isError !== undefined && value.isError !== true && value.isError !== false))
    return undefined;
  return Object.freeze({
    content: Object.freeze(content),
    ...(value.isError === true ? { isError: true } : {}),
  });
}

function readCall(frame: Readonly<Record<string, unknown>>):
  | { ok: true; id: string; toolName: string; arguments_: Readonly<Record<string, unknown>> }
  | { ok: false; id?: string } {
  const id = safeText(frame.id, 256);
  const toolCallId = safeText(frame.toolCallId, 256);
  const toolName = safeText(frame.toolName, MAX_TOOL_NAME_LENGTH);
  if (!id || !toolCallId || !toolName || !SAFE_TOOL_NAME.test(toolName) || !isOmpRecord(frame.arguments))
    return { ok: false, ...(id === undefined ? {} : { id }) };
  return { ok: true, id, toolName, arguments_: Object.freeze({ ...frame.arguments }) };
}

/**
 * Routes `host_tool_call` / `host_tool_cancel` frames.  Calls are independent
 * from normal prompt RPC requests: a handler failure becomes a bounded tool
 * result and never closes stdout or interferes with OMP's tail-frame drain.
 */
export class OmpHostToolBridge {
  private readonly tools: ReadonlyMap<string, OmpHostToolDefinition>;
  private readonly pending = new Map<string, AbortController>();
  private closed = false;

  constructor(
    tools: readonly OmpHostToolDefinition[],
    private readonly options: OmpHostToolBridgeOptions,
  ) {
    if (tools.length > MAX_HOST_TOOLS) throw new Error('OMP host tool limit exceeded');
    const entries = new Map<string, OmpHostToolDefinition>();
    for (const tool of tools) {
      const normalized = validateDefinition(tool);
      if (entries.has(normalized.name)) throw new Error('Duplicate OMP host tool name');
      entries.set(normalized.name, normalized);
    }
    this.tools = entries;
  }

  definitions(): readonly Pick<OmpHostToolDefinition, 'name' | 'label' | 'description' | 'parameters'>[] {
    return Object.freeze(Array.from(this.tools.values(), (tool) => Object.freeze({
      name: tool.name,
      ...(tool.label === undefined ? {} : { label: tool.label }),
      description: tool.description,
      parameters: tool.parameters,
    })));
  }

  /** Returns true for frames owned by the host-tool protocol, including malformed ones. */
  handleFrame(frame: Readonly<Record<string, unknown>>): boolean {
    if (frame.type === 'host_tool_cancel') {
      const targetId = safeText(frame.targetId, 256);
      if (targetId) this.pending.get(targetId)?.abort();
      return true;
    }
    if (frame.type !== 'host_tool_call') return false;
    const call = readCall(frame);
    if (!call.ok) {
      if (call.id) this.respond(call.id, failure('OMP host tool invocation was rejected'));
      return true;
    }
    if (this.closed) {
      this.respond(call.id, failure('OMP host tool bridge is closed'));
      return true;
    }
    if (this.pending.has(call.id) || this.pending.size >= MAX_PENDING_HOST_TOOLS) {
      this.respond(call.id, failure('OMP host tool invocation was rejected'));
      return true;
    }
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      this.respond(call.id, failure('OMP host tool is unavailable'));
      return true;
    }

    const controller = new AbortController();
    this.pending.set(call.id, controller);
    void Promise.resolve()
      .then(() => tool.execute(call.arguments_, { signal: controller.signal }))
      .then((result) => {
        const normalized = normalizeResult(result);
        this.settle(call.id, normalized ?? failure('OMP host tool returned an invalid result'));
      })
      .catch(() => {
        this.settle(call.id, failure('OMP host tool execution failed'));
      });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }

  private settle(id: string, result: OmpHostToolResult): void {
    if (!this.pending.delete(id) || this.closed) return;
    this.respond(id, result);
  }

  private respond(id: string, result: OmpHostToolResult): void {
    try {
      this.options.respond(id, result);
    } catch {
      // A process/transport close races with async tool completion normally.
      // Do not turn it into an unhandled rejection or tear down the read side.
      this.options.logger.debug('omp host tool result could not be delivered');
    }
  }
}
