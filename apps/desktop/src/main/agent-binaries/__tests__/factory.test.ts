/**
 * factory.ts(createBinaryProvisioner)emit 时序回归。
 *
 * 背景(2026-07):统一下载器是单槽 FIFO 串行,agent 二进制下载可能在队列里
 * 排在热更 zip 之后。factory 若在 `await download()` 之前就 emit 'downloading',
 * splash 会在排队期间显示一根冻结在 0% 的假进度条;fromCache 命中时还会闪
 * 0→100 假进度。约定:'downloading' 状态只能由传输层真实 onProgress 事件驱动。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { VendorRuntimeState } from '../types.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  fetchAppManifest: vi.fn(async () => {
    throw new Error('app update manifest unavailable');
  }),
  runtimeManifest: { current: { app: {} } as { app: Record<string, never> } | null },
}));

vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const FAKE_SHA = 'a'.repeat(64);

vi.mock('../../manifestService.js', () => ({
  fetchManifest: mocks.fetchAppManifest,
  getPlatformKey: () => 'win32-x64',
}));

vi.mock('../runtime-manifest.js', () => ({
  getRuntimeManifest: () => mocks.runtimeManifest.current,
  getRuntimeAssetBaseUrl: () => 'https://cdn.test',
}));

vi.mock('../manifest.js', () => ({
  getVendorAsset: () => ({
    version: '9.9.9-test',
    file: 'claude/claude-9.9.9.gz',
    sha256: FAKE_SHA,
    size: 3,
  }),
  resolveVendorAssetUrl: (base: string, asset: { file: string }) => `${base}/${asset.file}`,
}));

import { createBinaryProvisioner } from '../factory.js';

interface DownloadOpts {
  targetPath: string;
  onProgress?: (e: { loaded: number; total: number | null; percent: number | null; speedBps: number }) => void;
}

/** download mock 的成功实现:落一个真实 gzip 让后续解压走通。 */
function fulfillDownload(opts: DownloadOpts, fromCache: boolean): {
  path: string; size: number; sha256: string; fromCache: boolean; durationMs: number; resumedFromBytes: number;
} {
  fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
  fs.writeFileSync(opts.targetPath, gzipSync(Buffer.from('bin')));
  return {
    path: opts.targetPath,
    size: 3,
    sha256: FAKE_SHA,
    fromCache,
    durationMs: 1,
    resumedFromBytes: 0,
  };
}

function makeProvisioner() {
  // installSubdir 每个用例唯一,落在 electron-stub 的 tmp userData 下,互不污染。
  return createBinaryProvisioner({
    vendorKey: 'claude',
    manifestField: 'claudeCode',
    installSubdir: `factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    artifact: { kind: 'gz', binaryName: 'claude-test-bin' },
  });
}

beforeEach(() => {
  mocks.download.mockReset();
  mocks.fetchAppManifest.mockClear();
  mocks.runtimeManifest.current = { app: {} };
});

describe('createBinaryProvisioner emit 时序', () => {
  it('fromCache 命中(download 不产生 onProgress):全程不得 emit downloading', async () => {
    mocks.download.mockImplementation(async (opts: DownloadOpts) => fulfillDownload(opts, true));

    const statuses: Array<VendorRuntimeState['status']> = [];
    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    // 旧实现会在 download() 之前 emit 一次 downloading/0%,造成 splash 假进度条。
    expect(statuses).not.toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });

  it('真实下载:downloading 只能出现在 download() 的 onProgress 之后(排队期间无事件)', async () => {
    let statusesWhenDownloadInvoked: Array<VendorRuntimeState['status']> = [];
    const statuses: Array<VendorRuntimeState['status']> = [];

    mocks.download.mockImplementation(async (opts: DownloadOpts) => {
      // download() 被调用瞬间 = 任务刚入队(可能在队列里等热更 zip)。
      // 此刻不允许已有任何 downloading emit。
      statusesWhenDownloadInvoked = [...statuses];
      // 模拟排一拍队后传输真正开始,首个进度事件到达。
      await new Promise((r) => setTimeout(r, 10));
      opts.onProgress?.({ loaded: 1, total: 3, percent: 33.3, speedBps: 1024 });
      opts.onProgress?.({ loaded: 3, total: 3, percent: 100, speedBps: 1024 });
      return fulfillDownload(opts, false);
    });

    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    expect(statusesWhenDownloadInvoked).not.toContain('downloading');
    expect(statuses).toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });

  it('Linux-style fallback policy makes one short CDN attempt', async () => {
    mocks.download.mockImplementation(async (opts: DownloadOpts) => fulfillDownload(opts, false));
    const provisioner = createBinaryProvisioner({
      vendorKey: 'claude',
      manifestField: 'claudeCode',
      installSubdir: `factory-fast-fallback-${Date.now()}`,
      artifact: { kind: 'gz', binaryName: 'claude-test-bin' },
      fastNetworkFallback: true,
    });

    await expect(provisioner.prepare()).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({
      retry: { maxAttempts: 1 },
      timeout: { connectMs: 3_000 },
    }));
  });
});


describe('离线启动 fallback', () => {
  async function mountVerifiedBinary(
    installSubdir: string,
    version: string,
    binaryName: string,
  ): Promise<{ binPath: string; cleanup: () => void }> {
    const { app } = await import('electron');
    const installRoot = path.join(app.getPath('userData'), installSubdir);
    const versionDir = path.join(installRoot, version);
    fs.mkdirSync(versionDir, { recursive: true });
    const binPath = path.join(versionDir, binaryName);
    fs.writeFileSync(binPath, 'fake binary');
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(path.join(versionDir, '.verified'), '');
    return {
      binPath,
      cleanup: () => fs.rmSync(installRoot, { recursive: true, force: true }),
    };
  }

  it('内置 runtime 快照缺失时仍可复用本地已验证版本', async () => {
    const installSubdir = `offline-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '1.2.3-verified';
    const binaryName = 'test-binary';
    const local = await mountVerifiedBinary(installSubdir, version, binaryName);

    try {
      mocks.runtimeManifest.current = null;

      const provisioner = createBinaryProvisioner({
        vendorKey: 'claude',
        manifestField: 'testField',
        installSubdir,
        artifact: { kind: 'raw', binaryName },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(true);
      expect(result.binaryPath).toBe(local.binPath);
    } finally {
      local.cleanup();
    }
  });

  it('download 失败时:本地有已验证版本仍返回 ready', async () => {
    const installSubdir = `download-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '2.0.0-verified';
    const binaryName = 'test-binary';
    const local = await mountVerifiedBinary(installSubdir, version, binaryName);

    try {
      // Mock download to throw
      const downloader = await import('../../downloader/index.js');
      vi.mocked(downloader.download).mockRejectedValue(new Error('CDN blocked'));

      const provisioner = createBinaryProvisioner({
        vendorKey: 'claude',
        manifestField: 'claude',
        installSubdir,
        artifact: { kind: 'raw', binaryName },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(true);
      expect(result.binaryPath).toBe(local.binPath);
    } finally {
      local.cleanup();
    }
  });

  it('解压失败时:本地有已验证版本仍返回 ready', async () => {
    const installSubdir = `extract-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '3.0.0-verified';
    const binaryName = 'claude-test-bin';
    const local = await mountVerifiedBinary(installSubdir, version, binaryName);

    try {
      // A successful download followed by invalid gzip exercises the catch path
      // for extraction/verification failures, not just network failures.
      mocks.download.mockImplementation(async (opts: DownloadOpts) => {
        fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
        fs.writeFileSync(opts.targetPath, 'not gzip');
        return {
          path: opts.targetPath,
          size: 8,
          sha256: FAKE_SHA,
          fromCache: false,
          durationMs: 1,
          resumedFromBytes: 0,
        };
      });

      const provisioner = createBinaryProvisioner({
        vendorKey: 'claude',
        manifestField: 'claudeCode',
        installSubdir,
        artifact: { kind: 'gz', binaryName },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(true);
      expect(result.binaryPath).toBe(local.binPath);
    } finally {
      local.cleanup();
    }
  });

  it('可选 runtime 在 manifest 失败时不复用旧版本', async () => {
    const installSubdir = `optional-manifest-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const local = await mountVerifiedBinary(installSubdir, '4.0.0-verified', 'pi');

    try {
      mocks.runtimeManifest.current = null;

      const provisioner = createBinaryProvisioner({
        vendorKey: 'pi',
        manifestField: 'pi',
        installSubdir,
        optionalAsset: true,
        artifact: { kind: 'raw', binaryName: 'pi' },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(false);
      expect(result.error).toBe('manifest_failed');
    } finally {
      local.cleanup();
    }
  });

  it('可选 runtime 在下载失败时不复用旧版本', async () => {
    const installSubdir = `optional-download-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const local = await mountVerifiedBinary(installSubdir, '5.0.0-verified', 'pi');

    try {
      mocks.download.mockRejectedValue(new Error('CDN blocked'));

      const provisioner = createBinaryProvisioner({
        vendorKey: 'pi',
        manifestField: 'pi',
        installSubdir,
        optionalAsset: true,
        artifact: { kind: 'gz', binaryName: 'pi' },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(false);
      expect(result.error).toBe('unknown');
    } finally {
      local.cleanup();
    }
  });

  it('应用更新 manifest 不可用也不阻断全新 runtime 下载', async () => {
    mocks.download.mockImplementation(async (opts: DownloadOpts) => fulfillDownload(opts, false));

    const result = await makeProvisioner().prepare();

    expect(result.ready).toBe(true);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAppManifest).not.toHaveBeenCalled();
  });
});
