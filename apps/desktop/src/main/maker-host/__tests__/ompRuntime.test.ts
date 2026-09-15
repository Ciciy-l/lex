/**
 * ompRuntime.test.ts —— OMP 运行时三态(未就绪 / 下载中 / 失败 / 就绪)判定。
 *
 * 覆盖两条真出过事的语义:
 *   1. 三态必须**互斥且完备**:二进制不在位时,下载中优先于"没装",下载失败
 *      又优先于"没装" —— 把 downloading 判成 not-ready 会让 UI 一直显示"去安装"。
 *   2. 版本冲突只能由**探测到**的版本触发:探不出来(null)按 ready,否则一次
 *      execFile 抖动(超时 / 杀进程)就会把一个能用的运行时判死。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  platformKey: 'win32-x64',
  packaged: false,
  devBinary: null as string | null,
  userData: '/ud',
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return env.packaged;
    },
    getPath: () => env.userData,
    getAppPath: () => '/ap',
  },
}));

// 注意:这些 specifier 相对**测试文件**(__tests__/ 下),所以比 omp-runtime 里的
// 同名 import 多一层 `../` —— 写错了 mock 会静默不生效(真实模块照常加载)。
vi.mock('../../manifestService.js', () => ({
  getPlatformKey: () => env.platformKey,
}));

vi.mock('../../agent-binaries/dev-fallback.js', () => ({
  findDevBinary: () => env.devBinary,
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
    env.packaged = false;
    env.devBinary = null;
    env.platformKey = 'win32-x64';
    env.userData = '/ud';
  });

  afterEach(() => {
    resetOmpRuntimeForTest();
  });

  it('uses the opt-in dev tree in development', () => {
    env.devBinary = '/repo/apps/omp-bin/win32-x64/omp.exe';
    expect(resolveOmpBinaryPath(false)).toBe('/repo/apps/omp-bin/win32-x64/omp.exe');
  });

  it('returns null when the opt-in binary was never downloaded', () => {
    expect(resolveOmpBinaryPath(false)).toBeNull();
  });

  it('never reads the dev tree when packaged', () => {
    env.devBinary = '/repo/apps/omp-bin/win32-x64/omp.exe';
    env.platformKey = 'linux-x64';
    // 打包态只读 userData 下的受管落点;dev 仓库里的产物对打包态没有意义。
    expect(resolveOmpBinaryPath(true)).toBeNull();
  });
});

describe('download phase reporting', () => {
  beforeEach(() => {
    resetOmpRuntimeForTest();
    env.packaged = false;
    env.devBinary = null;
  });

  afterEach(() => {
    resetOmpRuntimeForTest();
  });

  it('moves not-ready → downloading → failed → not-ready', () => {
    expect(getOmpRuntimeSnapshot(false).state).toBe('not-ready');
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
