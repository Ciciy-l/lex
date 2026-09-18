/**
 * omp-runtime —— OMP 受管运行时的解析与**三态**。
 *
 * 与 cc / codex / pi 不同,OMP 二进制**不是** postinstall 必下资产:
 * `tools/omp/latest.json` pin 了上游 tag(`OMP_COMPATIBILITY_BASELINE`),但只有
 * 显式 `pnpm install:omp` / `pnpm update:omp` 才会把它拉进
 * `apps/omp-bin/<platform>/`(单平台 ~160MB,见 scripts/ensure-agent-binaries.mjs
 * 的 `defaultInstall: false`)。所以「有没有 OMP」是运行时**三态**,不是布尔:
 *
 *   · not-ready   —— 没装(dev 全新 checkout 的默认态)
 *   · downloading —— 正在拉(下载器经 noteOmpRuntimeDownloadStarted 上报)
 *   · ready       —— 二进制在位,且 `--version` 未与基线冲突
 *   · failed      —— 平台无资产 / 下载失败 / 版本对不上基线
 *
 * 判定的**纯函数**是 `classifyOmpRuntime`(可单测、不碰 fs);本模块只负责采集
 * facts(fs / electron / 子进程)并广播。
 *
 * 三态如何到 UI:OMP 只有 ready 才被 `buildOmpAgent` 注册进 maker;renderer 的
 * `useAvailableAgents` 读 `maker:list-available-agents`,`AgentSelect` 据此把未
 * 注册的引擎从下拉里隐掉 —— 未就绪时用户**看不到** OMP 入口,不可能创建出
 * `Agent 'omp' is not registered` 的会话(不会白屏,也不会莫名报错)。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { app } from 'electron';

import { OMP_COMPATIBILITY_BASELINE, parseOmpVersionOutput } from '@cindy/maker-core';

import { findDevBinary } from '../agent-binaries/dev-fallback.js';
import { createLogger } from '../logger.js';
import { getPlatformKey } from '../manifestService.js';
import {
  getPinnedOmpRuntimeAsset,
  OMP_RUNTIME_PLATFORM_KEYS,
  verifyOmpRuntimeFile,
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
 * 打包态读 userData 下的受管落点(CDN 链尚未接入,没装就是 null)。两条路径都
 * 必须重新匹配固定 release pin 的文件尺寸和 SHA-256，不能只信任 marker、PATH
 * 或可执行位。
 * 刻意**不**走 `getReadyBinaryPath('omp')`:OMP 不在 CDN manifest 的必下清单里,
 * 不能让 splash 为它引入一次下载。
 */
export function resolveOmpBinaryPath(packaged: boolean = app.isPackaged): string | null {
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
  const candidate = !packaged
    ? findDevBinary({ vendorBinDir: 'omp-bin', binaryName: expected.binaryName })
    : path.join(app.getPath('userData'), 'omp-bin', platformKey, expected.binaryName);
  return candidate !== null && verifyOmpRuntimeFile(candidate, expected) ? candidate : null;
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

function computeSnapshot(packaged: boolean = app.isPackaged): OmpRuntimeSnapshot {
  const platformKey = getPlatformKey();
  const binaryPath = resolveOmpBinaryPath(packaged);
  const binaryUsable = binaryPath !== null;
  return classifyOmpRuntime({
    platformKey,
    platformSupported: SUPPORTED_PLATFORM_KEYS.has(platformKey),
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
 * `packaged` 显式入参(dev / 打包态路径策略不同)—— 默认取 electron,但单测
 * 与未来的诊断入口可以不经过 electron 直接问。
 */
export function getOmpRuntimeSnapshot(packaged: boolean = app.isPackaged): OmpRuntimeSnapshot {
  return cachedSnapshot ?? computeSnapshot(packaged);
}

/**
 * 采集完整三态(含一次 `omp --version`)并广播。
 *
 * 与 `getOmpRuntimeSnapshot` 的区别:只有它会把「版本对不上基线」判成 failed。
 * 已注册的 OMP agent 不会因为这次探测被摘掉(在跑的会话继续跑),但**下一次**
 * `getMaker()`(切账号 / 重启)会看到 failed 而不再注册。
 */
export async function refreshOmpRuntime(
  packaged: boolean = app.isPackaged,
): Promise<OmpRuntimeSnapshot> {
  const platformKey = getPlatformKey();
  const binaryPath = resolveOmpBinaryPath(packaged);
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
