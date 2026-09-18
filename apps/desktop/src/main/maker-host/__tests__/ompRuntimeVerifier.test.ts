import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getPinnedOmpRuntimeAsset,
  OMP_RUNTIME_PLATFORM_KEYS,
  verifyOmpRuntimeFile,
  type OmpPinnedRuntimeAsset,
} from '../omp-runtime-verifier.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'lex-omp-runtime-verifier-'));
  roots.push(root);
  return root;
}

function descriptor(platformKey: string, bytes: Buffer): OmpPinnedRuntimeAsset {
  return {
    platformKey,
    binaryName: platformKey.startsWith('win32') ? 'omp.exe' : 'omp',
    url: `https://example.test/${platformKey}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function writeExecutable(root: string, name: string, bytes: Buffer): string {
  const filePath = path.join(root, name);
  writeFileSync(filePath, bytes);
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
  return filePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OMP runtime pin verifier', () => {
  it('contains the six fixed v18.1.18 platform assets with their expected names', () => {
    expect(OMP_RUNTIME_PLATFORM_KEYS).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    expect(getPinnedOmpRuntimeAsset('win32-x64')).toMatchObject({
      binaryName: 'omp.exe',
      url: 'https://github.com/can1357/oh-my-pi/releases/download/v18.1.18/omp-windows-x64.exe',
    });
    expect(getPinnedOmpRuntimeAsset('linux-x64')).toMatchObject({ binaryName: 'omp' });
    expect(getPinnedOmpRuntimeAsset('linux-armv7l')).toBeUndefined();
  });

  it('accepts only a regular executable file with the exact pinned size and digest', () => {
    const root = makeRoot();
    const expectedBytes = Buffer.alloc(1024, 0x61);
    const platformKey = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
    const expected = descriptor(platformKey, expectedBytes);
    const verified = writeExecutable(root, expected.binaryName, expectedBytes);
    const sameSizeWrongHash = writeExecutable(root, 'wrong-content', Buffer.alloc(1024, 0x62));
    const wrongSize = writeExecutable(root, 'wrong-size', Buffer.alloc(1025, 0x61));

    expect(verifyOmpRuntimeFile(verified, expected)).toBe(true);
    expect(verifyOmpRuntimeFile(sameSizeWrongHash, expected)).toBe(false);
    expect(verifyOmpRuntimeFile(wrongSize, expected)).toBe(false);
    expect(verifyOmpRuntimeFile('relative-runtime', expected)).toBe(false);
  });

  it('rejects a symlink even when its target has the pinned bytes', () => {
    const root = makeRoot();
    const expectedBytes = Buffer.alloc(1024, 0x63);
    const platformKey = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
    const expected = descriptor(platformKey, expectedBytes);
    const target = writeExecutable(root, expected.binaryName, expectedBytes);
    const link = path.join(root, `linked-${expected.binaryName}`);
    try {
      symlinkSync(target, link, 'file');
    } catch {
      // Windows policies can forbid test symlinks. The verifier is still
      // exercised where the platform permits creating this fixture.
      return;
    }

    expect(verifyOmpRuntimeFile(link, expected)).toBe(false);
  });
});
