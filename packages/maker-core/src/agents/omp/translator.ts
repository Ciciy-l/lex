import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent, AgentEventType, UsageSnapshot } from '../../types/events.js';
import { isOmpRecord } from './commands.js';
import { parseOmpUiRequest, type OmpUiRequest } from './permission-bridge.js';

/**
 * OMP RPC 帧 → Lex `AgentEvent` 的投影层。
 *
 * 边界（架构 §1.1-2）：低层 OMP 帧**不是**可信 GUI DTO。每一帧都在这里按类型
 * 逐项校验后投影；未知/畸形/重复的帧丢弃并落脱敏日志，绝不透传到事件流。
 *
 * 真机依据：`docs/omp-rpc-spike.md` §4（事件顺序）、§5（错误帧）、§9.4（工具
 * 事件流）、§9.5（`message_update` 子类型）。
 */

/** 工具输出上界：OMP 单帧可达 1 MiB，GUI 只拿有界截断（架构 §3.4-3）。 */
export const OMP_TOOL_OUTPUT_LIMIT = 30_000;
/** 错误信息上界：OMP 已自带 key 遮蔽，我们仍不透原文。 */
export const OMP_ERROR_MESSAGE_LIMIT = 2_000;
const MAX_FRAME_TEXT = 200_000;
const PREVIEW_LIMIT = 400;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/giu,
  /\b(?:x-)?api[-_]?key["'\s:=]+[A-Za-z0-9._-]{8,}\b/giu,
  /\b[A-Fa-f0-9]{32,}\b/gu,
];

/** 脱敏：OMP 自己会遮蔽 key 前缀，这里再做一层，避免任何疑似凭证进 UI / 日志。 */
export function redactOmpText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

function readString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  return value.length > limit ? value.slice(0, limit) : value;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isOmpRecord(value) ? value : undefined;
}

function readNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n… [truncated by Lex]`, truncated: true };
}

/** 工具结果可能是字符串、Anthropic 式 content 数组或任意对象。 */
export function stringifyOmpToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isOmpRecord(value)) {
    const content = value.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (isOmpRecord(item) && typeof item.text === 'string') parts.push(item.text);
      }
      if (parts.length > 0) return parts.join('\n');
    }
    if (typeof value.text === 'string') return value.text;
  }
  if (value === undefined || value === null) return '';
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : '';
  } catch {
    return '';
  }
}

/** `message.content` 可能是字符串或 block 数组；只取文本，不透传其它形态。 */
export function extractOmpMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!isOmpRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

export type OmpTranslation =
  /** 已知但无需投影的帧（心跳、握手、未知子类型）。 */
  | { readonly kind: 'ignored' }
  /** 投影出的事件；调用方负责 push 到事件队列。 */
  | { readonly kind: 'events'; readonly events: readonly AgentEvent[] }
  /** 交互帧 —— **不进事件流**，交给 permission-bridge（架构 §3.7）。 */
  | { readonly kind: 'ui-request'; readonly request: OmpUiRequest };

export interface OmpTranslatorOptions {
  readonly logger: Logger;
  /** 上下文窗口；未知为 0（renderer 有兜底）。 */
  readonly contextWindow?: number;
}

/**
 * 有状态的帧投影器。
 *
 * 一个 translator 只服务一个会话（防串台：会话切换时必须重建，架构 §3.7）。
 */
export class OmpTranslator {
  private streaming = false;
  private readonly seenMessageEnds = new Set<string>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolPaths = new Map<string, string>();
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private costUsd = 0;
  private contextWindow: number;
  private streamedTextInTurn = false;
  private turnText = '';

  constructor(private readonly options: OmpTranslatorOptions) {
    this.contextWindow = options.contextWindow ?? 0;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  /** 会话内最后一次 assistant 文本（`done.result` 用；没有流式文本时为空）。 */
  getTurnText(): string {
    return this.turnText;
  }

  setContextWindow(value: number): void {
    if (Number.isSafeInteger(value) && value >= 0) this.contextWindow = value;
  }

  getUsageSnapshot(): UsageSnapshot {
    const tokenUsage = this.inputTokens + this.outputTokens;
    const contextTokens =
      this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
    return {
      tokenUsage,
      contextTokens: contextTokens > 0 ? contextTokens : 0,
      contextWindow: this.contextWindow,
      costUsd: this.costUsd,
      outputTokens: this.outputTokens,
      generationActive: this.streaming,
    };
  }

  translate(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    const type = readString(frame.type, 128);
    if (type === undefined) {
      this.options.logger.warn('omp frame without a usable type was dropped');
      return { kind: 'ignored' };
    }
    switch (type) {
      case 'ready':
      case 'turn_start':
      case 'message_start':
        return { kind: 'ignored' };
      case 'extension_ui_request':
        return this.translateUiRequest(frame);
      case 'agent_start':
        return this.translateAgentStart();
      case 'message_update':
        return this.translateMessageUpdate(frame);
      case 'message_end':
        return this.translateMessageEnd(frame);
      case 'tool_execution_start':
        return this.translateToolStart(frame);
      case 'tool_execution_update':
        return this.translateToolUpdate(frame);
      case 'tool_execution_end':
        return this.translateToolEnd(frame);
      case 'agent_end':
        return this.translateAgentEnd(frame);
      case 'auto_compaction_start':
      case 'auto_compaction_end':
        return this.translateCompaction(type);
      case 'auto_retry_start':
        return { kind: 'events', events: [this.status('Retrying after a provider error', true)] };
      case 'auto_retry_end':
        return { kind: 'ignored' };
      case 'omp_prompt_failure':
        return this.translatePromptFailure(frame);
      case 'error':
        return this.translateErrorFrame(frame);
      default:
        this.options.logger.debug('omp frame type is not projected', { type });
        return { kind: 'ignored' };
    }
  }

  private event(
    type: AgentEventType,
    data: unknown,
    agentMeta?: Record<string, unknown>,
  ): AgentEvent {
    return {
      type,
      data,
      source: 'omp',
      ...(agentMeta === undefined ? {} : { agentMeta }),
    };
  }

  private status(status: string, isRunning: boolean): AgentEvent {
    return this.event('status', { status, isRunning, ...this.getUsageSnapshot() });
  }

  private translateUiRequest(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    const request = parseOmpUiRequest(frame);
    if (!request) {
      // 不合法帧 → 不响应、不进事件流（架构 §4.3-1）。
      this.options.logger.warn('omp interaction frame failed validation and was dropped');
      return { kind: 'ignored' };
    }
    return { kind: 'ui-request', request };
  }

  private translateAgentStart(): OmpTranslation {
    this.streaming = true;
    this.streamedTextInTurn = false;
    this.turnText = '';
    return { kind: 'events', events: [this.status('OMP is working', true)] };
  }

  private translateMessageUpdate(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    // spike §9.5：子类型在 `assistantMessageEvent` 里；`event` 是防御性兜底。
    const sub = readRecord(frame.assistantMessageEvent) ?? readRecord(frame.event);
    const subType = sub === undefined ? undefined : readString(sub.type, 128);
    if (sub === undefined || subType === undefined) return { kind: 'ignored' };
    const delta = readString(sub.delta ?? sub.text, MAX_FRAME_TEXT);
    const blockId =
      readString(sub.contentIndex, 64) ??
      readString(sub.id, 128) ??
      readString(sub.toolCallId, 256) ??
      `omp-${subType}`;

    switch (subType) {
      case 'thinking_delta':
        if (!delta) return { kind: 'ignored' };
        return {
          kind: 'events',
          events: [this.event('thinking', { stage: 'delta', blockId, text: delta })],
        };
      case 'text_delta':
        if (!delta) return { kind: 'ignored' };
        this.streamedTextInTurn = true;
        this.turnText += delta;
        return {
          kind: 'events',
          events: [this.event('text', { text: delta, isFinal: false })],
        };
      case 'thinking_end':
      case 'text_start':
      case 'toolcall_start':
      case 'toolcall_end':
        // 块级边界事件：GUI 靠 delta 累加即可，重复发块事件会造出空块。
        return { kind: 'ignored' };
      case 'toolcall_delta':
        // 工具参数增量：真实参数在 `tool_execution_start` 的 `args` 里已完整给出，
        // 这里再发 tool_use 会让 UI 出现重复工具卡 —— 故意丢弃。
        return { kind: 'ignored' };
      default:
        return { kind: 'ignored' };
    }
  }

  private translateMessageEnd(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    const message = readRecord(frame.message);
    if (!message) return { kind: 'ignored' };
    // 防串台：同一个 message_end 重复出现（重放 / 续接重投影）只认第一次。
    const dedupeKey = readString(message.id, 256) ?? readString(message.clientId, 256);
    if (dedupeKey !== undefined) {
      if (this.seenMessageEnds.has(dedupeKey)) {
        this.options.logger.warn('omp duplicate message_end was dropped', {
          messageId: dedupeKey,
        });
        return { kind: 'ignored' };
      }
      this.seenMessageEnds.add(dedupeKey);
    }
    this.applyUsage(message);

    const role = readString(message.role, 32);
    const stopReason = readString(message.stopReason, 64);
    if (stopReason === 'error') {
      this.streaming = false;
      const raw =
        readString(message.errorMessage, MAX_FRAME_TEXT) ??
        readString(message.error, MAX_FRAME_TEXT) ??
        'OMP reported an error';
      const messageText = redactOmpText(raw).slice(0, OMP_ERROR_MESSAGE_LIMIT);
      return {
        kind: 'events',
        events: [
          this.event(
            'error',
            {
              message: messageText,
              isTerminal: true,
              ...(readString(message.errorStatus, 64) === undefined
                ? {}
                : { reason: `omp:${readString(message.errorStatus, 64)}` }),
            },
            { role, stopReason },
          ),
        ],
      };
    }
    if (role !== 'assistant') return { kind: 'ignored' };

    const events: AgentEvent[] = [];
    // 没有收到任何 text_delta（例如错误重试或非流式路径）时才补一条完整文本，
    // 否则 UI 会把已流式渲染的内容重复一遍。
    if (!this.streamedTextInTurn) {
      const full = extractOmpMessageText(message);
      if (full) {
        this.turnText = full;
        events.push(
          this.event(
            'text',
            { text: full, isFinal: true, isFullText: true },
            { role, stopReason, usage: message.usage },
          ),
        );
      }
    }
    return events.length === 0 ? { kind: 'ignored' } : { kind: 'events', events };
  }

  private translateToolStart(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    const toolUseId = readString(frame.toolCallId, 256) ?? '';
    const toolName = readString(frame.toolName, 256) ?? 'tool';
    const input = readRecord(frame.args) ?? {};
    const intent = readString(frame.intent, 8_192);
    if (toolUseId) this.toolNames.set(toolUseId, toolName);
    return {
      kind: 'events',
      events: [
        this.event('tool_use', {
          toolUseId,
          toolName,
          input,
          ...(intent === undefined ? {} : { intent }),
        }),
      ],
    };
  }

  private translateToolUpdate(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    const toolUseId = readString(frame.toolCallId, 256) ?? '';
    const details = readRecord(frame.details);
    const resolvedPath = details === undefined ? undefined : readString(details.resolvedPath, 4096);
    if (toolUseId && resolvedPath !== undefined) this.toolPaths.set(toolUseId, resolvedPath);
    const partial = stringifyOmpToolResult(frame.partialResult);
    if (!partial) return { kind: 'ignored' };
    const bounded = truncate(partial, OMP_TOOL_OUTPUT_LIMIT);
    return {
      kind: 'events',
      events: [
        this.event('tool_result_full', {
          toolUseId,
          fullText: bounded.text,
          isError: false,
          partial: true,
          ...(resolvedPath === undefined ? {} : { resolvedPath }),
        }),
      ],
    };
  }

  private translateToolEnd(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    const toolUseId = readString(frame.toolCallId, 256) ?? '';
    const isError = frame.isError === true;
    const raw = stringifyOmpToolResult(frame.result);
    const bounded = truncate(raw, OMP_TOOL_OUTPUT_LIMIT);
    const resolvedPath = this.toolPaths.get(toolUseId);
    this.toolPaths.delete(toolUseId);
    this.toolNames.delete(toolUseId);
    return {
      kind: 'events',
      events: [
        this.event('tool_result_full', {
          toolUseId,
          fullText: bounded.text,
          isError,
          ...(bounded.truncated ? { truncated: true } : {}),
          ...(resolvedPath === undefined ? {} : { resolvedPath }),
        }),
        this.event('tool_result', {
          toolUseIds: [toolUseId],
          summary: isError ? 'failed' : 'done',
        }),
      ],
    };
  }

  private translateAgentEnd(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    // spike §4：`isTerminal` 是终态标志；显式 false 表示还有后续 turn。
    if (frame.isTerminal === false) return { kind: 'ignored' };
    this.streaming = false;
    const result = this.turnText ? this.turnText.slice(0, PREVIEW_LIMIT * 8) : undefined;
    return {
      kind: 'events',
      events: [
        // Desktop persists the effective context window from the terminal
        // status boundary. Keep this before done so the product turn stays
        // attributed until its final usage snapshot has been observed.
        this.status('Done', false),
        this.event(
          'done',
          { ...(result === undefined ? {} : { result }) },
          { ...this.getUsageSnapshot() },
        ),
      ],
    };
  }

  private translateCompaction(type: string): OmpTranslation {
    if (type === 'auto_compaction_start') {
      return {
        kind: 'events',
        events: [this.event('compact_boundary', { phase: 'start' })],
      };
    }
    return {
      kind: 'events',
      events: [this.event('compact_boundary', { phase: 'end' })],
    };
  }

  /** rpc-client 在 prompt 明确失败时合成的帧（不是上游协议字段）。 */
  private translatePromptFailure(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    this.streaming = false;
    const raw = readString(frame.message, MAX_FRAME_TEXT) ?? 'OMP prompt failed';
    return {
      kind: 'events',
      events: [
        this.event('error', {
          message: redactOmpText(raw).slice(0, OMP_ERROR_MESSAGE_LIMIT),
          isTerminal: true,
        }),
      ],
    };
  }

  /** 上游若直接发 `error` 帧（spike 未抓到，防御性分支）。 */
  private translateErrorFrame(frame: Readonly<Record<string, unknown>>): OmpTranslation {
    this.streaming = false;
    const raw =
      readString(frame.message, MAX_FRAME_TEXT) ??
      readString(frame.errorMessage, MAX_FRAME_TEXT) ??
      'OMP reported an error';
    return {
      kind: 'events',
      events: [
        this.event('error', {
          message: redactOmpText(raw).slice(0, OMP_ERROR_MESSAGE_LIMIT),
          isTerminal: true,
        }),
      ],
    };
  }

  private applyUsage(message: Record<string, unknown>): void {
    const usage = readRecord(message.usage);
    if (usage) {
      this.inputTokens += readNumber(usage.input);
      this.outputTokens += readNumber(usage.output);
      this.cacheReadTokens += readNumber(usage.cacheRead);
      this.cacheWriteTokens += readNumber(usage.cacheWrite);
    }
    // OMP 的 cost 形状未在 spike 中抓到（只看到字段存在）；取不到就保持 0，
    // 绝不猜一个"看起来像钱"的数。
    const cost = readRecord(message.cost);
    if (cost) this.costUsd += readNumber(cost.total);
  }
}
