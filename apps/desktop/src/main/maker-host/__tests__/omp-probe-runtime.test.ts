import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPackaged: false,
  appPath: '',
  platformKey: `${process.platform}-${process.arch}`,
  getAppPath: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
    getAppPath: mocks.getAppPath,
  },
}));

vi.mock('../../manifestService.js', () => ({
  getPlatformKey: () => mocks.platformKey,
}));

import {
  __testing,
  getOmpProbeRuntimeDescriptor,
  resolveVerifiedOmpProbeRuntime,
  type OmpProbeRuntimeDescriptor,
} from '../omp-probe-runtime.js';

const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-omp-runtime-test-'));
  temporaryRoots.push(root);
  return root;
}

function descriptorFor(contents: Buffer): OmpProbeRuntimeDescriptor {
  return {
    version: 'test',
    platformKey: 'test-platform',
    binaryName: 'omp-test',
    sha256: createHash('sha256').update(contents).digest('hex'),
    size: contents.byteLength,
  };
}

beforeEach(() => {
  mocks.isPackaged = false;
  mocks.platformKey = `${process.platform}-${process.arch}`;
  mocks.appPath = '';
  mocks.getAppPath.mockReset();
  mocks.getAppPath.mockImplementation(() => mocks.appPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OMP development probe runtime', () => {
  it('rebuilds a fixed descriptor from the audited v18.1.18 pin', () => {
    const descriptor = getOmpProbeRuntimeDescriptor('win32-x64');
    expect(descriptor).toMatchObject({
      version: '18.1.18',
      platformKey: 'win32-x64',
      binaryName: 'omp.exe',
      size: 161_370_112,
      sha256: 'd9cf773ee3fd3823af9bc073c880fce4013920b2478bd5a02feff35920424378',
    });
    expect(() => getOmpProbeRuntimeDescriptor('linux-armv7l')).toThrow(
      'OMP development runtime pin is invalid',
    );
  });

  it('keeps every supported platform on the fixed binary name, size, and digest', () => {
    const expected = [
      [
        'darwin-arm64',
        'omp',
        135_659_152,
        '035a35dcb249edb939fa02b74fc7c0df9b2eb659079349fbffb188e1b558957a',
      ],
      [
        'darwin-x64',
        'omp',
        144_083_632,
        '29fead1b667dc969b825c5aa4798aadb5b7ec9b2f15c3304b10196d7afa4171d',
      ],
      [
        'linux-arm64',
        'omp',
        157_272_360,
        '1ae8273c231ceb88cebc9971901cf7f5d97ed4149cdc740a814f629cd2b4dcb2',
      ],
      [
        'linux-x64',
        'omp',
        201_098_720,
        '45421f9a5f112bc47cb9f77c4b4d7927631f8ff859624f821287ec854eb239fc',
      ],
      [
        'win32-arm64',
        'omp.exe',
        150_529_024,
        '4d8b68eb93f0e7dccfa6e8a400e42aa7e48b56c98f9debd324dc230452985af5',
      ],
      [
        'win32-x64',
        'omp.exe',
        161_370_112,
        'd9cf773ee3fd3823af9bc073c880fce4013920b2478bd5a02feff35920424378',
      ],
    ] as const;

    for (const [platformKey, binaryName, size, sha256] of expected) {
      expect(getOmpProbeRuntimeDescriptor(platformKey)).toMatchObject({
        version: '18.1.18',
        platformKey,
        binaryName,
        size,
        sha256,
      });
    }
  });

  it('accepts only an unchanged executable with the expected exact digest and size', async () => {
    const root = fixtureRoot();
    const binary = path.join(root, 'omp-test');
    const contents = Buffer.from('verified OMP test runtime');
    fs.writeFileSync(binary, contents);
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    const descriptor = descriptorFor(contents);

    await expect(__testing.verifyRuntimeFile(binary, descriptor)).resolves.toBe(true);
    fs.writeFileSync(binary, Buffer.from('verifiex OMP test runtime'));
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    await expect(__testing.verifyRuntimeFile(binary, descriptor)).resolves.toBe(false);
    await expect(__testing.verifyRuntimeFile('relative-omp-test', descriptor)).resolves.toBe(false);
  });

  it('only searches the explicit repo-local omp-bin locations', () => {
    const root = fixtureRoot();
    const descriptor = getOmpProbeRuntimeDescriptor('win32-x64');
    const appPath = path.join(root, 'apps', 'desktop');
    const workingDirectory = path.join(root, 'other-worktree');
    const candidates = __testing.candidatePaths(descriptor, appPath, workingDirectory);

    expect(candidates).toEqual([
      path.join(root, 'apps', 'omp-bin', 'win32-x64', 'omp.exe'),
      path.join(workingDirectory, 'apps', 'omp-bin', 'win32-x64', 'omp.exe'),
    ]);
    expect(candidates.every((candidate) => path.isAbsolute(candidate))).toBe(true);
  });

  it('refuses packaged builds before it looks for a local binary', async () => {
    mocks.isPackaged = true;
    await expect(resolveVerifiedOmpProbeRuntime()).rejects.toThrow('development-only');
    expect(mocks.getAppPath).not.toHaveBeenCalled();
  });

  it('does not use PATH or an arbitrary file when the managed local runtime is absent', async () => {
    const root = fixtureRoot();
    mocks.appPath = path.join(root, 'apps', 'desktop');
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await expect(resolveVerifiedOmpProbeRuntime()).rejects.toThrow(
      'OMP development runtime is unavailable',
    );
  });
});
