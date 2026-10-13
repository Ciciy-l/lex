import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';
import codexPin from '../../../../../../tools/codex-package/latest.json';
import { RUNTIME_ARCHIVE_LIMITS } from '../toolArchive.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { olderStableVersion, PINNED_CLAUDE_VERSION } from './runtimeVersionFixtures';

const { appMock, downloadMock, execFileMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true, getPath: vi.fn<(name: string) => string>() },
  downloadMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('electron', () => ({
  app: appMock,
  net: { request: vi.fn() },
}));
vi.mock('../../downloader/index.js', () => ({ download: downloadMock }));

const originalPlatform = process.platform;
let fallback: typeof import('../linux-runtime-fallback');
let tempDir = '';

function claudeVersionOutput(version = PINNED_CLAUDE_VERSION): string {
  return `${version} (Claude Code)\n`;
}

function claudeExecutable(version = PINNED_CLAUDE_VERSION): string {
  return `#!/bin/sh\necho "${version} (Claude Code)"\n`;
}

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  fallback = await import('../linux-runtime-fallback');
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-linux-runtime-migration-'));
  appMock.getPath.mockReturnValue(tempDir);
  downloadMock.mockReset();
  execFileMock.mockReset();
  downloadMock.mockRejectedValue(new Error('network download must not run during migration'));
  execFileMock.mockImplementation((
    command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (command === '/bin/sh') {
      callback(new Error('system lookup disabled in migration test'), '', '');
      return;
    }
    callback(null, claudeVersionOutput(), '');
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('legacy managed binary migration', () => {
  it('allows an older verified private runtime only when startup upgrade checks are disabled', () => {
    const binaryPath = fallback.privateBinaryPath(tempDir, 'claude-code');
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, 'local runtime', { mode: 0o755 });
    const versionMarker = path.join(fallback.runtimeInstallRoot(tempDir, 'claude-code'), '.version');
    fs.writeFileSync(versionMarker, olderStableVersion(PINNED_CLAUDE_VERSION));
    expect(fallback.findCachedLinuxRuntimeFallbackBinary('claude-code')).toBeNull();
    expect(fallback.findCachedLinuxRuntimeFallbackBinary('claude-code', false)).toBe(binaryPath);
    fs.unlinkSync(versionMarker);
    expect(fallback.findCachedLinuxRuntimeFallbackBinary('claude-code', false)).toBeNull();
  });

  it('reuses and atomically migrates the exact pinned Claude cache without network access', async () => {
    const legacyPath = fallback.legacyManagedBinaryPath(tempDir, 'claude-code');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, claudeExecutable(), { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(legacyPath), '.verified'), '');

    const result = await fallback.prepareLinuxRuntimeFallback('claude-code');

    expect(result).toMatchObject({ ready: true, installed: false, source: 'legacy' });
    expect(result.binaryPath).toBe(fallback.privateBinaryPath(tempDir, 'claude-code'));
    expect(fs.readFileSync(result.binaryPath, 'utf8')).toContain(PINNED_CLAUDE_VERSION);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('installs the pin instead of selecting an older system Claude runtime', async () => {
    const systemClaude = '/usr/local/bin/claude';
    execFileMock.mockImplementation((
      command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (command === '/bin/sh') {
        callback(null, `${systemClaude}\n`, '');
        return;
      }
      callback(
        null,
        command === systemClaude
          ? claudeVersionOutput(olderStableVersion(PINNED_CLAUDE_VERSION))
          : claudeVersionOutput(),
        '',
      );
    });
    downloadMock.mockImplementationOnce(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, claudeExecutable(), { mode: 0o755 });
      return {
        path: targetPath,
        size: fs.statSync(targetPath).size,
        sha256: 'test',
        fromCache: false,
        durationMs: 0,
        resumedFromBytes: 0,
      };
    });

    const result = await fallback.prepareLinuxRuntimeFallback('claude-code');

    expect(result).toMatchObject({ ready: true, installed: true, source: 'installed' });
    expect(result.binaryPath).toBe(fallback.privateBinaryPath(tempDir, 'claude-code'));
    expect(downloadMock).toHaveBeenCalledOnce();
  });
});

describe('full Linux Codex fallback installation', () => {
  it.each(['complete', 'incomplete', 'wrong-target', 'bad-version', 'cancelled'] as const)(
    'downloads the full pin and publishes only a verified %s package',
    async (scenario) => {
      const root = fallback.runtimeInstallRoot(tempDir, 'codex');
      const oldBinary = fallback.privateBinaryPath(tempDir, 'codex');
      fs.mkdirSync(path.dirname(oldBinary), { recursive: true });
      fs.writeFileSync(oldBinary, 'old standalone', { mode: 0o755 });
      fs.writeFileSync(path.join(root, '.version'), '0.0.1\n');
      const asset = codexPin.runtimeAssets[`linux-${process.arch}` as 'linux-x64' | 'linux-arm64'];
      const source = path.join(tempDir, 'package-source');
      const files = [
        'bin/codex',
        'bin/codex-code-mode-host',
        'codex-path/rg',
        'codex-resources/runtime.json',
      ];
      for (const file of files) {
        if (scenario === 'incomplete' && file === 'bin/codex-code-mode-host') continue;
        const target = path.join(source, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file, { mode: 0o755 });
      }
      fs.writeFileSync(
        path.join(source, 'codex-package.json'),
        JSON.stringify({
          layoutVersion: 1,
          version: codexPin.version,
          variant: 'codex',
          entrypoint: 'bin/codex',
          target: scenario === 'wrong-target' ? 'wrong-architecture' : asset.target,
          pathDir: 'codex-path',
          resourcesDir: 'codex-resources',
        }),
      );
      const controller = new AbortController();
      execFileMock.mockImplementation(
        (
          command: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (command === '/bin/sh' || !fs.existsSync(command)) {
            callback(new Error('no compatible local CLI'), '', '');
            return;
          }
          callback(
            null,
            `codex-cli ${command === oldBinary || scenario === 'bad-version' ? '0.0.1' : codexPin.version}\n`,
            '',
          );
        },
      );
      downloadMock.mockImplementationOnce(async ({ targetPath }: { targetPath: string }) => {
        await createTar({ gzip: true, file: targetPath, cwd: source }, fs.readdirSync(source));
        if (scenario === 'cancelled') controller.abort();
      });
      const installation = fallback.prepareLinuxRuntimeFallback('codex', {
        signal: controller.signal,
      });
      const directory = path.join(root, 'codex-package', codexPin.version);
      if (scenario === 'complete') {
        await expect(installation).resolves.toMatchObject({
          ready: true,
          installed: true,
          source: 'installed',
          binaryPath: path.join(directory, 'bin', 'codex'),
        });
        for (const file of files)
          expect(fs.readFileSync(path.join(directory, file), 'utf8')).toBe(file);
        expect(fallback.findCachedLinuxRuntimeFallbackBinary('codex')).toBe(
          path.join(directory, 'bin', 'codex'),
        );
        fs.unlinkSync(path.join(directory, 'bin', 'codex-code-mode-host'));
        expect(fallback.findCachedLinuxRuntimeFallbackBinary('codex')).toBeNull();
      } else {
        await expect(installation).rejects.toThrow();
        expect(fs.existsSync(directory)).toBe(false);
        expect(fs.existsSync(path.join(root, '.package-version'))).toBe(false);
      }
      expect(downloadMock).toHaveBeenCalledOnce();
      expect(downloadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: asset.url,
          sha256: asset.sha256,
          expectedSize: asset.size,
          maxBytes: RUNTIME_ARCHIVE_LIMITS.archiveBytes,
        }),
      );
      expect(fs.readFileSync(oldBinary, 'utf8')).toBe('old standalone');
      expect(fs.readFileSync(path.join(root, '.version'), 'utf8')).toBe('0.0.1\n');
      expect(
        fs
          .readdirSync(path.dirname(directory))
          .some((name) => name.startsWith('.stage-') || name.startsWith('.previous-')),
      ).toBe(false);
    },
  );
});
