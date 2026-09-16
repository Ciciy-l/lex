/**
 * omp agent 的 desktop host 装配 —— 二进制解析 / 受管根 / 凭证 / models.yml 物化,
 * 集中在本模块,maker-host/index.ts 只做一次 buildOmpAgent() 调用。
 *
 * 与 pi-host 的三处**刻意不同**(都是真机实测的硬约束,勿照抄 Pi):
 *
 *  1. 二进制是 opt-in 的(`pnpm install:omp`),不在 CDN 必下清单里 —— 解析走
 *     omp-runtime 的三态,缺二进制时 buildOmpAgent 返回 null、本次不注册 omp。
 *  2. 受管根是 `userData/omp-agent-home`,**绝不能**复用 Pi 的目录:两者上游
 *     仓库不同但环境变量名相近(PI_CONFIG_DIR / PI_CODING_AGENT_DIR)。
 *  3. 凭证通道走 `apiKey` env **名**:OMP 不对 models.yml 的 header 值做环境
 *     变量插值(`$VAR` 会原样发出),只有 apiKey 写的 env 名会被解析成
 *     `Authorization: Bearer <token>`(docs/omp-rpc-spike.md §10)。所以会话
 *     token 由本模块经子进程 env 注入,models.yml 里只有 env 名 + 非敏感的
 *     session-id header,落盘即无泄漏。
 */

import path from 'node:path';

import { app } from 'electron';

import {
  OmpAgent,
  buildOmpCindyModelsYaml,
  ompApiForWireProtocol,
  OMP_CINDY_PROVIDER_ID,
  type AgentDeps,
  type AuthAdapter,
  type AuthAdapterOptions,
  type AuthState,
  type OmpModelsModel,
  type OmpSessionCredentials,
  type OmpWireProtocol,
} from '@cindy/maker-core';

import { getActiveCatalog } from './active-catalog.js';
import { getClaudeEndpoint } from './anthropic-compat-proxy-host.js';
import { readClaudeApiKey } from './auth-adapters.js';
import { createLogger } from '../logger.js';
import { resolveOmpBinaryPath } from './omp-runtime.js';
import { deriveOmpProxySessionToken } from './pi-proxy-session-token.js';

const log = createLogger('omp-host');

/** models.yml 里的模型条目上限(恶意/异常目录不该把 YAML 撑爆)。 */
const MAX_OMP_MODELS = 64;

// ── AuthAdapter(Cindy 网关 key)───────────────────────────────────────────────

/**
 * OMP 没有独立登录面:它只跟本机 loopback proxy 说话,真上游凭证由 proxy 按
 * 会话 token 注入。这里只回答「网关 key 在不在」—— 一个能力探针,不是凭证源。
 */
class DesktopOmpAuthAdapter implements AuthAdapter {
  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    void options;
    const key = readClaudeApiKey();
    if (!key) {
      return { authenticated: false, errorReason: 'cindy_gateway_key_unavailable' };
    }
    return { authenticated: true, identity: 'Cindy AI', authSource: 'api-key' };
  }

  async triggerLogin(): Promise<AuthState> {
    return this.getState();
  }

  async logout(): Promise<void> {
    // 网关 key 生命周期归账号体系管,OMP 侧无可清理凭证。
  }

  /** 凭证只经 models.yml 的 apiKey env 通道(值进子进程 env),这里不另外下发。 */
  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    void options;
    return {};
  }
}

export const desktopOmpAuthAdapter: AuthAdapter = new DesktopOmpAuthAdapter();

// ── 受管 models.yml ──────────────────────────────────────────────────────────

/**
 * 该会话可用的模型清单(catalog 里对 omp 投影的模型 + 当前选中的模型保底)。
 *
 * 只提供 id:上下文窗口由 OMP 自己的 `get_state` 给(`OmpTranslator` 会读),
 * 在 models.yml 里重复声明反而会和真机值分叉。
 */
export function collectOmpCatalogModels(model: string): OmpModelsModel[] {
  const seen = new Set<string>();
  const out: OmpModelsModel[] = [];
  const push = (id: string): void => {
    if (!id || seen.has(id) || out.length >= MAX_OMP_MODELS) return;
    seen.add(id);
    out.push({ id, name: id, input: ['text'] });
  };
  // 当前选中的模型先占位:即使目录这一轮还没投影到 omp(首启竞态),会话也能起。
  push(model);
  for (const provider of getActiveCatalog().providers) {
    if (provider.routing.omp?.disabled === true) continue;
    for (const entry of provider.models.omp ?? []) push(entry.id);
  }
  return out;
}

/**
 * 这次会话该让 OMP 对 proxy 说哪种上游协议。
 *
 * 为什么必须压成**一个**值:OMP 的 models.yml **只能**在 provider 级声明 `api`
 * (实测 v18.1.18:给单个模型写 `api` 会让整份文件被拒,报 `Unknown provider`),
 * 所以 Cindy 的「模型 route 覆盖 → 供应商 routing 默认」两层在这里收敛成一个。
 *
 * 取值必须经 `ompApiForWireProtocol` 翻译后才能写进 models.yml —— Cindy 与 OMP 对
 * chat completions 的命名不同(`openai-chat` vs `openai-completions`),透传会让
 * OMP 整份拒收、会话起不来。
 *
 * 它同时决定 OMP 打到本机 proxy 的哪条路径,而 proxy 按路径选前门:
 * `anthropic-messages` → `/v1/messages`(Claude 前门);`openai-responses` /
 * `openai-completions` → `/responses` / `/chat/completions`(Codex 前门)。
 */
export function resolveOmpWireProtocol(
  model: string,
  providerId?: string | null,
): OmpWireProtocol {
  const providers = getActiveCatalog().providers;
  const scoped = providerId ? providers.filter((p) => p.id === providerId) : providers;
  // 模型级覆盖优先(与 Cindy 各处 route 解析同口径)。
  for (const provider of scoped) {
    const wire = provider.models.omp?.find((entry) => entry.id === model)?.route?.wireProtocol;
    if (wire) return wire;
  }
  // 其次供应商对该 agent 的默认协议。
  for (const provider of scoped) {
    const wire = provider.routing.omp?.wireProtocol;
    if (wire) return wire;
  }
  // 兜底与历史语义一致:OMP 走本机 proxy 的 Anthropic 前门。
  return 'anthropic-messages';
}

/**
 * 物化前的最后一道闸:models.yml **绝不能**含任何密钥。
 *
 * 通道设计上它只可能有 env 名与非敏感标识,但这条断言把「设计上不可能」变成
 * 「运行时会炸」—— 一旦有人在 headers 里塞了 token(或上游改了插值行为),
 * 会话直接失败,而不是把秘密写进 `userData` 下的明文文件。
 */
export function assertOmpModelsYamlHasNoSecrets(
  yaml: string,
  secrets: readonly string[],
): void {
  for (const secret of secrets) {
    if (secret.length > 0 && yaml.includes(secret)) {
      throw new Error('Refusing to materialize an OMP models.yml that carries a session secret');
    }
  }
}

/** 构造受管 models.yml 文本;凭证不可得时返回 undefined(= 不物化,OMP 无 Cindy provider)。 */
export function buildOmpManagedModelsYaml(params: {
  sessionId: string;
  model: string;
  token: string;
  /** 该会话选中的供应商(catalog provider id);缺省时协议解析退化为跨全部供应商搜模型。 */
  providerId?: string | null;
  /** 显式指定上游协议(测试用);不给则按模型/供应商解析。 */
  wireProtocol?: OmpWireProtocol;
}): string | undefined {
  const models = collectOmpCatalogModels(params.model);
  if (models.length === 0) {
    log.warn('omp has no catalog models; skipping models.yml materialization');
    return undefined;
  }
  const wireProtocol =
    params.wireProtocol ?? resolveOmpWireProtocol(params.model, params.providerId);
  const yaml = buildOmpCindyModelsYaml({
    baseUrl: getClaudeEndpoint(),
    // 必须翻译:Cindy 的 `openai-chat` 在 OMP 里叫 `openai-completions`,透传会让
    // OMP 整份 models.yml 被拒(见 ompApiForWireProtocol 注释)。
    api: ompApiForWireProtocol(wireProtocol),
    providerId: OMP_CINDY_PROVIDER_ID,
    sessionId: params.sessionId,
    models,
  });
  assertOmpModelsYamlHasNoSecrets(yaml, [params.token]);
  return yaml;
}

// ── 构造入口 ─────────────────────────────────────────────────────────────────

export interface BuildOmpAgentOpts {
  logger: AgentDeps['logger'];
  turnChangeCapture?: AgentDeps['turnChangeCapture'];
  registerLocalAgentProcess?: AgentDeps['registerLocalAgentProcess'];
  capabilityAdditions?: AgentDeps['capabilityAdditions'];
  reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'];
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
}

/**
 * 构造 OmpAgent;二进制不在位(未 opt-in 安装 / 版本对不上基线)返回 null ——
 * 本次启动不注册 omp,对 Cindy 其余功能零影响。
 */
export function buildOmpAgent(opts: BuildOmpAgentOpts): OmpAgent | null {
  const binaryPath = resolveOmpBinaryPath();
  if (!binaryPath) {
    log.warn('omp binary unavailable; omp agent disabled for this launch');
    return null;
  }
  log.info('omp agent enabled', { binaryPath });
  return new OmpAgent({
    auth: desktopOmpAuthAdapter,
    runtimeConfig: buildDesktopOmpRuntimeConfig(),
    // getter:二进制可能在会话期间被补齐/更新,每次 spawn 读最新受管路径。
    get binaryPath(): string {
      return resolveOmpBinaryPath() ?? binaryPath;
    },
    logger: opts.logger,
    turnChangeCapture: opts.turnChangeCapture,
    registerLocalAgentProcess: opts.registerLocalAgentProcess,
    capabilityAdditions: opts.capabilityAdditions,
    reviewAutoPermissionAction: opts.reviewAutoPermissionAction,
    mcpProviders: opts.mcpProviders,
    makerMemory: opts.makerMemory,
    // 受管持久根:会话历史落在 userData 下,与 Pi 的根严格分开。
    resolveOmpAgentHome: () => path.join(app.getPath('userData'), 'omp-agent-home'),
    // 凭证只给值、不落盘;没有 sessionId 就无从绑定 token,直接抛错 fail-closed
    // (静默返回 undefined 会让 OMP 起在「没有 Cindy provider」的半残状态)。
    resolveOmpCredentials: (context): OmpSessionCredentials => {
      const sessionId = context.sessionId;
      if (!sessionId) {
        throw new Error('[OMP_NO_SESSION] OMP sessions require a business session id');
      }
      return { proxyKey: deriveOmpProxySessionToken(sessionId), sessionId };
    },
    resolveOmpModelsYaml: (context) => {
      const sessionId = context.sessionId;
      if (!sessionId) return undefined;
      const token = deriveOmpProxySessionToken(sessionId);
      return buildOmpManagedModelsYaml({
        sessionId,
        model: context.model,
        token,
        providerId: context.providerId,
      });
    },
  });
}

function buildDesktopOmpRuntimeConfig(): AgentDeps['runtimeConfig'] {
  return {
    userDataPath: app.getPath('userData'),
  };
}
