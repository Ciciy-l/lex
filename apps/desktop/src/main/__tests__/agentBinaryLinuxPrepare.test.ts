import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// getBase() 按 kind 缓存 provisioner 实例:全部测试共享同一个 cdndProvisioner,
// 每测试重配它的行为(而不是 mockReturnValueOnce 换实例——缓存会让新实例永远不被使用)。
const {
  appMock,
  cdndProvisioner,
  createBinaryProvisioner,
  findDevBinary,
  findCachedLinuxRuntimeFallbackBinary,
  findUsableLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
  runtimeManifest,
  probeBinaryVersion,
  consumeStartupBinaryUpdateMarker,
} = vi.hoisted(() => {
  const cdndProvisioner = {
    prepare: vi.fn(),
    peekNeedsDownload: vi.fn(),
    getState: vi.fn(async () => ({ status: 'not_installed' })),
    cleanup: vi.fn(),
  };
  return {
    appMock: { isPackaged: true, getPath: vi.fn(() => '/tmp/xdt-userdata'), getVersion: () => '1.0.0' },
    cdndProvisioner,
    createBinaryProvisioner: vi.fn(() => cdndProvisioner),
    findDevBinary: vi.fn((): string | null => null),
    findCachedLinuxRuntimeFallbackBinary: vi.fn((): string | null => null),
    findUsableLinuxRuntimeFallbackBinary: vi.fn(async (): Promise<string | null> => null),
    prepareLinuxRuntimeFallback: vi.fn(),
    runtimeManifest: {
      current: {
        app: { version: '0.0.0-runtime-assets' },
        claudeCode: {
          version: '2.1.259',
          file: 'claude-code/2.1.259/linux-x64/claude.gz',
          sha256: 'a'.repeat(64),
          size: 1234,
        },
        codexPackage: {
          version: '0.153.0',
          file: 'codex-package/0.153.0/linux-x64/codex-package.dist.tar.gz',
          sha256: 'b'.repeat(64),
          size: 5678,
        },
      } as Record<string, unknown> | null,
    },
    probeBinaryVersion: vi.fn(),
    consumeStartupBinaryUpdateMarker: vi.fn(() => true),
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../agent-binaries/factory.js', () => ({ createBinaryProvisioner }));
vi.mock('../agent-binaries/dev-fallback.js', () => ({ findDevBinary }));
vi.mock('../agent-binaries/binary-version-probe.js', () => ({ probeBinaryVersion }));
vi.mock('../agent-binaries/startup-update.js', () => ({ consumeStartupBinaryUpdateMarker }));
vi.mock('../agent-binaries/linux-runtime-fallback.js', () => ({
  findCachedLinuxRuntimeFallbackBinary,
  findUsableLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
}));
vi.mock('../manifestService.js', () => ({
  getPlatformKey: () => 'linux-x64',
}));
vi.mock('../agent-binaries/runtime-manifest.js', () => ({
  getRuntimeManifest: () => runtimeManifest.current,
}));
vi.mock('../updateProgressNormalizer.js', () => ({
  ProgressNormalizer: class {
    handle(): void {}
    flush(): void {}
    getCurrent(): number { return 0; }
  },
}));

const originalPlatform = process.platform;
let binaries: typeof import('../agent-binaries/index');

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

async function reloadBinaries(): Promise<void> {
  vi.resetModules();
  binaries = await import('../agent-binaries/index');
}

beforeEach(async () => {
  await reloadBinaries();
  vi.clearAllMocks();
  appMock.isPackaged = true;
  // 默认:CDN 链失败(asset_missing)→ 回落 fallback;fallback 命中私有安装。
  cdndProvisioner.prepare.mockReset().mockResolvedValue({ ready: false, binaryPath: '', error: 'asset_missing' });
  cdndProvisioner.peekNeedsDownload.mockReset().mockResolvedValue(true);
  runtimeManifest.current = {
    app: { version: '0.0.0-runtime-assets' },
    claudeCode: {
      version: '2.1.259',
      file: 'claude-code/2.1.259/linux-x64/claude.gz',
      sha256: 'a'.repeat(64),
      size: 1234,
    },
    codexPackage: {
      version: '0.153.0',
      file: 'codex-package/0.153.0/linux-x64/codex-package.dist.tar.gz',
      sha256: 'b'.repeat(64),
      size: 5678,
    },
  };
  findDevBinary.mockReset().mockReturnValue(null);
  findCachedLinuxRuntimeFallbackBinary.mockReturnValue(null);
  findUsableLinuxRuntimeFallbackBinary.mockReset().mockResolvedValue(null);
  consumeStartupBinaryUpdateMarker.mockReturnValue(true);
  probeBinaryVersion.mockReset().mockResolvedValue('1.0.0');
  prepareLinuxRuntimeFallback.mockResolvedValue({
    ready: true,
    binaryPath: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
    installed: true,
    source: 'installed',
  });
});

describe('startup binary update policy forwarding', () => {
  it.each([true, false])('passes checkForUpdates=false through prepare with broadcastProgress=%s', async (broadcastProgress) => {
    const binaryPath = path.join('/tmp/xdt-userdata', 'claude-code', '1.0.0', 'claude');
    cdndProvisioner.prepare.mockResolvedValue({ ready: true, binaryPath });
    await expect(binaries.prepare('claude-code', { checkForUpdates: false, broadcastProgress }))
      .resolves.toMatchObject({ ready: true, path: binaryPath });
    expect(cdndProvisioner.prepare).toHaveBeenCalledWith(expect.objectContaining({ checkForUpdates: false }));
    expect(binaries.getReadyBinaryPath('claude-code')).toBe(binaryPath);
  });

  it('keeps a usable Linux fallback instead of downloading a newer CDN asset on an ordinary startup', async () => {
    const binaryPath = path.join('/tmp/xdt-userdata', 'agent-runtime', 'claude-code', 'bin', 'claude');
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(binaryPath);
    findUsableLinuxRuntimeFallbackBinary.mockResolvedValue(binaryPath);
    const options = { checkForUpdates: false };
    await expect(binaries.peekNeedsDownload('claude-code', options)).resolves.toBe(false);
    await expect(binaries.prepare('claude-code', options)).resolves.toEqual({ ready: true, path: binaryPath, downloaded: false });
    expect(findUsableLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('claude-code', undefined);
    expect(cdndProvisioner.prepare).not.toHaveBeenCalled();
    expect(prepareLinuxRuntimeFallback).not.toHaveBeenCalled();
    expect(binaries.getReadyBinaryPath('claude-code')).toBe(binaryPath);
  });

  it('does not skip the CDN version check after an update relaunch even with a local Linux fallback', async () => {
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(path.join('/tmp/xdt-userdata', 'old-claude'));
    const binaryPath = path.join('/tmp/xdt-userdata', 'new-claude');
    cdndProvisioner.prepare.mockResolvedValue({ ready: true, binaryPath });
    await expect(binaries.prepare('claude-code', { checkForUpdates: true }))
      .resolves.toMatchObject({ ready: true, path: binaryPath });
    expect(cdndProvisioner.prepare).toHaveBeenCalledWith(expect.objectContaining({ checkForUpdates: true }));
  });

  it('repairs a cached Linux fallback that is present but cannot run', async () => {
    const brokenPath = path.join('/tmp/xdt-userdata', 'old-claude');
    const repairedPath = path.join('/tmp/xdt-userdata', 'new-claude');
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(brokenPath);
    probeBinaryVersion.mockResolvedValue(null);
    cdndProvisioner.prepare.mockResolvedValue({ ready: true, binaryPath: repairedPath });
    await expect(binaries.prepare('claude-code', { checkForUpdates: false }))
      .resolves.toMatchObject({ ready: true, path: repairedPath });
    expect(findUsableLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('claude-code', undefined);
    expect(cdndProvisioner.prepare).toHaveBeenCalledOnce();
  });

  it('keeps the managed CDN runtime ahead of an older Linux fallback on ordinary startup', async () => {
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(path.join('/tmp/xdt-userdata', 'old-claude'));
    findUsableLinuxRuntimeFallbackBinary.mockResolvedValue(path.join('/tmp/xdt-userdata', 'old-claude'));
    const binaryPath = path.join('/tmp/xdt-userdata', 'managed-claude');
    cdndProvisioner.peekNeedsDownload.mockResolvedValue(false);
    cdndProvisioner.prepare.mockResolvedValue({ ready: true, binaryPath });
    await expect(binaries.prepare('claude-code', { checkForUpdates: false }))
      .resolves.toMatchObject({ ready: true, path: binaryPath });
    expect(cdndProvisioner.prepare).toHaveBeenCalledWith(expect.objectContaining({ checkForUpdates: false }));
    expect(findUsableLinuxRuntimeFallbackBinary).not.toHaveBeenCalled();
  });

  it('keeps first-install fallback working when update checks are disabled and the CDN is unavailable', async () => {
    await expect(binaries.prepare('claude-code', { checkForUpdates: false })).resolves.toMatchObject({ ready: true });
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledOnce();
  });

  it.each(['darwin', 'win32'] as const)('forwards the ordinary startup policy for %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      cdndProvisioner.prepare.mockResolvedValue({ ready: true, binaryPath: path.join('/tmp/xdt-userdata', 'claude') });
      await binaries.peekNeedsDownload('claude-code', { checkForUpdates: false });
      await binaries.prepare('claude-code', { checkForUpdates: false });
      expect(cdndProvisioner.peekNeedsDownload).toHaveBeenCalledWith({ checkForUpdates: false });
      expect(cdndProvisioner.prepare).toHaveBeenCalledWith(expect.objectContaining({ checkForUpdates: false }));
    } finally {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    }
  });
});

describe('dev Codex package selection', () => {
  it('starts Codex from the complete local package entrypoint', async () => {
    appMock.isPackaged = false;
    const expectedPath = '/repo/apps/codex-package-bin/linux-x64/bin/codex';
    findDevBinary.mockReturnValue(expectedPath);

    await expect(binaries.prepare('codex')).resolves.toEqual({
      ready: true,
      path: expectedPath,
      downloaded: false,
    });
    expect(findDevBinary).toHaveBeenCalledWith({
      vendorBinDir: 'codex-package-bin',
      binaryName: path.join('bin', 'codex'),
    });
    expect(createBinaryProvisioner).not.toHaveBeenCalled();
  });

  it('starts the packaged release from the complete Codex package entrypoint', async () => {
    const expectedPath = path.join(
      '/tmp/xdt-userdata',
      'codex-package',
      '0.153.0',
      'bin',
      'codex',
    );
    cdndProvisioner.prepare.mockResolvedValueOnce({
      ready: true,
      binaryPath: expectedPath,
    });

    await expect(binaries.prepare('codex')).resolves.toMatchObject({
      ready: true,
      path: expectedPath,
    });
    expect(createBinaryProvisioner).toHaveBeenCalledWith(expect.objectContaining({
      manifestField: 'codexPackage',
      installSubdir: 'codex-package',
      artifact: { kind: 'tar-gz-dir', binaryName: path.join('bin', 'codex') },
      fastNetworkFallback: true,
    }));
  });
});

describe('packaged Linux agent binary prepare', () => {
  it('keeps cached status fs-only and does not run runtime verification', () => {
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(
      '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    );

    expect(binaries.getCachedBinaryStatus('codex')).toEqual({
      binaryReady: true,
      binaryPath: '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    });
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
  });

  it('falls back to the runtime chain when the CDN chain reports asset_missing', async () => {
    prepareLinuxRuntimeFallback.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/usr/local/bin/claude',
      installed: false,
      source: 'system',
    });

    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/usr/local/bin/claude',
      downloaded: false,
    });
    // CDN 链先试(manifest 无段 → asset_missing),失败后静默落到 fallback。
    expect(cdndProvisioner.prepare).toHaveBeenCalled();
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledWith('claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
  });

  it('propagates signal and returns fallback install result when CDN misses', async () => {
    const controller = new AbortController();
    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
      downloaded: true,
    });
    await binaries.prepare('codex', { signal: controller.signal });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(1, 'claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(2, 'codex', {
      signal: controller.signal,
      onProgress: expect.any(Function),
    });
  });

  it('prefers the CDN chain when the built-in snapshot publishes a linux asset', async () => {
    cdndProvisioner.prepare.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/tmp/xdt-userdata/claude-code/2.1.219/claude',
    });

    const result = await binaries.prepare('claude-code');

    expect(result.ready).toBe(true);
    expect(result.path).toBe('/tmp/xdt-userdata/claude-code/2.1.219/claude');
    expect(prepareLinuxRuntimeFallback).not.toHaveBeenCalled();
  });

  it('survives a throwing CDN chain and still resolves via the fallback', async () => {
    cdndProvisioner.prepare.mockReset().mockRejectedValue(new Error('disk exploded'));

    const result = await binaries.prepare('claude-code');

    expect(result.ready).toBe(true);
    expect(result.path).toBe('/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude');
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalled();
  });

  it('peek uses the built-in snapshot without requesting the app update manifest', async () => {
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(cdndProvisioner.peekNeedsDownload).toHaveBeenCalled();
    expect(findCachedLinuxRuntimeFallbackBinary).not.toHaveBeenCalled();
  });

  it('peek falls back to the fs check when this build has no platform snapshot', async () => {
    runtimeManifest.current = null;
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
    expect(cdndProvisioner.peekNeedsDownload).not.toHaveBeenCalled();
  });

  it('the separate app update channel never suppresses the CDN runtime leg', async () => {
    await expect(binaries.peekNeedsDownload('claude-code')).resolves.toBe(true);
    const result = await binaries.prepare('claude-code');
    expect(result.ready).toBe(true);
    expect(cdndProvisioner.prepare).toHaveBeenCalled();
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalled();
  });

  it('peek delegates to the CDN check when the snapshot publishes a linux asset', async () => {
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(cdndProvisioner.peekNeedsDownload).toHaveBeenCalled();
    expect(findCachedLinuxRuntimeFallbackBinary).not.toHaveBeenCalled();
  });

  it('gives the CDN leg its own signal and preserves the original one for the fallback', async () => {
    const controller = new AbortController();
    // CDN 腿失败(模拟拖满自身预算),fallback 必须收到原始未中止的 signal,
    // 否则官方源兜底会在共享 deadline 被耗尽时名存实亡。
    cdndProvisioner.prepare.mockReset().mockRejectedValue(new Error('cdn leg timed out'));

    const result = await binaries.prepare('claude-code', { signal: controller.signal });

    expect(result.ready).toBe(true);
    // CDN 腿收到的是包装后的独立 signal,不是调用方原始 signal。
    const cdnArgs = cdndProvisioner.prepare.mock.calls[0][0];
    expect(cdnArgs.signal).toBeInstanceOf(AbortSignal);
    expect(cdnArgs.signal).not.toBe(controller.signal);
    // fallback 收到的是原始 signal(未被 CDN 腿污染)。
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
