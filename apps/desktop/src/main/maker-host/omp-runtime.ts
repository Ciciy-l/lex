/**
 * omp-runtime —— OMP 受管运行时的解析与**三态**。
 *
 * 开发 checkout 中,OMP 仍不是 postinstall 必下资产：开发者通过
 * `pnpm install:omp` / `pnpm update:omp` 将它放进
 * `apps/omp-bin/<platform>/`。正式 Lex 与 claude/codex/pi 走同一条启动页串行
 * 下载队列，只是源不同：读构建期固定的 `config/lex-agent-runtime-assets.json`，
 * 其中 OMP 的 `file` 直接是 `tools/omp/latest.json` 固定的上游 GitHub Release
 * 绝对 URL，落点是受管 userData 目录。两种来源都会在使用前重新校验尺寸与
 * SHA-256。因此「有没有 OMP」是运行时**三态**,不是布尔:
 *
 *   · not-ready   —— 没装(dev 全新 checkout 的默认态)
 *   · downloading —— 正在拉(下载器经 noteOmpRuntimeDownloadStarted 上报)
 *   · ready       —— 二进制在位,且 `--version` 未与基线冲突
 *   · failed      —— 平台无资产 / 下载失败 / 版本对不上基线
 *
 * 判定的**纯函数**是 `classifyOmpRuntime`(可单测、不碰 fs);本模块只负责采集
 * facts(fs / electron / 子进程)并广播。
 *
 * 三态如何到 UI:只有 `ready`(本地运行时就绪)或 `failed/platform-unsupported`
 * (平台本来就没有资产,只能走 SSH)才被 `buildOmpAgent` 注册进 maker;renderer 的
 * `useAvailableAgents` 读 `maker:list-available-agents`,`AgentSelect` 据此把未
 * 注册的引擎从下拉里隐掉 —— 未就绪时用户**看不到** OMP 入口,不可能创建出
 * `Agent 'omp' is not registered` 的会话(不会白屏,也不会莫名报错)。
 * 本地运行时「还没到手」时 `buildOmpAgent` 必须**什么都不注册**(见 omp-host 的注释),
 * 等下载校验通过后由 `registerOmpAgentIfAvailable` 补注册带本地运行时的完整 agent。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { OMP_COMPATIBILITY_BASELINE, parseOmpVersionOutput } from '@cindy/maker-core';

import { buildShipsOmpRuntime, getCachedBinaryStatus } from '../agent-binaries/index.js';
import { isRetryableOptionalRuntimePrepareError } from '../agent-binaries/pi-runtime-recovery.js';
import { createLogger } from '../logger.js';
import { getPlatformKey } from '../manifestService.js';
import {
  getPinnedOmpRuntimeAsset,
  OMP_RUNTIME_PLATFORM_KEYS,
  type OmpPinnedRuntimeAsset,
} from './omp-runtime-verifier.js';

const log = createLogger('omp-runtime');

const execFileAsync = promisify(execFile);

/** `--version` 只在探测/诊断路径调用,不能让一个卡住的二进制挂住启动。 */
const VERSION_PROBE_TIMEOUT_MS = 4000;

/** `tools/omp/latest.json` 里有资产的平台;缺一即永久 failed(不重试)。 */
const SUPPORTED_PLATFORM_KEYS: ReadonlySet<string> = new Set(OMP_RUNTIME_PLATFORM_KEYS);

export type OmpRuntimeState = 'not-ready' | 'downloading' | 'ready' | 'failed';

export type OmpRuntimeReason =
  | 'not-installed'
  | 'platform-unsupported'
  | 'downloading'
  | 'download-failed'
  | 'version-mismatch';

export interface OmpRuntimeSnapshot {
  readonly state: OmpRuntimeState;
  /** state !== 'ready' 时说明「为什么不就绪」;日志与未来 UI 提示的唯一来源。 */
  readonly reason: OmpRuntimeReason | null;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly detail: string | null;
}

export interface OmpDownloadPhase {
  readonly kind: 'idle' | 'running' | 'failed';
  readonly detail?: string;
}

/** 判定所需的全部输入(fs / 子进程 / 下载器的采集结果),纯数据。 */
export interface OmpRuntimeFacts {
  readonly platformKey: string;
  readonly platformSupported: boolean;
  readonly binaryPath: string | null;
  readonly binaryUsable: boolean;
  /** `omp --version` 解析结果;null = 尚未探测或探测失败。 */
  readonly reportedVersion: string | null;
  readonly download: OmpDownloadPhase;
}

function snapshot(
  state: OmpRuntimeState,
  reason: OmpRuntimeReason | null,
  facts: Pick<OmpRuntimeFacts, 'binaryPath' | 'reportedVersion'>,
  detail: string | null = null,
): OmpRuntimeSnapshot {
  return Object.freeze({
    state,
    reason,
    binaryPath: facts.binaryPath,
    version: facts.reportedVersion,
    detail,
  });
}

/**
 * 三态判定(纯函数)。
 *
 * 优先级:平台 → 二进制是否可用 → 版本是否对得上基线 → 下载态。
 * 「二进制在位但版本没探出来」按 ready 处理(乐观),版本冲突由 `refreshOmpRuntime`
 * 探明后落 failed —— 探不出来不该比探出来更严格,否则一次 execFile 抖动就会
 * 把一个能用的运行时判死。
 */
export function classifyOmpRuntime(facts: OmpRuntimeFacts): OmpRuntimeSnapshot {
  if (!facts.platformSupported) {
    return snapshot(
      'failed',
      'platform-unsupported',
      facts,
      `no OMP release asset for platform ${facts.platformKey}`,
    );
  }
  if (facts.binaryUsable) {
    if (facts.reportedVersion !== null && facts.reportedVersion !== OMP_COMPATIBILITY_BASELINE) {
      return snapshot(
        'failed',
        'version-mismatch',
        facts,
        `expected ${OMP_COMPATIBILITY_BASELINE}, binary reports ${facts.reportedVersion}`,
      );
    }
    return snapshot('ready', null, facts);
  }
  if (facts.download.kind === 'running') return snapshot('downloading', 'downloading', facts);
  if (facts.download.kind === 'failed') {
    return snapshot('failed', 'download-failed', facts, facts.download.detail ?? null);
  }
  return snapshot('not-ready', 'not-installed', facts);
}

/** 平台目录里的二进制文件名(windows 带 .exe)。 */
export function ompBinaryName(platformKey: string = getPlatformKey()): string {
  return platformKey.startsWith('win32') ? 'omp.exe' : 'omp';
}

/**
 * 解析 OMP 主执行文件绝对路径;不在位返回 null。
 *
 * dev 复用 agent-binaries 的同一查找约定(`apps/omp-bin/<platform>/omp[.exe]`),
 * 打包态读 userData 下的受管版本目录。两条路径都经过 agent-binaries 的 OMP
 * 专属固定 SHA-256 校验，不能只信任 marker、PATH 或可执行位。
 *
 * OMP 现在和 Pi 一样由受管启动任务自动准备；这里仍只做同步解析，绝不自行下载或
 * 触发子进程。
 */
export function resolveOmpBinaryPath(): string | null {
  const platformKey = getPlatformKey();
  let expected: OmpPinnedRuntimeAsset | undefined;
  try {
    expected = getPinnedOmpRuntimeAsset(platformKey);
  } catch (error) {
    log.error('OMP runtime pin is invalid; refusing to resolve the binary', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!expected) return null;
  // getCachedBinaryStatus('omp') is the execution-side gate: unlike the other
  // marker-based entries it invokes the exact fixed-pin verifier before it
  // returns a path. Keep this resolver download-free so Maker construction
  // remains deterministic while optional runtime preparation runs in the background.
  const cached = getCachedBinaryStatus('omp');
  return cached.binaryReady && cached.binaryPath ? cached.binaryPath : null;
}

/**
 * 探一次 `omp --version`。失败(不存在 / 超时 / 输出不合规)一律返回 null ——
 * 探测是**增强**信息,不是可用性的前置条件。
 */
export async function probeOmpVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      // 二进制可能与 cwd 无关,但仍显式钉在它所在目录:避免从不可信的项目目录解析。
      cwd: path.dirname(binaryPath),
    });
    return parseOmpVersionOutput(stdout) ?? null;
  } catch (error) {
    log.warn('omp --version probe failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ── 状态缓存与订阅 ───────────────────────────────────────────────────────────

let cachedSnapshot: OmpRuntimeSnapshot | null = null;
let downloadPhase: OmpDownloadPhase = Object.freeze({ kind: 'idle' as const });
/** 版本探测结果按二进制路径缓存:换版本(路径变)必须重探。 */
let probedPath: string | null = null;
let probedVersion: string | null = null;

const listeners = new Set<(snapshot: OmpRuntimeSnapshot) => void>();

function computeSnapshot(): OmpRuntimeSnapshot {
  const platformKey = getPlatformKey();
  const binaryPath = resolveOmpBinaryPath();
  const binaryUsable = binaryPath !== null;
  return classifyOmpRuntime({
    platformKey,
    // latest.json 有 6 平台,构建资产表只发 4 个;缺资产的平台按「平台不支持」算。
    platformSupported: SUPPORTED_PLATFORM_KEYS.has(platformKey) && buildShipsOmpRuntime(platformKey),
    binaryPath,
    binaryUsable,
    reportedVersion: binaryUsable && probedPath === binaryPath ? probedVersion : null,
    download: downloadPhase,
  });
}

function publish(next: OmpRuntimeSnapshot): OmpRuntimeSnapshot {
  cachedSnapshot = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (error) {
      log.warn('omp runtime listener threw', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return next;
}

/**
 * 同步读当前三态(未缓存过就现算一次,不跑子进程)。
 *
 * agent-binaries 自己按当前运行态选择开发或正式受管路径；这里不重建第二套
 * 路径策略，也不会触发下载。
 */
export function getOmpRuntimeSnapshot(): OmpRuntimeSnapshot {
  return cachedSnapshot ?? computeSnapshot();
}

/**
 * **现算**三态(不读缓存、不跑子进程、不触发下载)。
 *
 * 给 buildOmpAgent 判断「本地运行时只是还没下好」用。这里必须绕开缓存:
 * cachedSnapshot 在 Maker 构造那一刻就被 publish 固定,而 OMP 的受管下载是在那
 * 之后才完成的 —— 读缓存会把已经就绪的运行时判成 not-ready,反而让补注册永远
 * 失败(rc.2 的 remote-only 占位故障就是这样锁死的)。
 */
export function peekOmpRuntimeSnapshot(): OmpRuntimeSnapshot {
  return computeSnapshot();
}

/**
 * 本地 OMP 运行时是否「还不能注册」—— 即这台机器上的本地运行时还没就位,而且
 * 它仍有到来的可能。
 *
 * 判定必须和 recovery 的「值不值得重试」用同一把尺子(`isRetryableOptionalRuntimePrepareError`),
 * 否则两边会对「本地还有没有希望」给出不同答案:
 *
 *  - `ready` → 已就绪,直接注册带本地运行时的 agent。
 *  - `platform-unsupported` → 平台本来就没有资产,本地运行时永远不可能出现,
 *    SSH 是唯一通路,允许 remote-only 注册。
 *  - `download-failed` 且错误码**可重试**(网络类)→ 受管下载还会重试,必须推迟注册。
 *  - `download-failed` 且错误码**不可重试**(HTTP_4XX / CHECKSUM / DISK / asset_* /
 *    version-mismatch)→ recovery 已经放弃,本地已无希望,允许 remote-only 注册走 SSH。
 *  - `not-installed` / `downloading` → 还在等,推迟注册。
 *
 * 为什么必须推迟:`Maker.registerAgent` 是加法幂等的,先注册的 agent 在整个进程内
 * 换不掉。一旦在二进制落盘前注册了 remote-only agent,之后下载校验通过也补不进来
 * (rc.2 的实际故障),本地 OMP 会一直处于「下拉里有人、本地一起就失败」的状态。
 */
export function isLocalOmpRuntimePending(snapshot: OmpRuntimeSnapshot): boolean {
  if (snapshot.state === 'ready') return false;
  // 本地已无希望:平台本来就没有资产,或二进制在位但 `--version` 对不上基线 ——
  // 两者重试都救不回来,允许 remote-only 注册走 SSH。
  if (snapshot.reason === 'platform-unsupported' || snapshot.reason === 'version-mismatch') {
    return false;
  }
  if (snapshot.reason === 'download-failed') {
    return isRetryableOptionalRuntimePrepareError(snapshot.detail ?? undefined);
  }
  return true;
}

/**
 * 采集完整三态(含一次 `omp --version`)并广播。
 *
 * 与 `getOmpRuntimeSnapshot` 的区别:只有它会把「版本对不上基线」判成 failed。
 * 已注册的 OMP agent 不会因为这次探测被摘掉(在跑的会话继续跑),但**下一次**
 * `getMaker()`(切账号 / 重启)会看到 failed 而不再注册。
 */
export async function refreshOmpRuntime(): Promise<OmpRuntimeSnapshot> {
  const platformKey = getPlatformKey();
  const binaryPath = resolveOmpBinaryPath();
  const binaryUsable = binaryPath !== null;
  let reportedVersion: string | null = null;
  if (binaryUsable && binaryPath !== null) {
    if (probedPath === binaryPath) reportedVersion = probedVersion;
    else {
      reportedVersion = await probeOmpVersion(binaryPath);
      probedPath = binaryPath;
      probedVersion = reportedVersion;
    }
  }
  return publish(
    classifyOmpRuntime({
      platformKey,
      platformSupported: SUPPORTED_PLATFORM_KEYS.has(platformKey),
      binaryPath,
      binaryUsable,
      reportedVersion,
      download: downloadPhase,
    }),
  );
}

// ── 下载态上报(OMP 下载器的接入口)────────────────────────────────────────────

export function noteOmpRuntimeDownloadStarted(detail?: string): OmpRuntimeSnapshot {
  downloadPhase = detail === undefined ? { kind: 'running' } : { kind: 'running', detail };
  return publish(computeSnapshot());
}

export function noteOmpRuntimeDownloadFailed(detail: string): OmpRuntimeSnapshot {
  downloadPhase = { kind: 'failed', detail };
  const next = publish(computeSnapshot());
  log.warn('omp runtime download failed', { detail });
  return next;
}

export function noteOmpRuntimeDownloadSucceeded(): OmpRuntimeSnapshot {
  downloadPhase = { kind: 'idle' };
  // 新落盘的二进制路径/版本都变了,作废上一次探测缓存。
  probedPath = null;
  probedVersion = null;
  return publish(computeSnapshot());
}

export function subscribeOmpRuntime(
  listener: (snapshot: OmpRuntimeSnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试隔离:清缓存、下载态与订阅(其它代码不应调用)。 */
export function resetOmpRuntimeForTest(): void {
  cachedSnapshot = null;
  downloadPhase = Object.freeze({ kind: 'idle' as const });
  probedPath = null;
  probedVersion = null;
  listeners.clear();
}
