import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({
  root: '',
  version: '18.2.0',
  badProbe: false,
  waiting: false,
  blocked: false,
  downloads: 0,
  checks: 0,
  checkFailure: null as Error | null,
  downloadFailure: null as Error | null,
}));
vi.mock('electron', () => ({ app: { getPath: () => env.root }, net: { fetch: vi.fn() } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../index.js', () => ({
  getCachedBinaryStatus: () => ({ binaryReady: true, binaryPath: path.join(env.root, 'current') }),
}));
vi.mock('../../device-link/crossProcessLock.js', () => ({
  withSecurityBoundaryLock: async (
    _path: string,
    _opts: unknown,
    action: (status: { held: boolean }) => unknown,
  ) => action({ held: !env.blocked }),
}));
vi.mock('../binary-version-probe.js', () => ({
  probeBinaryVersion: async (file: string) =>
    file.endsWith('current') ? '18.1.18' : env.badProbe ? '99.0.0' : env.version,
}));
vi.mock('../harness-releases.js', () => {
  const artifact = (source: string, version: string) => ({
    source,
    version,
    url: 'https://github.com/official/asset',
    sha256: 'a'.repeat(64),
    executable: process.platform === 'win32' ? 'omp.exe' : 'omp',
    format: 'binary',
  });
  return {
    harnessExecutable: () => (process.platform === 'win32' ? 'omp.exe' : 'omp'),
    baselineArtifact: () => artifact('baseline', '18.1.18'),
    upstreamArtifact: async () => {
      env.checks++;
      if (env.checkFailure) throw env.checkFailure;
      return artifact('upstream', env.version);
    },
  };
});
vi.mock('../../downloader/index.js', () => ({
  download: async ({ targetPath, signal }: { targetPath: string; signal: AbortSignal }) => {
    env.downloads++;
    if (env.downloadFailure) throw env.downloadFailure;
    if (env.waiting)
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    await fs.writeFile(targetPath, 'verified-publisher-binary');
  },
}));

beforeEach(async () => {
  vi.resetModules();
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-harness-'));
  Object.assign(env, {
    version: '18.2.0',
    badProbe: false,
    waiting: false,
    blocked: false,
    downloads: 0,
    checks: 0,
    checkFailure: null,
    downloadFailure: null,
  });
  await fs.writeFile(path.join(env.root, 'current'), 'running baseline');
});
afterEach(async () => {
  await fs.rm(env.root, { recursive: true, force: true });
});
describe('managed Harness installation', () => {
  it('reports asset lookup as a check failure, allows a forced recovery, and isolates other engines', async () => {
    const manager = await import('../harness-manager.js');
    env.checkFailure = new Error('RELEASE_HAS_NO_VERIFIED_ASSET');
    expect(await manager.checkHarness('pi')).toMatchObject({
      phase: 'failed',
      failureStage: 'check',
      error: 'RELEASE_HAS_NO_VERIFIED_ASSET',
      upstream: null,
    });
    expect(env.downloads).toBe(0);
    env.checkFailure = null;
    expect(await manager.checkHarness('omp')).toMatchObject({ phase: 'idle', error: null });
    expect(await manager.checkHarness('pi', true)).toMatchObject({
      phase: 'idle',
      error: null,
      failureStage: null,
    });
  });

  it('distinguishes query, download and version errors without returning raw paths', async () => {
    const manager = await import('../harness-manager.js');
    env.checkFailure = new Error('private path or response');
    expect(await manager.checkHarness('omp')).toMatchObject({
      error: 'RUNTIME_CHECK_FAILED',
      failureStage: 'check',
    });
    env.checkFailure = null;
    await manager.checkHarness('omp', true);
    env.downloadFailure = Object.assign(new Error('private download URL'), { code: 'TIMEOUT' });
    expect(
      await manager.installHarness({ kind: 'omp', source: 'upstream', version: env.version }),
    ).toMatchObject({ error: 'TIMEOUT', failureStage: 'download', selectedVersion: null });
    env.downloadFailure = null;
    env.badProbe = true;
    expect(
      await manager.installHarness({ kind: 'omp', source: 'upstream', version: env.version }),
    ).toMatchObject({
      error: 'RUNTIME_VERSION_MISMATCH',
      failureStage: 'verify',
      selectedVersion: null,
    });
  });
  it('caches checks, stages a verified selection, and activates it only in the next process', async () => {
    const manager = await import('../harness-manager.js');
    const selection = await import('../harness-selection.js');
    await manager.checkHarness('omp');
    await manager.checkHarness('omp');
    expect(env.checks).toBe(1);
    expect(env.downloads).toBe(0);
    const state = await manager.installHarness({
      kind: 'omp',
      source: 'upstream',
      version: '18.2.0',
    });
    expect(state).toMatchObject({
      phase: 'ready',
      restartRequired: true,
      selectedVersion: '18.2.0',
    });
    expect(selection.activeHarnessPath('omp')).toBeNull();
    expect(await fs.readFile(path.join(env.root, 'current'), 'utf8')).toBe('running baseline');
    vi.resetModules();
    const restarted = await import('../harness-selection.js');
    const binary = restarted.activeHarnessPath('omp');
    expect(binary).not.toBeNull();
    await fs.writeFile(binary!, 'tampered');
    expect(restarted.activeHarnessPath('omp')).toBeNull();
  });
  it('leaves the previous selection intact after a bad version or cancelled download', async () => {
    const manager = await import('../harness-manager.js');
    const selection = await import('../harness-selection.js');
    await manager.checkHarness('omp');
    await manager.installHarness({ kind: 'omp', source: 'upstream', version: env.version });
    const before = selection.readHarnessSelection('omp');
    env.badProbe = true;
    expect(
      (await manager.installHarness({ kind: 'omp', source: 'upstream', version: env.version }))
        .phase,
    ).toBe('failed');
    expect(selection.readHarnessSelection('omp')).toEqual(before);
    env.waiting = true;
    const pending = manager.installHarness({
      kind: 'omp',
      source: 'upstream',
      version: env.version,
    });
    await vi.waitFor(() => expect(env.downloads).toBe(3));
    manager.cancelHarness('omp');
    expect((await pending).phase).toBe('cancelled');
    expect(selection.readHarnessSelection('omp')).toEqual(before);
  });
  it('rejects versions not checked by the host and respects the cross-process lock', async () => {
    const manager = await import('../harness-manager.js');
    await expect(
      manager.installHarness({ kind: 'omp', source: 'upstream', version: '99.0.0' }),
    ).rejects.toThrow('REFRESH_RELEASE_LIST');
    await manager.checkHarness('omp');
    env.blocked = true;
    expect(
      (await manager.installHarness({ kind: 'omp', source: 'upstream', version: env.version }))
        .error,
    ).toBe('RUNTIME_BUSY');
    expect(env.downloads).toBe(0);
  });
});
