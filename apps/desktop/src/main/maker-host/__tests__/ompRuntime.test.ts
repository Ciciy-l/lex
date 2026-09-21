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
  noteOmpRuntimeDownloadFailed,
  noteOmpRuntimeDownloadStarted,
  noteOmpRuntimeDownloadSucceeded,
  ompBinaryName,
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

describe('packaged OMP startup policy', () => {
  it('starts automatic OMP preparation only after Maker IPC registration, outside splash work', () => {
    // This is deliberately a source-contract test: bootstrapping Electron is
    // integration-heavy, while the safety property is strict ordering in this
    // one handler. OMP must never be awaited in the splash serial chain.
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/bootstrap-electron.ts'), 'utf8');
    const handlerStart = source.indexOf("ipcMain.handle('check-environment'");
    const handlerEnd = source.indexOf('\n  // Codex 元 IPC', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const registered = handler.indexOf('await registerMakerIpcsAfterSplash();');
    const started = handler.indexOf("void ompRuntimeRecovery.start('startup-after-maker-ipcs');");

    expect(registered).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(registered);
    expect(handler).not.toContain("await binaryPrepare('omp'");
    expect(handler).not.toContain("binaryPeekNeedsDownload('omp'");
  });
});
