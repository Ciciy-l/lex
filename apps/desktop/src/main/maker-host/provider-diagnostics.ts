/**
 * provider-diagnostics —— 供应商「测试连接」探测（设置页 / 自定义供应商表单消费）。
 *
 * 设计要点：
 *   - **探测与真实会话同路由口径**：saved 模式从 active-catalog 取该供应商的 RoutingDescriptor
 *     （upstream / headerOverride）+ safeStorage 里的 per-runtime API key，与 provider-route.ts
 *     的 `api-key-header` 分支构造相同的 header 组合（cc 同时覆盖 x-api-key + authorization，
 *     codex 只覆盖 authorization）——测通了 = 真实请求也走得通，比裸 HEAD 探测可信。
 *   - **adhoc 模式**支持表单未保存值直接测（baseUrl / modelId / key 内存透传，不落任何盘）。
 *   - 最小探测请求：cc wire = `POST /v1/messages`（max_tokens=1）；codex wire = `POST /responses`
 *     （max_output_tokens=16, stream=false）。10s 超时。
 *   - 结果判定走 shared/providerErrors 的结构化分类器（与 Phase 2 会话内上游错误同一套口径）。
 *   - fetch 可注入（单测不联网）；key 读取器可注入（不直接 import safeStorage，模式同
 *     provider-route.setCustomProviderKeyReader，host 在 register 时接通）。
 */

import {
  appendProviderRequestPath,
  providerModelRecord,
  providerPresetModelRecord,
  providerWireProtocolForApi,
  type PiModelApi,
  type ProviderModelRecord,
  isAgentSelectableModel,
  isLoopbackProviderUrl,
  type AgentKind,
  type ProviderWireProtocol,
} from '@cindy/model-providers';
import { joinAnthropicMessagesUrl } from '@cindy/responses-anthropic-bridge';

import {
  classifyProviderError,
  type ProviderErrorClassification,
  type ProviderErrorCode,
} from '../../shared/providerErrors.js';
import {
  isReservedLexServerManagedIdentity,
  isReservedLexServerManagedProviderId,
} from '../../shared/lexServerManagedModels.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getActiveCatalog } from './active-catalog.js';
import { withOpenCodeGoSessionHeader } from './opencode-go-session.js';
import { outboundFetch } from './outbound-fetch.js';
import { hostCredentialEndpointAllowed, invocationModelRecord, probePiProvider, requiresNativeProviderAuth } from './pi-provider-transport.js';
import {
  buildRouteDecision,
  getProviderRouteCredentialRevision,
  isProviderRouteMutationInProgress,
  providerRoutingForModel,
  readHydratedProviderHeaders,
} from './provider-route.js';

/** 探测请求超时。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 失败响应体最多读取的字节数（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** 一次探测的完整参数（adhoc 直填；saved 由 resolve 得到）。 */
export interface ProviderProbeSpec {
  agent: AgentKind;
  baseUrl: string;
  modelId: string;
  /** 表单态鉴权方式；main IPC 用它强制 none 只访问 loopback。 */
  authMethod?: 'apiKey' | 'oauth' | 'none';
  /** 缺省按 agent 保持历史行为。 */
  wireProtocol?: ProviderWireProtocol;
  /** Actual SDK API; the four display protocols cannot identify Vertex/Azure transports. */
  api?: PiModelApi;
  catalogPresetId?: string;
  /** Main-only resolved model; never accepted from IPC. */
  nativeModel?: ProviderModelRecord;
  /** 非标准推理端点的精确相对路径。 */
  requestPath?: string;
  /** 用户 API key；缺省 = 不注入鉴权头（端点可能靠自定义 headers 鉴权）。 */
  apiKey?: string | null;
  /** 附加请求头（自定义供应商的 headers 配置）。 */
  headers?: Record<string, string>;
}

/**
 * Draft endpoint supplied with a saved probe. Main only uses it to prove the
 * form still targets the saved route; the probe itself, including credentials,
 * always follows the saved configuration.
 */
export interface SavedProbeEndpoint {
  baseUrl: string;
  wireProtocol: ProviderWireProtocol;
  modelsUrl?: string | null;
  requestPath?: string;
}

/** 测试入参：已保存供应商（key 从 safeStorage 读）或表单态 adhoc。 */
export type ProviderTestInput =
  | {
      kind: 'saved';
      providerId: string;
      agent: AgentKind;
      /** Draft model to probe; may not exist in the saved config yet. */
      modelId?: string;
      /** Draft endpoint; a mismatch rejects the probe before any key is read. */
      endpoint?: SavedProbeEndpoint;
    }
  | { kind: 'adhoc'; spec: ProviderProbeSpec };

/** 结构化测试结果（查询型返回：renderer 需要 code 渲染分类文案，不走 throwIpcError）。 */
export interface ProviderTestResult {
  ok: boolean;
  /** 失败分类码（ok=true 时缺省）。 */
  code?: ProviderErrorCode;
  /** HTTP 状态码（网络层失败时缺省）。 */
  status?: number;
  latencyMs: number;
  /** 上游原始信息摘要（详情展开用，UI 主文案走 i18n）。 */
  detail?: string;
}

// ── key 读取注入（同 provider-route 模式，避免纯逻辑单测触电 safeStorage）─────────
type KeyReader = (
  providerId: string,
  agent: AgentKind,
  protocol?: ProviderWireProtocol,
) => string | null;
let keyReader: KeyReader = () => null;

/** host 启动期接通真实 safeStorage 读取（`provider_key_<id>_<agent>`）。 */
export function setDiagnosticsKeyReader(reader: KeyReader): void {
  keyReader = reader;
}

function withoutCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower !== 'authorization' && lower !== 'x-api-key' && lower !== 'x-goog-api-key') normalized[lower] = value;
  }
  return normalized;
}

const HOST_ENVIRONMENT_APIS = new Set<PiModelApi>(['google-vertex', 'bedrock-converse-stream']);

function probeHasUserSecret(spec: ProviderProbeSpec): boolean {
  if (spec.apiKey?.trim()) return true;
  const headers = new Headers(spec.headers);
  return Boolean(headers.get('authorization') || headers.get('x-api-key') || headers.get('x-goog-api-key'));
}

/** Vertex/Bedrock can use Desktop ADC/IAM. Renderer-chosen URLs must not inherit those credentials. */
function hostEnvironmentApiAllowed(spec: ProviderProbeSpec, api: string): boolean {
  if (!HOST_ENVIRONMENT_APIS.has(api as PiModelApi)) return true;
  // Bedrock signs with Desktop IAM even when a dummy apiKey is present.
  if (api !== 'bedrock-converse-stream' && probeHasUserSecret(spec)) return true;
  return hostCredentialEndpointAllowed(api, spec.baseUrl);
}

function normalizedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

/** 构造探测请求（纯函数，单测直断言）。header 组合与 provider-route 的 api-key-header 分支对齐。 */
export function buildProbeRequest(spec: ProviderProbeSpec): { url: string; init: RequestInit } {
  const mustStripCredentialHeaders =
    !!spec.apiKey || spec.authMethod === 'none' || spec.authMethod === 'oauth';
  const headers = withOpenCodeGoSessionHeader(
    mustStripCredentialHeaders
      ? withoutCredentialHeaders(spec.headers)
      : normalizedHeaders(spec.headers),
    { providerId: spec.catalogPresetId ?? '', catalogPresetId: spec.catalogPresetId, upstream: spec.baseUrl },
  ) ?? {};
  headers['content-type'] = 'application/json';
  if (spec.wireProtocol === 'google-generative-ai') {
    if (spec.apiKey) headers['x-goog-api-key'] = spec.apiKey;
    return {
      url: appendProviderRequestPath(spec.baseUrl, spec.requestPath ?? `/models/${encodeURIComponent(spec.modelId.replace(/^models\//, ''))}:generateContent`),
      init: { method: 'POST', headers, body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }) },
    };
  }
  const anthropicMessages =
    spec.wireProtocol === 'anthropic-messages' ||
    (spec.wireProtocol === undefined && spec.agent === 'claude-code');
  if (anthropicMessages) {
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    if (spec.apiKey) {
      headers['x-api-key'] = spec.apiKey;
      headers['authorization'] = `Bearer ${spec.apiKey}`;
    }
    return {
      url: joinAnthropicMessagesUrl(spec.baseUrl, spec.requestPath ?? '/v1/messages'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: spec.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
    };
  }
  // codex：原生 Responses 或 Cindy 将承载的 Chat Completions 上游。
  if (spec.apiKey) headers['authorization'] = `Bearer ${spec.apiKey}`;
  if (spec.wireProtocol === 'openai-chat') {
    // 「测试连接」= 验证 endpoint + key + Chat 协议 + 流式可达,**不强制 tool_choice**:
    // 部分供应商的思考模型(如 DeepSeek deepseek-v4-pro)明确拒绝强制工具调用
    // (“Thinking mode does not support this tool_choice”),会把可达的端点误报成失败。
    // 工具调用能力交给真实会话验证(Codex 用 tool_choice:'auto',不强制)。
    return {
      url: appendProviderRequestPath(spec.baseUrl, spec.requestPath ?? '/chat/completions'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: spec.modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16,
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
    };
  }
  return {
    url: appendProviderRequestPath(spec.baseUrl, spec.requestPath ?? '/responses'),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: spec.modelId,
        input: 'ping',
        max_output_tokens: 16,
        stream: false,
        store: false,
      }),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the first non-empty SSE data frame so 200-streamed provider errors do not pass the probe. */
async function readFirstSsePayload(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let start = 0;
    let newline: number;
    while ((newline = buffer.indexOf('\n', start)) >= 0) {
      const line = buffer.slice(start, newline).replace(/\r$/, '');
      start = newline + 1;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload) return payload;
    }
    if (start > 0) buffer = buffer.slice(start);
    if (buffer.length > MAX_ERROR_BODY_BYTES) return null;
    if (done) {
      buffer += decoder.decode();
      const line = buffer.replace(/\r$/, '');
      if (!line.startsWith('data:')) return null;
      return line.slice(5).trim() || null;
    }
  }
}

/** Bounded body read; cancellation/locking is owned by readWithDeadlineReader. */
async function readBoundedBodyText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_ERROR_BODY_BYTES) {
    const next = await reader.read();
    if (next.done) break;
    const value = next.value;
    if (!value?.byteLength) continue;
    const take =
      value.byteLength > MAX_ERROR_BODY_BYTES - size
        ? value.subarray(0, MAX_ERROR_BODY_BYTES - size)
        : value;
    chunks.push(take);
    size += take.byteLength;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function classifyStreamedError(error: Record<string, unknown>): ProviderErrorClassification {
  const bodyText = JSON.stringify(error).slice(0, MAX_ERROR_BODY_BYTES);
  const explicitStatus =
    typeof error.status === 'number'
      ? error.status
      : typeof error.status_code === 'number'
        ? error.status_code
        : typeof error.code === 'number'
          ? error.code
          : undefined;
  const type = typeof error.type === 'string' ? error.type.toLowerCase() : '';
  const inferredStatus =
    explicitStatus ?? (type.includes('server') || type.includes('overload') ? 503 : 400);
  return classifyProviderError({ status: inferredStatus, bodyText });
}

/** 从 Error（fetch 抛出）提取网络层错误码。 */
function networkErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return err.name;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return cause.code;
    return err.name || 'UNKNOWN_NETWORK_ERROR';
  }
  return 'UNKNOWN_NETWORK_ERROR';
}

/** Redirect statuses a probe refuses to follow, regardless of origin. */
const PROBE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class RedirectBlockedError extends Error {
  constructor(readonly status: number) {
    super(`provider probe blocked a redirect (${status})`);
    this.name = 'RedirectBlockedError';
  }
}

/**
 * A 2xx alone is not a successful Gemini probe: captive portals and gateways
 * return HTML, and Google can return an error payload with HTTP 200. Require a
 * candidate with a text part; never echo the body into the result.
 */
function validateGoogleProbeResponse(
  bodyText: string,
  status: number,
  latencyMs: number,
): ProviderTestResult {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'WIRE_INCOMPATIBLE', status, latencyMs };
  }
  if (!isPlainObject(payload))
    return { ok: false, code: 'WIRE_INCOMPATIBLE', status, latencyMs };
  if (isPlainObject(payload.error)) {
    const error = payload.error;
    const errorStatus = typeof error.code === 'number' ? error.code : undefined;
    const message = typeof error.message === 'string' ? error.message : '';
    const cls = classifyProviderError({ status: errorStatus, bodyText: message });
    return { ok: false, code: cls.code, status: errorStatus ?? status, latencyMs };
  }
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const blockReason = isPlainObject(payload.promptFeedback)
      ? payload.promptFeedback.blockReason
      : undefined;
    return {
      ok: false,
      code: typeof blockReason === 'string' && blockReason ? 'RESPONSE_BLOCKED' : 'WIRE_INCOMPATIBLE',
      status,
      latencyMs,
    };
  }
  // Match the bundled Google SDK's stop semantics: it reads the first
  // candidate and only STOP / MAX_TOKENS are successful stop reasons. Any
  // other (or future) finishReason is a model-side stop, not a connection.
  const candidate = candidates[0];
  const hasText =
    isPlainObject(candidate) &&
    isPlainObject(candidate.content) &&
    Array.isArray(candidate.content.parts) &&
    candidate.content.parts.some(
      (part) => isPlainObject(part) && typeof part.text === 'string',
    );
  // The SDK checks the first candidate's stop reason before content: a
  // SAFETY/BLOCKLIST stop with empty content is a blocked model response, not
  // a protocol mismatch. Success reasons still require a usable text part.
  const finishReason = isPlainObject(candidate) ? candidate.finishReason : undefined;
  if (
    finishReason !== undefined &&
    finishReason !== null &&
    (typeof finishReason !== 'string' || !['STOP', 'MAX_TOKENS'].includes(finishReason))
  )
    return { ok: false, code: 'RESPONSE_BLOCKED', status, latencyMs };
  if (!hasText) return { ok: false, code: 'WIRE_INCOMPATIBLE', status, latencyMs };
  return { ok: true, latencyMs };
}

/** Walk a small error/cause chain for undici-style timeout codes. */
function hasTimeoutCode(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 3) return false;
  const code = (value as { code?: unknown }).code;
  if (
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  )
    return true;
  return hasTimeoutCode((value as { cause?: unknown }).cause, depth + 1);
}

/**
 * Timeout-like read errors. AbortError alone does not prove a timeout: only
 * the probe deadline firing turns an abort into TIMEOUT; other aborts keep a
 * non-timeout classification and follow the owner guard.
 */
function isReadTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error.name === 'TimeoutError' ||
    error.name === 'ReadTimeout' ||
    error.name === 'BodyTimeoutError'
  )
    return true;
  if (error.name === 'AbortError') return false;
  return hasTimeoutCode(error);
}

/**
 * Bound a body/SSE read by the same deadline as the fetch. On the deadline we
 * abort the reader (reader.cancel is best effort; a non-cooperative source may
 * never settle) so a locked body no longer blocks res.body.cancel(). The race
 * settles with the timeout even if the source keeps the reader pending.
 */
async function readWithDeadlineReader<T>(
  body: ReadableStream<Uint8Array>,
  deadline: AbortSignal,
  consume: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<T>,
): Promise<T> {
  const reader = body.getReader();
  // Best effort: never await a source that ignores cancellation. Release the
  // lock again once a cooperative cancel settles.
  const cancelReader = () => {
    void reader
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          /* a pending read keeps the lock until the source settles */
        }
      });
    try {
      reader.releaseLock();
    } catch {
      /* a pending read keeps the lock until the source settles */
    }
  };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancelReader();
      reject(deadline.reason ?? new DOMException('timeout', 'TimeoutError'));
    };
    if (deadline.aborted) onAbort();
    else deadline.addEventListener('abort', onAbort, { once: true });
  });
  const pending = consume(reader);
  pending.catch(() => undefined);
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort) deadline.removeEventListener('abort', onAbort);
    cancelReader();
  }
}

async function readBodyTextWithDeadline(res: Response, deadline: AbortSignal): Promise<string> {
  if (!res.body) return '';
  return readWithDeadlineReader(res.body, deadline, readBoundedBodyText);
}

async function readFirstSseWithDeadline(
  res: Response,
  deadline: AbortSignal,
): Promise<string | null> {
  if (!res.body) return null;
  return readWithDeadlineReader(res.body, deadline, readFirstSsePayload);
}

/** 跑一次探测请求并分类结果。fetch 可注入（单测）。 */
export async function runProviderProbe(
  spec: ProviderProbeSpec,
  // 默认吃系统代理:探测必须与真实会话同口径,否则代理用户会被误判成「连不通」。
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderTestResult> {
  if (spec.authMethod === 'none' && !isLoopbackProviderUrl(spec.baseUrl)) {
    throw new TypeError('no-auth provider probes require a loopback URL');
  }
  const start = Date.now();
  // Connection tests never follow redirects: a cross-origin 307/308 would
  // replay Main-only headers (x-api-key, custom secrets) to a second origin.
  // Both the direct and proxy outbound paths honor `manual`, so the second
  // origin is never contacted. Same-origin redirects are blocked too: enter the
  // final endpoint URL instead. The holder is per probe so native SDKs that
  // swallow the fetch error can still be classified without shared state.
  const redirectState: { status?: number } = {};
  // Last real HTTP response seen by a native SDK. SDKs often replace the HTTP
  // status with "UnknownError"; this is the trusted source for 4xx/5xx codes.
  const responseState: { status?: number } = {};
  const probeFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, { ...(init ?? {}), redirect: 'manual' });
    responseState.status = response.status;
    if (PROBE_REDIRECT_STATUSES.has(response.status)) {
      redirectState.status ??= response.status;
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new RedirectBlockedError(response.status);
    }
    return response;
  };
  const presetRow = providerPresetModelRecord(spec.catalogPresetId, spec.modelId, spec.api);
  const row = spec.nativeModel
    ?? providerModelRecord(spec.modelId, spec.baseUrl, spec.api ?? spec.wireProtocol)
    ?? (presetRow && (spec.api || !spec.wireProtocol || providerWireProtocolForApi(presetRow.execution.pi.api) === spec.wireProtocol)
      ? presetRow : undefined);
  const requestedApi = spec.api ?? row?.execution.pi.api;
  if (requestedApi && !hostEnvironmentApiAllowed(spec, requestedApi)) {
    return { ok: false, code: 'AUTH_INVALID', latencyMs: Date.now() - start,
      detail: 'native SDK probe requires a user credential or a matching saved preset endpoint' };
  }
  const api = requestedApi;
  // Native SDKs that accept an injected fetch use probeFetch. Vertex's SDK uses
  // its own HTTP client (rejects a custom fetch) and can follow redirects;
  // Bedrock's SDK neither accepts the probe fetch nor preserves a trusted HTTP
  // status in its adapter error. Neither can prove the no-redirect contract or
  // the real 3xx status here, so both refuse instead of risking credentials.
  // Google Generative AI itself uses the redirect-safe HTTP probe below.
  if (api === 'google-vertex' || api === 'bedrock-converse-stream') {
    return { ok: false, code: 'PROBE_UNSUPPORTED', latencyMs: Date.now() - start };
  }
  if (api && (['azure-openai-responses', 'mistral-conversations'].includes(api)
    || requiresNativeProviderAuth(row))) {
    const model = row ?? invocationModelRecord({ id: spec.modelId, name: spec.modelId,
      group: 'custom', contextWindow: 4096, maxOutput: 16, efforts: [], defaultEffort: null, api: api as PiModelApi }, spec.baseUrl)!;
    try {
      const result = await probePiProvider({ row: model, providerId: spec.catalogPresetId ?? 'custom-probe',
        upstream: spec.baseUrl, apiKey: spec.authMethod === 'none' ? '' : spec.apiKey
          ?? new Headers(spec.headers).get('authorization')?.replace(/^Bearer /i, '')
          ?? new Headers(spec.headers).get('x-goog-api-key')
          ?? new Headers(spec.headers).get('x-api-key') ?? '',
        headers: spec.apiKey || spec.authMethod === 'none' ? withoutCredentialHeaders(spec.headers) : spec.headers,
        fetchImpl: probeFetch,
      }, AbortSignal.timeout(PROBE_TIMEOUT_MS));
      // Some SDKs turn the fetch rejection into an error result; the marker
      // records the real redirect status without parsing their error text.
      if (redirectState.status !== undefined)
        return { ok: false, code: 'REDIRECT_BLOCKED', status: redirectState.status, latencyMs: Date.now() - start };
      if (result.stopReason !== 'error' && result.stopReason !== 'aborted') return { ok: true, latencyMs: Date.now() - start };
      const detail = result.errorMessage ?? 'Native provider probe failed';
      // Prefer the response status actually seen by probeFetch. SDKs replace
      // 401/403/429/5xx with strings such as "Mistral API error (401)" or
      // "UnknownError"; trusting the body text alone loses the real status.
      const observed = responseState.status;
      if (observed !== undefined && (observed < 200 || observed >= 300)) {
        if (PROBE_REDIRECT_STATUSES.has(observed))
          return {
            ok: false,
            code: 'REDIRECT_BLOCKED',
            status: observed,
            latencyMs: Date.now() - start,
          };
        const cls = classifyProviderError({
          status: observed,
          bodyText: detail,
          ...(result.stopReason === 'aborted' ? { networkErrorCode: 'AbortError' } : {}),
        });
        return {
          ok: false,
          code: cls.code,
          status: observed,
          latencyMs: Date.now() - start,
          detail: cls.detail,
        };
      }
      const statusMatch = detail.match(/(?:status|code)["\s:]+([345]\d\d)\b|^([345]\d\d)(?:\s|:)/);
      const status = statusMatch ? Number(statusMatch[1] ?? statusMatch[2]) : undefined;
      if (status !== undefined && PROBE_REDIRECT_STATUSES.has(status))
        return { ok: false, code: 'REDIRECT_BLOCKED', status, latencyMs: Date.now() - start };
      const cls = classifyProviderError({ status, bodyText: detail,
        ...(result.stopReason === 'aborted' ? { networkErrorCode: 'AbortError' } : {}) });
      return { ok: false, code: cls.code, status, latencyMs: Date.now() - start, detail: cls.detail };
    } catch (err) {
      if (redirectState.status !== undefined)
        return { ok: false, code: 'REDIRECT_BLOCKED', status: redirectState.status, latencyMs: Date.now() - start };
      if (err instanceof RedirectBlockedError)
        return { ok: false, code: 'REDIRECT_BLOCKED', status: err.status, latencyMs: Date.now() - start };
      const cls = classifyProviderError({ networkErrorCode: networkErrorCode(err) });
      return { ok: false, code: cls.code, latencyMs: Date.now() - start, detail: cls.detail };
    }
  }
  // A Google Generative AI model may arrive with only `api` set (legacy or
  // programmatic callers); keep the HTTP probe on the Gemini wire shape.
  const httpSpec =
    api === 'google-generative-ai' && !spec.wireProtocol
      ? { ...spec, wireProtocol: 'google-generative-ai' as const }
      : spec;
  const { url, init } = buildProbeRequest(httpSpec);
  // One deadline for the fetch and every subsequent body/SSE read; a slow body
  // must not get a fresh 10s budget after the response headers arrive.
  const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await probeFetch(url, { ...init, signal: deadline });
  } catch (err) {
    if (err instanceof RedirectBlockedError)
      return { ok: false, code: 'REDIRECT_BLOCKED', status: err.status, latencyMs: Date.now() - start };
    if (deadline.aborted || isReadTimeoutError(err))
      return { ok: false, code: 'TIMEOUT', latencyMs: Date.now() - start };
    const cls = classifyProviderError({ networkErrorCode: networkErrorCode(err) });
    return { ok: false, code: cls.code, latencyMs: Date.now() - start, detail: cls.detail };
  }
  let latencyMs = Date.now() - start;
  if (res.ok) {
    try {
    // Validate against the normalized wire actually used for the request, not
    // the caller's original (an api-only Google probe has no wireProtocol).
    // openai-chat 探测发的是 `stream: true`,真实 Chat 桥现在会拒绝非 SSE 的 2xx 响应
    // (返回 200 application/json 的伪流式端点)。探测必须同口径校验 content-type,否则
    // 这类端点会「测试连接」通过、首个真实 Codex 会话却被桥拒 —— 结论自相矛盾。
    if (httpSpec.wireProtocol === 'openai-chat') {
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        try {
          await res.body?.cancel();
        } catch {
          /* no-op */
        }
        return {
          ok: false,
          code: 'WIRE_INCOMPATIBLE',
          status: res.status,
          latencyMs,
          detail: `expected text/event-stream, got ${contentType || 'no content-type'}`,
        };
      }
      const firstPayload = await readFirstSseWithDeadline(res, deadline);
      latencyMs = Date.now() - start;
      if (!firstPayload) {
        return {
          ok: false,
          code: 'WIRE_INCOMPATIBLE',
          status: res.status,
          latencyMs,
          detail: 'stream ended before the first SSE data frame',
        };
      }
      if (firstPayload !== '[DONE]') {
        try {
          const event: unknown = JSON.parse(firstPayload);
          if (isPlainObject(event) && isPlainObject(event.error)) {
            const cls = classifyStreamedError(event.error);
            return { ok: false, code: cls.code, status: res.status, latencyMs, detail: cls.detail };
          }
        } catch {
          return {
            ok: false,
            code: 'WIRE_INCOMPATIBLE',
            status: res.status,
            latencyMs,
            detail: 'first SSE data frame is not valid JSON',
          };
        }
      }
      return { ok: true, latencyMs };
    }
    if (httpSpec.wireProtocol === 'google-generative-ai') {
      const bodyText = await readBodyTextWithDeadline(res, deadline);
      return validateGoogleProbeResponse(bodyText, res.status, Date.now() - start);
    }
    // Non-streaming probes do not need the response body; cancel it to release the connection.
    try {
      await res.body?.cancel();
    } catch {
      /* no-op */
    }
    return { ok: true, latencyMs };
    } catch (error) {
      // Body streams, SSE readers and parsers can throw. Their messages may
      // echo request headers/keys; never forward them into the result. A
      // deadline/abort during the read is a timeout, not a protocol mismatch.
      try {
        await res.body?.cancel();
      } catch {
        /* no-op */
      }
      const timedOut = deadline.aborted || isReadTimeoutError(error);
      return {
        ok: false,
        code: timedOut ? 'TIMEOUT' : 'WIRE_INCOMPATIBLE',
        status: res.status,
        latencyMs: Date.now() - start,
      };
    }
  }
  let bodyText = '';
  try {
    bodyText = (await readBodyTextWithDeadline(res, deadline)).slice(
      0,
      MAX_ERROR_BODY_BYTES,
    );
  } catch {
    /* 读体失败/超时按空体分类 */
  }
  const cls = classifyProviderError({ status: res.status, bodyText });
  return {
    ok: false,
    code: cls.code,
    status: res.status,
    latencyMs: Date.now() - start,
    ...(cls.detail ? { detail: cls.detail } : {}),
  };
}

/**
 * 解析 saved 入参 → 探测 spec。仅支持自定义(user)供应商 —— 内置 OAuth / 网关来源的连接态
 * 由各自鉴权通道保证，不在此探测。解析失败抛 Error（handler 映射 INVALID_PARAMS）。
 */
export function resolveSavedProbeSpec(
  providerId: string,
  agent: AgentKind,
  override?: { modelId?: string; endpoint?: SavedProbeEndpoint },
): ProviderProbeSpec {
  if (isAppSessionBoundaryPending())
    throw new Error(`provider '${providerId}' probe blocked while the account changes`);
  // Config, secret and catalog changes are not one physical transaction. Never
  // read a credential or resolve a route while that window is open.
  if (isProviderRouteMutationInProgress(providerId))
    throw new Error(`provider '${providerId}' configuration is being updated`);
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider '${providerId}' not found`);
  if (provider.source !== 'user')
    throw new Error(`provider '${providerId}' is not a custom provider`);
  const routing = provider.routing[agent];
  if (!routing) throw new Error(`provider '${providerId}' has no runtime for '${agent}'`);
  if (routing.disabled) throw new Error(`provider '${providerId}' runtime '${agent}' is disabled`);
  const requestedModelId = override?.modelId?.trim() || undefined;
  const savedModel = requestedModelId
    ? (provider.models[agent] ?? []).find((entry) => entry.id === requestedModelId)
    : undefined;
  // 探测发的是聊天形状的最小请求(见下方 requestPath/body 组装);挑第一个非聊天模型
  // (image/embedding/...)会把探测发给一个本来就不接受聊天请求的端点,得到的失败结论
  // 和"这个供应商配置是坏的"完全无关(2026-07 review,与 issue #882 第 3 点同一类问题)。
  // An explicit draft model may not be saved yet; Main still probes it only
  // after proving the draft endpoint equals the saved route below.
  const fallbackModel = requestedModelId
    ? undefined
    : (provider.models[agent] ?? []).find((m) =>
        isAgentSelectableModel(m, { userProvider: provider.source === 'user' }),
      );
  const model = requestedModelId ? savedModel : fallbackModel;
  if (!requestedModelId && !model)
    throw new Error(`provider '${providerId}' has no chat models for '${agent}'`);
  const modelId = requestedModelId ?? model!.id;
  // Pi's HTTP-only route helper intentionally excludes SDK transports. A native
  // probe must keep the SDK route instead of treating that exclusion as failure.
  const modelApi = model?.api ?? model?.piApi;
  const savedChannel = provider.channelConfig;
  // The credential slot is (channel id, exact protocol). Never let the generic
  // key reader guess it from the first model, which can point at another
  // protocol's saved key.
  let credentialProtocol: ProviderWireProtocol | undefined;
  let modelRouting: ReturnType<typeof providerRoutingForModel>;
  if (model) {
    if (
      agent === 'pi' && modelApi && ['google-generative-ai', 'google-vertex',
        'azure-openai-responses', 'bedrock-converse-stream', 'mistral-conversations'].includes(modelApi)
    ) {
      modelRouting = { ...routing, upstream: model.route?.baseUrl ?? routing.upstream,
        wireProtocol: model.route?.wireProtocol ?? routing.wireProtocol };
      if (savedChannel) {
        const containing = (Object.keys(savedChannel.protocols) as ProviderWireProtocol[])
          .filter((protocol) =>
            savedChannel.protocols[protocol]?.models.some((entry) => entry.id === model.id),
          );
        if (containing.length !== 1)
          throw new Error(
            `provider '${providerId}' cannot uniquely bind channel credentials for '${model.id}'`,
          );
        credentialProtocol = containing[0];
        modelRouting = {
          ...modelRouting,
          channelCredential: { channelId: savedChannel.id, protocol: containing[0] },
        };
      }
    } else {
      modelRouting = providerRoutingForModel(provider, agent, model.id);
      credentialProtocol = modelRouting?.channelCredential?.protocol;
    }
  } else {
    // Draft model not saved yet: use the saved channel protocol the form
    // reports. The endpoint check below pins it to the saved connection.
    const channel = provider.channelConfig;
    const protocol = override?.endpoint?.wireProtocol;
    const connection = channel && protocol ? channel.protocols[protocol] : undefined;
    if (!channel || !protocol || !connection)
      throw new Error(`provider '${providerId}' cannot route draft model '${modelId}'`);
    credentialProtocol = protocol;
    modelRouting = {
      ...routing,
      upstream: connection.baseUrl,
      wireProtocol: protocol,
      channelCredential: { channelId: channel.id, protocol },
      ...(connection.requestPath ? { requestPath: connection.requestPath } : {}),
      ...(connection.modelsUrl ? { modelsUrl: connection.modelsUrl } : {}),
    };
  }
  if (!modelRouting) {
    throw new Error(
      `provider '${providerId}' model '${modelId}' has no supported protocol for '${agent}'`,
    );
  }
  // The saved key must never follow a draft endpoint. Compare the form's
  // claimed endpoint against the route Main resolved from the saved config;
  // any mismatch rejects before reading the credential.
  if (override?.endpoint) {
    const endpoint = override.endpoint;
    const mismatch = (field: string) =>
      new Error(`provider '${providerId}' saved ${field} differs from the draft endpoint`);
    if (modelRouting.upstream.trim() !== endpoint.baseUrl.trim()) throw mismatch('endpoint');
    if ((modelRouting.modelsUrl || null) !== (endpoint.modelsUrl || null))
      throw mismatch('model-list endpoint');
    if (modelRouting.wireProtocol && modelRouting.wireProtocol !== endpoint.wireProtocol)
      throw mismatch('protocol');
    if (
      agent !== 'pi' &&
      (modelRouting.requestPath?.trim() || '') !== (endpoint.requestPath?.trim() || '')
    )
      throw mismatch('request path');
  }
  // A saved channel always binds credentials to its stable channel id plus the
  // exact verified protocol. Reading them through the generic provider id would
  // let the resolver pick the first model's protocol instead.
  const channelCredential =
    savedChannel && credentialProtocol
      ? { channelId: savedChannel.id, protocol: credentialProtocol }
      : null;
  if (savedChannel && !channelCredential)
    throw new Error(
      `provider '${providerId}' cannot uniquely bind channel credentials for '${modelId}'`,
    );
  const channelHeaders = channelCredential
    ? readHydratedProviderHeaders(channelCredential.channelId, agent, channelCredential.protocol)
    : null;
  const routeHeaders = channelHeaders ?? modelRouting.headerOverride ?? routing.headerOverride;
  const baseUrl = modelRouting.upstream;
  const wireProtocol = modelRouting.wireProtocol;
  const native =
    model && modelApi
      ? { api: modelApi, nativeModel: invocationModelRecord(model, baseUrl, modelApi) }
      : {};
  const catalogPresetId = model?.catalogPresetId ?? routing.piCatalogProviderId;
  // Pi derives its inference path from wireProtocol and does not consume requestPath.
  const requestPath = agent === 'pi' ? undefined : modelRouting.requestPath;
  // OAuth 形态：探测凭证用 Runner 持有的 access_token（与 oauth-token 路由同源），未登录时
  // 无 token → 探测会得到 AUTH_INVALID，这本身就是「先去登录」的正确结论。
  // token 走 authorization 头而**不走 apiKey 字段**——apiKey 会让 cc 探测同时发
  // `x-api-key: <token>`,而真实 oauth-token 路由明确删除 x-api-key;优先按 x-api-key
  // 鉴权的端点会把 access_token 当 API key 校验得到 401,探测结论就与真实会话相反了。
  if (routing.authStrategy === 'oauth-token') {
    const oauthToken = oauthProbeTokenReader(providerId);
    return {
      agent,
      baseUrl: buildRouteDecision(modelRouting, null, agent, null, oauthToken)?.upstreamOverride ?? baseUrl,
      modelId,
      ...native,
      ...(catalogPresetId ? { catalogPresetId } : {}),
      wireProtocol,
      requestPath,
      apiKey: null,
      headers: {
        ...withoutCredentialHeaders(routeHeaders),
        ...(oauthToken ? { authorization: `Bearer ${oauthToken}` } : {}),
      },
    };
  }
  if (routing.authStrategy === 'none') {
    return {
      agent,
      baseUrl,
      modelId,
      ...native,
      ...(catalogPresetId ? { catalogPresetId } : {}),
      wireProtocol,
      requestPath,
      apiKey: null,
      headers: withoutCredentialHeaders(routeHeaders),
    };
  }
  // Same reserved-identity guard as the routing path: a legacy custom channel
  // must not borrow the host-managed credential for a probe.
  const reservedChannelAlias =
    channelCredential
    && isReservedLexServerManagedIdentity(channelCredential.channelId)
    && !isReservedLexServerManagedProviderId(providerId);
  const apiKey = reservedChannelAlias
    ? null
    : channelCredential
      ? keyReader(channelCredential.channelId, agent, channelCredential.protocol)
      : keyReader(providerId, agent);
  return {
    agent,
    baseUrl,
    modelId,
    ...native,
    ...(catalogPresetId ? { catalogPresetId } : {}),
    // 与 oauth-token 分支对齐：Chat 桥接供应商（api-key-header + openai-chat）的 saved 探测
    // 必须带上 wireProtocol，否则 buildProbeRequest 回落到原生 /responses，对 Chat-only 上游
    // 误报连接失败（真实会话走 resolveSessionRoute 不受影响，探测结论会与真实会话相反）。
    wireProtocol,
    requestPath,
    apiKey,
    // 与真实会话路由保持 legacy 兼容：safeStorage 已有 key 时清掉旧凭证头，由 apiKey
    // 重新注入；尚未迁移的 header-only 配置则原样保留，否则“测试连接”会无凭证误报失败。
    headers: apiKey
      ? withoutCredentialHeaders(routeHeaders)
      : { ...(routeHeaders ?? {}) },
  };
}

// OAuth 探测 token 读取器（注入，同 keyReader 模式；生产 = readCachedGenericOAuthAccessToken）。
type OAuthProbeTokenReader = (providerId: string) => string | null;
let oauthProbeTokenReader: OAuthProbeTokenReader = () => null;

/** host 启动期接通 generic-oauth 的同步 token 缓存读取（探测用）。 */
export function setDiagnosticsOAuthTokenReader(reader: OAuthProbeTokenReader): void {
  oauthProbeTokenReader = reader;
}

/** 测试入口（IPC handler 消费）。 */
export async function testProviderConnection(
  input: ProviderTestInput,
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderTestResult> {
  const owner = getActiveAppSession();
  const savedProviderId = input.kind === 'saved' ? input.providerId : null;
  const routeRevision = savedProviderId
    ? getProviderRouteCredentialRevision(savedProviderId)
    : undefined;
  const spec =
    input.kind === 'saved'
      ? resolveSavedProbeSpec(input.providerId, input.agent, {
          modelId: input.modelId,
          endpoint: input.endpoint,
        })
      : input.spec;
  let result: ProviderTestResult;
  try {
    result = await runProviderProbe(spec, fetchImpl);
  } catch {
    // Never expose resolver/SDK/body error text across the diagnostics boundary.
    throw new Error('provider probe failed');
  }
  // The probe crosses an await. Drop the result if an account boundary, owner
  // change or provider credential mutation started meanwhile.
  if (isAppSessionBoundaryPending())
    throw new Error('provider probe invalidated by an account change');
  const current = getActiveAppSession();
  if (current.dataOwnerId !== owner.dataOwnerId || current.generation !== owner.generation)
    throw new Error('provider probe invalidated by an account change');
  if (
    savedProviderId &&
    (isProviderRouteMutationInProgress(savedProviderId) ||
      getProviderRouteCredentialRevision(savedProviderId) !== routeRevision)
  )
    throw new Error(`provider '${savedProviderId}' configuration changed during the probe`);
  // Upstream error bodies can echo credentials verbatim, for saved and adhoc
  // probes alike. Diagnostics return only the structured classification and
  // timing; the IPC handler applies the same safe DTO at the process boundary.
  return {
    ok: result.ok,
    ...(result.code ? { code: result.code } : {}),
    ...(result.status !== undefined ? { status: result.status } : {}),
    latencyMs: result.latencyMs,
  };
}
