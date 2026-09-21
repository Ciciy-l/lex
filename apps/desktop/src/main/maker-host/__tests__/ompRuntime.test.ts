/**
 * ompRuntime.test.ts —— OMP 运行时三态(未就绪 / 下载中 / 失败 / 就绪)判定。
 *
 * 覆盖两条真出过事的语义:
 *   1. 三态必须**互斥且完备**:二进制不在位时,下载中优先于"没装",下载失败
 *      又优先于"没装" —— 把 downloading 判成 not-ready 会让 UI 一直显示"去安装"。
 *   2. 版本冲突只能由**探测到**的版本触发:探不出来(null)按 ready,否则一次
 *      execFile 抖动(超时 / 杀进程)就会把一个能用的运行时判死。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  platformKey: 'win32-x64',
  cachedBinary: null as string | null,
  shipsOmpRuntime: true,
}));

// 注意:这些 specifier 相对**测试文件**(__tests__/ 下),所以比 omp-runtime 里的
// 同名 import 多一层 `../` —— 写错了 mock 会静默不生效(真实模块照常加载)。
vi.mock('../../manifestService.js', () => ({
  getPlatformKey: () => env.platformKey,
}));

vi.mock('../../agent-binaries/index.js', () => ({
  getCachedBinaryStatus: () =>
    env.cachedBinary
      ? { binaryReady: true, binaryPath: env.cachedBinary }
      : { binaryReady: false },
  buildShipsOmpRuntime: () => env.shipsOmpRuntime,
}));

vi.mock('../omp-runtime-verifier.js', () => ({
  OMP_RUNTIME_PLATFORM_KEYS: [
    'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
  ],
  getPinnedOmpRuntimeAsset: (platformKey: string) => ({
    platformKey,
    binaryName: platformKey.startsWith('win32') ? 'omp.exe' : 'omp',
    url: `https://example.test/${platformKey}`,
    sha256: 'a'.repeat(64),
    size: 1024,
  }),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('@cindy/maker-core', () => ({
  OMP_COMPATIBILITY_BASELINE: '18.1.18',
  parseOmpVersionOutput: (output: string) => {
    const match = /^omp\/(\d+\.\d+\.\d+)\r?\n$/.exec(output);
    return match?.[1];
  },
}));

import {
  classifyOmpRuntime,
  getOmpRuntimeSnapshot,
  isLocalOmpRuntimePending,
  noteOmpRuntimeDownloadFailed,
  noteOmpRuntimeDownloadStarted,
  noteOmpRuntimeDownloadSucceeded,
  ompBinaryName,
  peekOmpRuntimeSnapshot,
  resetOmpRuntimeForTest,
  resolveOmpBinaryPath,
  subscribeOmpRuntime,
  type OmpDownloadPhase,
  type OmpRuntimeFacts,
} from '../omp-runtime';

const IDLE: OmpDownloadPhase = { kind: 'idle' };

function facts(overrides: Partial<OmpRuntimeFacts> = {}): OmpRuntimeFacts {
  return {
    platformKey: 'win32-x64',
    platformSupported: true,
    binaryPath: null,
    binaryUsable: false,
    reportedVersion: null,
    download: IDLE,
    ...overrides,
  };
}

describe('classifyOmpRuntime', () => {
  it('reports not-ready when the binary was never installed', () => {
    const snapshot = classifyOmpRuntime(facts());
    expect(snapshot.state).toBe('not-ready');
    expect(snapshot.reason).toBe('not-installed');
    expect(snapshot.binaryPath).toBeNull();
  });

  it('reports downloading while an install is in flight', () => {
    const snapshot = classifyOmpRuntime(
      facts({ download: { kind: 'running', detail: '42%' } }),
    );
    expect(snapshot.state).toBe('downloading');
    expect(snapshot.reason).toBe('downloading');
  });

  it('reports failed with the downloader detail after a failed install', () => {
    const snapshot = classifyOmpRuntime(
      facts({ download: { kind: 'failed', detail: 'sha256 mismatch' } }),
    );
    expect(snapshot.state).toBe('failed');
    expect(snapshot.reason).toBe('download-failed');
    expect(snapshot.detail).toBe('sha256 mismatch');
  });

  it('reports failed when the platform has no release asset', () => {
    const snapshot = classifyOmpRuntime(
      facts({ platformKey: 'freebsd-x64', platformSupported: false }),
    );
    expect(snapshot.state).toBe('failed');
    expect(snapshot.reason).toBe('platform-unsupported');
  });

  it('reports ready when the binary is usable and matches the baseline', () => {
    const snapshot = classifyOmpRuntime(
      facts({
        binaryPath: '/omp/omp.exe',
        binaryUsable: true,
        reportedVersion: '18.1.18',
      }),
    );
    expect(snapshot.state).toBe('ready');
    expect(snapshot.reason).toBeNull();
    expect(snapshot.binaryPath).toBe('/omp/omp.exe');
  });

  it('treats an unprobed but usable binary as ready (probe failure must not kill it)', () => {
    const snapshot = classifyOmpRuntime(facts({ binaryPath: '/omp/omp', binaryUsable: true }));
    expect(snapshot.state).toBe('ready');
  });

  it('reports failed when the probed version diverges from the baseline', () => {
    const snapshot = classifyOmpRuntime(
      facts({ binaryPath: '/omp/omp', binaryUsable: true, reportedVersion: '19.0.0' }),
    );
    expect(snapshot.state).toBe('failed');
    expect(snapshot.reason).toBe('version-mismatch');
  });

  it('keeps a usable binary ready even while an update downloads in the background', () => {
    const snapshot = classifyOmpRuntime(
      facts({ binaryPath: '/omp/omp', binaryUsable: true, download: { kind: 'running' } }),
    );
    expect(snapshot.state).toBe('ready');
  });
});

describe('ompBinaryName', () => {
  it('adds .exe only on windows', () => {
    expect(ompBinaryName('win32-x64')).toBe('omp.exe');
    expect(ompBinaryName('win32-arm64')).toBe('omp.exe');
    expect(ompBinaryName('linux-x64')).toBe('omp');
    expect(ompBinaryName('darwin-arm64')).toBe('omp');
  });
});

describe('resolveOmpBinaryPath', () => {
  beforeEach(() => {
    resetOmpRuntimeForTest();
    env.cachedBinary = null;
    env.platformKey = 'win32-x64';
  });

  afterEach(() => {
    resetOmpRuntimeForTest();
  });

  it('uses only the already verified path published by agent-binaries', () => {
    env.cachedBinary = '/repo/apps/omp-bin/win32-x64/omp.exe';
    expect(resolveOmpBinaryPath()).toBe('/repo/apps/omp-bin/win32-x64/omp.exe');
  });

  it('refuses a missing or unverified managed runtime', () => {
    expect(resolveOmpBinaryPath()).toBeNull();
  });

  it('returns null when the opt-in binary was never downloaded', () => {
    expect(resolveOmpBinaryPath()).toBeNull();
  });

  it('uses the same managed status gate in packaged mode', () => {
    env.cachedBinary = '/ud/omp/18.1.18/omp';
    env.platformKey = 'linux-x64';
    expect(resolveOmpBinaryPath()).toBe('/ud/omp/18.1.18/omp');
  });
});

describe('download phase reporting', () => {
  beforeEach(() => {
    resetOmpRuntimeForTest();
    env.cachedBinary = null;
  });

  afterEach(() => {
    resetOmpRuntimeForTest();
  });

  it('moves not-ready → downloading → failed → not-ready', () => {
    expect(getOmpRuntimeSnapshot().state).toBe('not-ready');
    expect(noteOmpRuntimeDownloadStarted().state).toBe('downloading');
    expect(noteOmpRuntimeDownloadFailed('network down').state).toBe('failed');
    expect(noteOmpRuntimeDownloadSucceeded().state).toBe('not-ready');
  });

  it('publishes state changes to subscribers', () => {
    const seen: string[] = [];
    const off = subscribeOmpRuntime((snapshot) => {
      seen.push(snapshot.state);
    });
    noteOmpRuntimeDownloadStarted();
    noteOmpRuntimeDownloadFailed('boom');
    off();
    noteOmpRuntimeDownloadSucceeded();
    expect(seen).toEqual(['downloading', 'failed']);
  });
});

describe('fresh snapshot reads', () => {
  beforeEach(() => {
    resetOmpRuntimeForTest();
    env.cachedBinary = null;
  });

  afterEach(() => {
    resetOmpRuntimeForTest();
  });

  it('peekOmpRuntimeSnapshot recomputes instead of returning the published cache', () => {
    // 缓存快照在 Maker 构造那一刻就被固定，而受管下载是在那之后完成的。
    // 读缓存会把已就绪的运行时判成 not-ready，补注册随之永远失败。
    expect(getOmpRuntimeSnapshot().state).toBe('not-ready');
    noteOmpRuntimeDownloadStarted('managed OMP runtime prepare');
    expect(getOmpRuntimeSnapshot().state).toBe('downloading');

    env.cachedBinary = '/ud/omp/18.1.18/omp.exe';
    const fresh = peekOmpRuntimeSnapshot();
    expect(fresh.state).toBe('ready');
    expect(fresh.binaryPath).toBe('/ud/omp/18.1.18/omp.exe');
    // 缓存必须保持原样：peek 是只读探测，不覆盖 publish 的状态。
    expect(getOmpRuntimeSnapshot().state).toBe('downloading');
  });
});

describe('isLocalOmpRuntimePending', () => {
  it('treats a runtime that is merely not installed yet as pending', () => {
    expect(isLocalOmpRuntimePending(classifyOmpRuntime(facts()))).toBe(true);
  });

  it('treats an in-flight download as pending', () => {
    expect(
      isLocalOmpRuntimePending(classifyOmpRuntime(facts({ download: { kind: 'running' } }))),
    ).toBe(true);
  });

  it('keeps the slot free while the failure is one a retry can fix', () => {
    // 受管下载还会每 30s 重试;此时注册 remote-only agent,网络恢复后也换不掉。
    for (const error of ['NETWORK', 'HTTP_5XX', 'ABORTED', 'manifest_failed']) {
      expect(
        isLocalOmpRuntimePending(
          classifyOmpRuntime(facts({ download: { kind: 'failed', detail: error } })),
        ),
        error,
      ).toBe(true);
    }
  });

  it('falls back to remote-only once the failure is permanent', () => {
    // recovery 已经放弃(不排重试),本地已无希望 → 允许 remote-only 注册走 SSH。
    // 否则一次 HTTP_4XX / CHECKSUM 就会让 OMP 从引擎列表里彻底消失。
    for (const error of ['HTTP_4XX', 'CHECKSUM', 'DISK', 'asset_invalid', 'asset_missing']) {
      expect(
        isLocalOmpRuntimePending(
          classifyOmpRuntime(facts({ download: { kind: 'failed', detail: error } })),
        ),
        error,
      ).toBe(false);
    }
  });

  it('falls back to remote-only when the installed binary misses the baseline', () => {
    const snapshot = classifyOmpRuntime(
      facts({ binaryPath: '/omp/omp.exe', binaryUsable: true, reportedVersion: '17.0.0' }),
    );
    expect(snapshot.reason).toBe('version-mismatch');
    expect(isLocalOmpRuntimePending(snapshot)).toBe(false);
  });

  it('does not treat a ready runtime as pending', () => {
    expect(
      isLocalOmpRuntimePending(
        classifyOmpRuntime(facts({ binaryPath: '/omp/omp.exe', binaryUsable: true })),
      ),
    ).toBe(false);
  });

  it('does not treat a platform without any OMP asset as pending', () => {
    // 唯一允许直接注册 remote-only agent 的终态:本地运行时永远不可能出现。
    expect(
      isLocalOmpRuntimePending(
        classifyOmpRuntime(facts({ platformKey: 'freebsd-x64', platformSupported: false })),
      ),
    ).toBe(false);
  });
});

describe('platform support', () => {
  beforeEach(() => {
    resetOmpRuntimeForTest();
    env.cachedBinary = null;
    env.shipsOmpRuntime = true;
  });

  afterEach(() => {
    resetOmpRuntimeForTest();
    env.shipsOmpRuntime = true;
  });

  it('treats a platform the build ships no OMP asset for as unsupported', () => {
    // latest.json 有 6 平台,构建资产表只发 4 个。缺资产的平台上受管准备不可能成功,
    // 必须按「平台不支持」处理,否则启动页出一个必然失败的下载段并陷入死循环重试。
    env.shipsOmpRuntime = false;
    const snapshot = peekOmpRuntimeSnapshot();
    expect(snapshot.state).toBe('failed');
    expect(snapshot.reason).toBe('platform-unsupported');
    // 「本地已无希望」→ 允许 remote-only 注册,SSH 仍可用。
    expect(isLocalOmpRuntimePending(snapshot)).toBe(false);
  });

  it('keeps a shipped platform installable while its binary is still missing', () => {
    expect(peekOmpRuntimeSnapshot().reason).toBe('not-installed');
  });
});

describe('packaged OMP startup policy', () => {
  const readSource = (): string =>
    fs.readFileSync(path.resolve(process.cwd(), 'src/main/bootstrap-electron.ts'), 'utf8');

  /** OMP 受管准备的唯一入口(splash 段与后台 recovery 共用)。 */
  const readPrepareOmpRuntime = (source: string): string =>
    source.slice(
      source.indexOf('const prepareOmpRuntime ='),
      source.indexOf('const ompRuntimeRecovery ='),
    );

  it('prepares OMP inside the splash serial queue, before the Maker is constructed', () => {
    // Source-contract test on purpose: bootstrapping Electron is
    // integration-heavy, while the safety property is strict ordering in this
    // one handler. OMP shares the managed queue with claude/codex/pi (same
    // provisioner, different source), and its prepare must finish before
    // registerMakerIpcsAfterSplash() — otherwise the Maker is built without a
    // local runtime and Maker.registerAgent's additive contract locks in a
    // remote-only agent for the whole process.
    const source = readSource();
    const handlerStart = source.indexOf("ipcMain.handle('check-environment'");
    const handlerEnd = source.indexOf('\n  // Codex 元 IPC', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    // OMP 自己的那段(不是 pi 段)。
    const ompSegment = handler.slice(handler.indexOf('Phase 4: omp 段'));

    const peeked = handler.indexOf("binaryPeekNeedsDownload(kind)");
    const prepared = ompSegment.indexOf('await prepareOmpRuntime(');
    const registered = handler.indexOf('await registerMakerIpcsAfterSplash();');

    expect(peeked).toBeGreaterThan(-1);
    expect(prepared).toBeGreaterThan(-1);
    expect(registered).toBeGreaterThan(-1);
    expect(prepared).toBeLessThan(registered);
    expect(handler).toContain("'claude-code', 'codex', 'pi', 'omp'");
    expect(ompSegment).toContain('OMP_AGENT_INSTALL_STARTUP_DEADLINE_MS');
    // 失败必须交给后台 recovery，且把结果回报给三态机。
    expect(ompSegment).toContain('ompRuntimeRecovery.markUnavailable(');
  });

  it('keeps the OMP prepare non-fatal and reports its outcome to the three-state machine', () => {
    const prepareOmpRuntime = readPrepareOmpRuntime(readSource());
    expect(prepareOmpRuntime).toContain("binaryPrepare('omp'");
    // 失败不能把 splash 打进失败态。
    expect(prepareOmpRuntime).toContain('broadcastFailure: false');
    expect(prepareOmpRuntime).toContain('noteOmpRuntimeDownloadStarted(');
    expect(prepareOmpRuntime).toContain('noteOmpRuntimeDownloadSucceeded()');
    expect(prepareOmpRuntime).toContain('noteOmpRuntimeDownloadFailed(');
  });
});
