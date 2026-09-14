import type { Logger } from '../../interfaces/logger.js';
import type {
  AgentEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
} from '../../types/events.js';
import type { OmpUiCorrelation, OmpUiResponse } from './rpc-client.js';

/**
 * OMP 交互帧 ↔ Lex `InteractionResolver` 的桥。
 *
 * 三条铁律（架构 §4.2）在此落地：
 *  1. **Lex 权限链是唯一授权源**。桥里不存在"自动 allow"路径 —— 没有 resolver、
 *     resolver 抛错、决策形态不对、无法在 OMP 给的 options 里定位到"同意"选项，
 *     一律回 `{cancelled:true}`（= 拒绝），而不是放行。
 *  2. **禁止名称等价映射**。同意/拒绝选项按 `classifyOptions` 的显式模式识别，
 *     识别不出来就不猜。
 *  3. **禁止谎报保护**。OMP 在 `always-ask` 下仍自动放行 read tier（spike §9.3
 *     真机实证），那些调用根本不会走到这里 —— 没收到请求 ≠ 已被 Lex 授权。
 *
 * 真机事实（spike §9.2）：工具审批帧是 `method:'select'`，`options:["Approve","Deny"]`，
 * 应答必须用 `{value:<option 字符串>}`；误回 `{confirmed:true}` 会被 OMP 判为 deny。
 */

/** 单会话同时只允许 1 个 pending；第二个到达立即 cancelled（架构 §4.3-2）。 */
const MAX_PENDING_INTERACTIONS = 1;

export const OMP_INTERACTION_DEFAULT_TIMEOUT_MS = 30_000;
export const OMP_INTERACTION_MAX_TIMEOUT_MS = 60_000;

const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 8_192;
const MAX_OPTION_LENGTH = 256;
const MAX_OPTIONS = 32;

/** 帧里 `title` 的形如 "Allow tool: write\nPath: hello.txt\nContent:\nhi"。 */
const TOOL_TITLE = /^\s*Allow tool:\s*([^\n\r]+)/iu;
const PATH_LINE = /^\s*Path:\s*(.+)$/u;

const APPROVE_OPTION = /^(?:approve|allow|yes|y|ok|confirm|run|continue)$/iu;
const DENY_OPTION = /^(?:deny|reject|no|n|cancel|decline|skip|abort|stop)$/iu;

export interface OmpUiRequest {
  /** OMP 帧 id（16 位 hex）；应答时必须原样带回。 */
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly options?: readonly string[];
  /** 帧里没有 `requestGeneration` 时为 undefined（v18.1.18 实证没有）。 */
  readonly requestGeneration?: unknown;
  /** 帧自带的超时（毫秒）；未协商时取默认。 */
  readonly timeoutMs: number;
}

/**
 * 解析 `extension_ui_request` 帧。
 *
 * fail-closed：任何一个必要字段不合法 → 返回 undefined，调用方**不响应**
 * （架构 §4.3-1：未登记 id / 帧不合法 → 不响应 + 脱敏日志）。
 */
export function parseOmpUiRequest(frame: unknown): OmpUiRequest | undefined {
  if (!isOmpInteractionRecord(frame)) return undefined;
  const record = frame;
  if (record.type !== 'extension_ui_request') return undefined;
  const id = record.id;
  if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) return undefined;
  if (Array.from(id).some((char) => char.charCodeAt(0) < 32)) return undefined;
  const method = record.method;
  if (typeof method !== 'string' || !method || method.length > 128) return undefined;
  const rawTitle = record.title;
  const title =
    typeof rawTitle === 'string' && !rawTitle.includes('\0')
      ? rawTitle.slice(0, MAX_TITLE_LENGTH)
      : undefined;
  const rawOptions = record.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .filter(
          (option): option is string =>
            typeof option === 'string' && option.length > 0 && option.length <= MAX_OPTION_LENGTH,
        )
        .slice(0, MAX_OPTIONS)
    : undefined;
  return {
    id,
    method,
    ...(title === undefined ? {} : { title }),
    ...(options === undefined ? {} : { options }),
    requestGeneration: record.requestGeneration,
    timeoutMs: resolveTimeout(record.timeout),
  };
}

/**
 * `select` 帧的 options 里哪个是"同意"、哪个是"拒绝"。
 *
 * 识别不出来就返回空 —— 调用方据此 fail-closed 拒绝，绝不按位置或大小写猜。
 */
export function classifyOmpOptions(
  options: readonly string[] | undefined,
): { approve?: string; deny?: string } {
  if (!options || options.length === 0) return {};
  let approve: string | undefined;
  let deny: string | undefined;
  for (const option of options) {
    if (approve === undefined && APPROVE_OPTION.test(option.trim())) approve = option;
    else if (deny === undefined && DENY_OPTION.test(option.trim())) deny = option;
  }
  return { ...(approve === undefined ? {} : { approve }), ...(deny === undefined ? {} : { deny }) };
}

export interface OmpApprovalDescriptor {
  readonly toolName: string;
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * 把 OMP 的审批 `title` 解析成权限卡能展示的字段。
 *
 * `title` 是上游给人看的一段文本，不是结构化协议字段 —— 这里只做**展示用**的
 * 最佳努力解析，解析不出来就整段作为描述，绝不因为解析失败而拒绝或放行。
 */
export function describeOmpApproval(title: string | undefined): OmpApprovalDescriptor {
  if (typeof title !== 'string' || !title) {
    return { toolName: 'unknown', description: '', input: {} };
  }
  const lines = title.split(/\r?\n/u);
  const matched = TOOL_TITLE.exec(lines[0] ?? '');
  const toolName = (matched?.[1] ?? '').trim() || 'unknown';
  const input: Record<string, unknown> = { rawTitle: title };
  let path: string | undefined;
  for (const line of lines.slice(1)) {
    const found = PATH_LINE.exec(line);
    if (found && path === undefined) path = found[1]?.trim();
  }
  if (path !== undefined && path.length > 0) input.path = path;
  const description = lines
    .slice(matched ? 1 : 0)
    .join('\n')
    .trim();
  return { toolName, description, input };
}

export interface OmpPermissionBridgeOptions {
  readonly logger: Logger;
  /** 写回 OMP（`rpc-client.respondToUi` 的薄包装，允许抛错）。 */
  readonly respond: (
    id: string,
    response: OmpUiResponse,
    correlation?: OmpUiCorrelation,
  ) => void;
  /** 事件出口（只有 `interaction_dismissed` 会用到）。 */
  readonly emit: (event: AgentEvent) => void;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
}

interface PendingInteraction {
  readonly request: OmpUiRequest;
  readonly requestId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * OMP 交互帧 → Lex 权限链。
 *
 * 生命周期：帧到达 → `handleRequest`；会话 abort/close → `dismissAll`；
 * 挂起期间用户升档 → `dismissAll(reason, 'allow')`（架构 §4.3-5）。
 */
export class OmpPermissionBridge {
  private readonly pending = new Map<string, PendingInteraction>();
  private resolver: InteractionResolver | undefined;
  private interactionSequence = 0;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;

  constructor(private readonly options: OmpPermissionBridgeOptions) {
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? OMP_INTERACTION_DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? OMP_INTERACTION_MAX_TIMEOUT_MS;
  }

  setResolver(resolver: InteractionResolver): void {
    this.resolver = resolver;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 处理一个交互帧。异步内部完成，调用方不必 await（OMP 侧是请求/响应模型，
   * 我们持有 id 直到应答或超时）。
   */
  handleRequest(request: OmpUiRequest): void {
    const method = request.method;
    // `select`（工具审批）与 `confirm`（若上游未来改用）是权限语义；其余
    // （`input` 自由文本、`setWidget` 等 fire-and-forget）P0 一律拒绝，
    // 绝不把未知交互当作授权通道。
    if (method !== 'select' && method !== 'confirm') {
      this.options.logger.warn('omp interaction method is not bridged, cancelling', {
        method,
        id: request.id,
      });
      this.cancel(request, { reason: 'unsupported-method' });
      return;
    }

    const classify = method === 'select' ? classifyOmpOptions(request.options) : {};
    const approveOption = method === 'select' ? classify.approve : undefined;
    const denyOption = method === 'select' ? classify.deny : undefined;
    if (method === 'select' && approveOption === undefined) {
      // 认不出"同意"选项 —— 绝不猜位置，直接拒绝。
      this.options.logger.warn('omp approval options are unrecognized, cancelling', {
        id: request.id,
        options: request.options ?? [],
      });
      this.cancel(request, { reason: 'unrecognized-options' });
      return;
    }

    if (this.pending.size >= MAX_PENDING_INTERACTIONS) {
      this.options.logger.warn('omp interaction arrived while another is pending', {
        id: request.id,
        pending: this.pending.size,
      });
      this.cancel(request, { reason: 'concurrent-interaction' });
      return;
    }

    const requestId = `omp:${request.id}:${++this.interactionSequence}`;
    const descriptor = describeOmpApproval(request.title);
    const interaction: InteractionRequest = {
      kind: 'permission',
      requestId,
      toolName: descriptor.toolName,
      input: { ...descriptor.input },
      ...(descriptor.description ? { description: descriptor.description } : {}),
      ...(request.title === undefined ? {} : { title: request.title }),
      metadata: {
        source: 'omp',
        method,
        ...(request.options === undefined ? {} : { options: [...request.options] }),
      },
    };

    const timeoutMs = Math.min(
      Math.max(1, request.timeoutMs || this.defaultTimeoutMs),
      this.maxTimeoutMs,
    );
    const timer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return;
      this.options.logger.warn('omp interaction timed out, cancelling', {
        id: request.id,
        timeoutMs,
      });
      this.cancel(request, { reason: 'timeout', timedOut: true });
      this.options.emit({
        type: 'interaction_dismissed',
        data: { requestId, reason: 'timeout' },
        source: 'omp',
      });
    }, timeoutMs);
    this.pending.set(requestId, { request, requestId, timer });

    void this.runResolver(interaction, {
      method,
      approveOption,
      denyOption,
    });
  }

  /**
   * 结束全部挂起交互。
   *
   * `resolvedAs:'allow'` 只在**用户主动放宽档位**时使用（此时 OMP 已按新档位
   * 重启，原本要问的调用本来就不需要再问）；其余一律拒绝。
   */
  dismissAll(reason: string, resolvedAs?: 'allow' | 'deny'): void {
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of snapshot) {
      clearTimeout(entry.timer);
      const { request } = entry;
      const method = request.method;
      const approveOption =
        method === 'select' ? classifyOmpOptions(request.options).approve : undefined;
      if (resolvedAs === 'allow' && method === 'confirm') {
        this.respond(request, { confirmed: true });
      } else if (resolvedAs === 'allow' && approveOption !== undefined) {
        this.respond(request, { value: approveOption });
      } else {
        this.cancel(request, { reason });
      }
      this.options.emit({
        type: 'interaction_dismissed',
        data: {
          requestId: entry.requestId,
          reason,
          ...(resolvedAs === 'allow' ? { resolvedAs: 'allow' } : { resolvedAs: 'deny' }),
        },
        source: 'omp',
      });
    }
  }

  private async runResolver(
    interaction: InteractionRequest,
    shape: {
      method: string;
      approveOption: string | undefined;
      denyOption: string | undefined;
    },
  ): Promise<void> {
    const requestId = interaction.requestId;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    const { request } = entry;
    let decision: InteractionDecision;
    try {
      const resolver = this.resolver;
      // 没有 resolver = 没有权限链 = 没有授权源 → fail-closed 拒绝。
      if (!resolver) throw new Error('no interaction resolver is attached');
      decision = await resolver(interaction);
    } catch (error) {
      this.options.logger.warn('omp interaction resolver failed, denying', {
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.pending.delete(requestId)) {
        clearTimeout(entry.timer);
        this.cancel(request, { reason: 'resolver-failed' });
      }
      return;
    }
    if (!this.pending.delete(requestId)) {
      // 已被 dismissAll 收口（abort / 升档 / 超时）；不要再应答一次。
      return;
    }
    clearTimeout(entry.timer);

    if (decision.kind !== 'permission' || decision.behavior !== 'allow') {
      if (shape.method === 'select') {
        // 没有可识别的"拒绝"选项时也不能退回"同意" —— 直接取消。
        if (shape.denyOption === undefined) this.cancel(request, { reason: 'denied' });
        else this.respond(request, { value: shape.denyOption });
      } else {
        this.respond(request, { confirmed: false });
      }
      return;
    }
    if (shape.method === 'select') {
      if (shape.approveOption === undefined) this.cancel(request, { reason: 'denied' });
      else this.respond(request, { value: shape.approveOption });
      return;
    }
    this.respond(request, { confirmed: true });
  }

  private respond(request: OmpUiRequest, response: OmpUiResponse): void {
    try {
      this.options.respond(request.id, response, {
        requestGeneration: request.requestGeneration,
      });
    } catch (error) {
      this.options.logger.warn('omp interaction response failed', {
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private cancel(
    request: OmpUiRequest,
    options: { reason: string; timedOut?: boolean },
  ): void {
    try {
      this.options.respond(
        request.id,
        options.timedOut === true
          ? { cancelled: true, timedOut: true }
          : { cancelled: true },
        { requestGeneration: request.requestGeneration },
      );
    } catch (error) {
      this.options.logger.warn('omp interaction cancel failed', {
        id: request.id,
        reason: options.reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 与 `commands.ts` 的 `isOmpRecord` 同语义；这里自带一份避免协议层与交互层耦合。 */
export function isOmpInteractionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
