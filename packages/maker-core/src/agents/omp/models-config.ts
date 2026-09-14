/**
 * 受管 `models.yml` 的纯函数生成器（不接触 fs，物化由 desktop host 负责）。
 *
 * 为什么必须有这一层：OMP 的自定义 provider **只能**走 `<agentDir>/models.yml` ——
 * base-url 类环境变量只覆盖本地引擎（spike §7 实证 `OPENAI_BASE_URL` 未生效）。
 *
 * ## 凭证通道（真机实测，见 `docs/omp-rpc-spike.md` §10）
 *
 * 对 v18.1.18 的实测（本地二进制 + 本地回显服务器，三种写法同时放、5 次请求一致）：
 *
 * | models.yml 里的写法 | OMP 实际发出的头 |
 * | --- | --- |
 * | `headers: { x-k: $VAR }` | `x-k: $VAR`（**原样，不插值**） |
 * | `headers: { x-k: ${VAR} }` | `x-k: ${VAR}`（**原样，不插值**） |
 * | `apiKey: VAR`（env 名） | `Authorization: Bearer <VAR 的值>`（**按 env 名解析**） |
 *
 * 由此确定的硬性约定（本模块用校验强制，T04 照此实现）：
 *
 * 1. **秘密一律走 `apiKeyEnv`**：只写 env **名**，值由 host 注入子进程 env，
 *    models.yml 里不含任何密钥，落盘即无泄漏。header 值里出现 `$VAR` / `${VAR}`
 *    形态一律抛错 —— 它们不会插值却极容易被误以为会，是会骗人的写法。
 * 2. **headers 只放非敏感标识**：provider id、session id 之类。Cindy 的**会话
 *    token 不放 headers**，而是作为 `apiKeyEnv` 指向的环境变量值注入，OMP 会以
 *    `Authorization: Bearer <token>` 发出，本地 `anthropic-compat-proxy-host.ts`
 *    从该头取回 token（proxy 是我们自己的，可以这么约定）。
 */

export type OmpProviderApi =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses';

export const OMP_PROVIDER_APIS: readonly OmpProviderApi[] = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
];

/** Cindy 托管 provider 的固定 id（与 models.yml 的 providers.<id> 对应）。 */
export const OMP_CINDY_PROVIDER_ID = 'cindy';

/** models.yml 在 `PI_CODING_AGENT_DIR` 下的固定文件名。 */
export const OMP_MODELS_FILE_NAME = 'models.yml';

export const OMP_CINDY_API_KEY_ENV = 'CINDY_OMP_PROXY_KEY';
export const OMP_CINDY_SESSION_ID_ENV = 'CINDY_OMP_SESSION_ID';
export const OMP_CINDY_SESSION_TOKEN_ENV = 'CINDY_OMP_SESSION_TOKEN';

export const OMP_CINDY_PROVIDER_ID_HEADER = 'x-cindy-omp-provider-id';
export const OMP_CINDY_SESSION_ID_HEADER = 'x-cindy-omp-session-id';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
/** env 变量名：全大写、以下划线分隔。密钥字面量（含小写/符号）在此被拒。 */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;

export interface OmpModelsProvider {
  id: string;
  baseUrl: string;
  api: OmpProviderApi;
  /** env 变量名（不是密钥值）。OMP 先按 env 名解析，解析不到才按字面量。 */
  apiKeyEnv: string;
  headers?: Readonly<Record<string, string>>;
}

export interface OmpModelsModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface OmpModelsModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly ('text' | 'image')[];
  cost?: OmpModelsModelCost;
  thinking?: { mode: 'effort'; efforts: readonly string[] };
}

export interface OmpModelsProviderWithModels extends OmpModelsProvider {
  models: readonly OmpModelsModel[];
}

export interface OmpModelsConfigInput {
  providers: readonly OmpModelsProviderWithModels[];
}

function requireText(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit)
    throw new Error(`Invalid OMP models ${name}`);
  // 控制字符会破坏 YAML 行结构，也会成为日志注入面。
  if (Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error(`Invalid OMP models ${name}`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid OMP models ${name}`);
  return value;
}

function requireApi(value: unknown): OmpProviderApi {
  if (typeof value !== 'string' || !(OMP_PROVIDER_APIS as readonly string[]).includes(value))
    throw new Error('Invalid OMP models provider api');
  return value as OmpProviderApi;
}

function requireId(value: unknown, name: string, pattern: RegExp): string {
  const text = requireText(value, name, 128);
  if (!pattern.test(text)) throw new Error(`Invalid OMP models ${name}`);
  return text;
}

/** 单引号 YAML 标量：内部单引号加倍，任何内容都不可能跳出引号。 */
function quote(value: string): string {
  return `'${value.replace(/'/gu, '\'\'')}'`;
}

/** 布尔 / 数字 / env 名等已校验过的裸标量直接输出，其余一律加引号。 */
function bare(value: string): string {
  return value;
}

/**
 * header 值：除常规校验外，拒绝任何 `$VAR` / `${VAR}` 形态。
 *
 * OMP **不对 header 做环境变量插值**（v18.1.18 实测，`docs/omp-rpc-spike.md` §10），
 * 这类写法只会把字面量（或被误以为"已被替换"的密钥）写进落盘文件，是会骗人的
 * 写法，因此直接拒绝并指明正确通道。
 */
function requireHeaderValue(value: unknown): string {
  const text = requireText(value, 'header value', 4096);
  if (text.startsWith('$') || text.includes('${'))
    throw new Error(
      'OMP does not interpolate environment variables in models.yml header values (verified on v18.1.18); pass the secret through apiKeyEnv instead',
    );
  return text;
}

/** header 名与值的统一校验，供生成器与 provider 组装器共用（早失败）。 */
function requireHeaderEntries(entries: Readonly<Record<string, string>>): void {
  const keys = Object.keys(entries);
  if (keys.length > 32) throw new Error('Invalid OMP models provider headers');
  for (const key of keys) {
    if (!HEADER_NAME.test(key)) throw new Error('Invalid OMP models header name');
    requireHeaderValue(entries[key]);
  }
}

function headers(entries: Readonly<Record<string, string>> | undefined): string[] {
  if (entries === undefined) return [];
  requireHeaderEntries(entries);
  return [
    '    headers:',
    ...Object.keys(entries).map(
      (key) => `      ${bare(key)}: ${quote(requireHeaderValue(entries[key]))}`,
    ),
  ];
}

function modelCost(cost: OmpModelsModelCost | undefined): string[] {
  if (cost === undefined) return [];
  const keys: (keyof OmpModelsModelCost)[] = [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
  ];
  const entries = keys.filter((key) => cost[key] !== undefined);
  if (entries.length === 0) return [];
  return [
    '        cost:',
    ...entries.map(
      (key) => `          ${key}: ${requireNumber(cost[key], `cost.${String(key)}`)}`,
    ),
  ];
}

function modelBlock(model: unknown): string[] {
  if (model === null || typeof model !== 'object' || Array.isArray(model))
    throw new Error('Invalid OMP models entry');
  const entry = model as Partial<OmpModelsModel>;
  const lines: string[] = [`      - id: ${bare(requireId(entry.id, 'model id', MODEL_ID))}`];
  if (entry.name !== undefined)
    lines.push(`        name: ${quote(requireText(entry.name, 'model name', 256))}`);
  if (entry.contextWindow !== undefined)
    lines.push(`        contextWindow: ${requireNumber(entry.contextWindow, 'contextWindow')}`);
  if (entry.maxTokens !== undefined)
    lines.push(`        maxTokens: ${requireNumber(entry.maxTokens, 'maxTokens')}`);
  if (entry.reasoning !== undefined) {
    if (typeof entry.reasoning !== 'boolean')
      throw new Error('Invalid OMP models reasoning flag');
    lines.push(`        reasoning: ${entry.reasoning}`);
  }
  if (entry.input !== undefined) {
    if (!Array.isArray(entry.input) || entry.input.length === 0 || entry.input.length > 8)
      throw new Error('Invalid OMP models input kinds');
    lines.push('        input:');
    for (const kind of entry.input) {
      if (kind !== 'text' && kind !== 'image')
        throw new Error('Invalid OMP models input kind');
      lines.push(`          - ${bare(kind)}`);
    }
  }
  if (entry.thinking !== undefined) {
    const thinking = entry.thinking;
    if (
      thinking === null ||
      typeof thinking !== 'object' ||
      thinking.mode !== 'effort' ||
      !Array.isArray(thinking.efforts) ||
      thinking.efforts.length === 0 ||
      thinking.efforts.length > 16
    )
      throw new Error('Invalid OMP models thinking config');
    lines.push('        thinking:');
    lines.push('          mode: effort');
    lines.push('          efforts:');
    for (const effort of thinking.efforts) {
      if (typeof effort !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(effort))
        throw new Error('Invalid OMP models effort');
      lines.push(`            - ${effort}`);
    }
  }
  const cost = modelCost(entry.cost);
  if (cost.length > 0) lines.push(...cost);
  return lines;
}

/**
 * 生成 `models.yml` 内容。纯函数：同输入必得同输出，方便 host 做"内容未变则不写盘"。
 */
export function buildOmpModelsConfigYaml(input: OmpModelsConfigInput): string {
  if (
    input === null ||
    typeof input !== 'object' ||
    !Array.isArray(input.providers) ||
    input.providers.length === 0 ||
    input.providers.length > 32
  )
    throw new Error('Invalid OMP models config');
  const seen = new Set<string>();
  const lines: string[] = ['providers:'];
  for (const provider of input.providers) {
    if (provider === null || typeof provider !== 'object')
      throw new Error('Invalid OMP models provider');
    const id = requireId(provider.id, 'provider id', PROVIDER_ID);
    if (seen.has(id)) throw new Error('Duplicate OMP models provider id');
    seen.add(id);
    const baseUrl = requireText(provider.baseUrl, 'baseUrl', 2048);
    if (!/^https?:\/\//u.test(baseUrl) || /\s/u.test(baseUrl))
      throw new Error('Invalid OMP models baseUrl');
    const apiKeyEnv = requireId(provider.apiKeyEnv, 'apiKeyEnv', ENV_NAME);
    lines.push(`  ${bare(id)}:`);
    lines.push(`    baseUrl: ${quote(baseUrl)}`);
    lines.push(`    api: ${bare(requireApi(provider.api))}`);
    // apiKey 只写 env 名（OMP 按 env 名优先解析），裸标量输出，不可能是密钥。
    lines.push(`    apiKey: ${bare(apiKeyEnv)}`);
    lines.push(...headers(provider.headers));
    if (!Array.isArray(provider.models) || provider.models.length === 0)
      throw new Error('OMP models provider requires at least one model');
    lines.push('    models:');
    for (const model of provider.models) lines.push(...modelBlock(model));
  }
  return `${lines.join('\n')}\n`;
}

export interface OmpCindyProviderInput {
  baseUrl: string;
  api?: OmpProviderApi;
  providerId?: string;
  /**
   * 凭证通道：写 env **名**（默认 `CINDY_OMP_PROXY_KEY`）。
   * Cindy 的会话 token 必须经这里注入（值进子进程 env），OMP 会以
   * `Authorization: Bearer <token>` 发出，proxy 从该头取回 —— 不要放 headers。
   */
  apiKeyEnv?: string;
  /** 非敏感会话标识，进 headers；token 不进。 */
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  models: readonly OmpModelsModel[];
}

/**
 * 组装 Cindy 托管 provider 块（架构 §3.6，**凭证通道按 spike §10 实测修正**）。
 *
 * headers 只放非敏感标识（provider id / session id），用于 compat proxy 钉路由；
 * 会话 token 走 `apiKeyEnv` 指向的 env（见 `OmpCindyProviderInput.apiKeyEnv`），
 * 因为 OMP 不对 header 值做环境变量插值 —— 把 token 写进 headers 等于明文落盘。
 */
export function buildOmpCindyProvider(
  input: OmpCindyProviderInput,
): OmpModelsProviderWithModels {
  if (input === null || typeof input !== 'object')
    throw new Error('Invalid OMP Cindy provider input');
  const headers: Record<string, string> = {
    [OMP_CINDY_PROVIDER_ID_HEADER]: input.providerId ?? OMP_CINDY_PROVIDER_ID,
  };
  if (input.sessionId !== undefined)
    headers[OMP_CINDY_SESSION_ID_HEADER] = input.sessionId;
  for (const [key, value] of Object.entries(input.headers ?? {}))
    headers[key] = value;
  // 组装阶段就校验：把"header 不插值"这条实测约束前移,别等到物化时才炸。
  requireHeaderEntries(headers);
  return Object.freeze({
    id: input.providerId ?? OMP_CINDY_PROVIDER_ID,
    baseUrl: input.baseUrl,
    api: input.api ?? 'anthropic-messages',
    apiKeyEnv: input.apiKeyEnv ?? OMP_CINDY_API_KEY_ENV,
    headers: Object.freeze(headers),
    models: input.models,
  });
}

/** 便捷入口：单个 Cindy provider 的完整 models.yml。 */
export function buildOmpCindyModelsYaml(input: OmpCindyProviderInput): string {
  return buildOmpModelsConfigYaml({
    providers: [buildOmpCindyProvider(input)],
  });
}
