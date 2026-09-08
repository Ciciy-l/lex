import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { create as createTar } from 'tar';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  fetchAppManifest: vi.fn(async () => {
    throw new Error('release manifest returned 404');
  }),
}));

vi.mock('../../manifestService.js', () => ({
  fetchManifest: mocks.fetchAppManifest,
  getPlatformKey: () => `${process.platform}-${process.arch}`,
  resolveManifestAssetUrl: (baseUrl: string, file: string) =>
    `${baseUrl.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`,
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

import { createBinaryProvisioner } from '../factory.js';

const installRoots: string[] = [];
const stagingRoots: string[] = [];
const claudeBinaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
const codexBinaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';

beforeAll(() => {
  mocks.download.mockImplementation(async (opts: { targetPath: string }) => {
    fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
    if (opts.targetPath.endsWith('.dist.tar.gz')) {
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-codex-runtime-'));
      stagingRoots.push(sourceRoot);
      const binaryPath = path.join(sourceRoot, 'bin', codexBinaryName);
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(binaryPath, 'codex');
      await createTar(
        { gzip: true, file: opts.targetPath, cwd: sourceRoot },
        ['bin'],
      );
    } else {
      fs.writeFileSync(opts.targetPath, gzipSync(Buffer.from('claude')));
    }
    return {
      path: opts.targetPath,
      size: fs.statSync(opts.targetPath).size,
      sha256: 'a'.repeat(64),
      fromCache: false,
      durationMs: 1,
      resumedFromBytes: 0,
    };
  });
});

afterAll(() => {
  for (const root of [...installRoots, ...stagingRoots]) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('fresh-install runtime bootstrap', () => {
  it('factory provisions Claude and Codex while the Lex app update manifest is unavailable', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const claudeInstallSubdir = `fresh-install-claude-${suffix}`;
    const codexInstallSubdir = `fresh-install-codex-${suffix}`;
    const { app } = await import('electron');
    installRoots.push(
      path.join(app.getPath('userData'), claudeInstallSubdir),
      path.join(app.getPath('userData'), codexInstallSubdir),
    );

    const claude = createBinaryProvisioner({
      vendorKey: 'claude',
      manifestField: 'claudeCode',
      installSubdir: claudeInstallSubdir,
      artifact: { kind: 'gz', binaryName: claudeBinaryName },
    });
    const codex = createBinaryProvisioner({
      vendorKey: 'codex',
      manifestField: 'codexPackage',
      installSubdir: codexInstallSubdir,
      artifact: { kind: 'tar-gz-dir', binaryName: path.join('bin', codexBinaryName) },
    });

    const [claudeResult, codexResult] = await Promise.all([
      claude.prepare(),
      codex.prepare(),
    ]);

    expect(claudeResult.ready).toBe(true);
    expect(
      codexResult.ready,
      JSON.stringify({ result: codexResult, state: await codex.getState() }),
    ).toBe(true);
    expect(fs.existsSync(claudeResult.binaryPath)).toBe(true);
    expect(fs.existsSync(codexResult.binaryPath)).toBe(true);
    expect(mocks.fetchAppManifest).not.toHaveBeenCalled();
  });

  it('uses the packaged agent-binaries route without consulting the app update manifest', async () => {
    const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-packaged-bootstrap-'));
    installRoots.push(userDataRoot);
    const { app } = await import('electron');
    const originalIsPackaged = Object.getOwnPropertyDescriptor(app, 'isPackaged');
    const getPathSpy = vi.spyOn(app, 'getPath').mockImplementation((name: string) =>
      name === 'userData' ? userDataRoot : path.join(userDataRoot, name),
    );
    Object.defineProperty(app, 'isPackaged', {
      configurable: true,
      value: true,
    });

    try {
      const binaries = await import('../index.js');
      const claude = await binaries.prepare('claude-code', { broadcastProgress: false });
      const codex = await binaries.prepare('codex', { broadcastProgress: false });

      expect(claude.ready, JSON.stringify(claude)).toBe(true);
      expect(codex.ready, JSON.stringify(codex)).toBe(true);
      expect(mocks.fetchAppManifest).not.toHaveBeenCalled();
    } finally {
      getPathSpy.mockRestore();
      if (originalIsPackaged) Object.defineProperty(app, 'isPackaged', originalIsPackaged);
      else Reflect.deleteProperty(app, 'isPackaged');
    }
  });
});
