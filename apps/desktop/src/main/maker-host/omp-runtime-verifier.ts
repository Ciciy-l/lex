/**
 * Immutable OMP runtime pin and local-file verifier.
 *
 * The development installer verifies this same committed release pin before it
 * promotes an asset. Desktop must repeat the verification before it registers
 * or launches OMP: a matching .version marker or executable bit is not enough
 * to give a local binary the session proxy environment.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

import { OMP_COMPATIBILITY_BASELINE } from '@cindy/maker-core';

import ompLatest from '../../../../../tools/omp/latest.json';

const OMP_RELEASE_BASE_URL = 'https://github.com/can1357/oh-my-pi/releases/download';
const HASH_CHUNK_BYTES = 1024 * 1024;

const platformAssets = Object.freeze([
  { key: 'darwin-arm64', asset: 'omp-darwin-arm64', binaryName: 'omp' },
  { key: 'darwin-x64', asset: 'omp-darwin-x64', binaryName: 'omp' },
  { key: 'linux-arm64', asset: 'omp-linux-arm64', binaryName: 'omp' },
  { key: 'linux-x64', asset: 'omp-linux-x64', binaryName: 'omp' },
  { key: 'win32-arm64', asset: 'omp-windows-arm64.exe', binaryName: 'omp.exe' },
  { key: 'win32-x64', asset: 'omp-windows-x64.exe', binaryName: 'omp.exe' },
] as const);

export const OMP_RUNTIME_PLATFORM_KEYS = Object.freeze(platformAssets.map((entry) => entry.key));

export interface OmpPinnedRuntimeAsset {
  readonly platformKey: string;
  readonly binaryName: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

interface OmpRuntimePin {
  readonly version?: unknown;
  readonly tag_name?: unknown;
  readonly runtimeAssets?: Record<string, {
    readonly url?: unknown;
    readonly sha256?: unknown;
    readonly size?: unknown;
  } | undefined>;
}

function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sameFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
  );
}

function sha256File(filePath: string): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest();
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A failed close cannot turn a failed verification into acceptance.
      }
    }
  }
}

/**
 * Return the immutable expected asset for one supported host platform.
 *
 * An unsupported platform has no OMP runtime. A malformed committed pin is a
 * programming/release error and is deliberately not treated as a usable asset.
 */
export function getPinnedOmpRuntimeAsset(platformKey: string): OmpPinnedRuntimeAsset | undefined {
  const platform = platformAssets.find((entry) => entry.key === platformKey);
  if (!platform) return undefined;

  const pin = ompLatest as OmpRuntimePin;
  const raw = pin.runtimeAssets?.[platformKey];
  const url = raw?.url;
  const sha256 = raw?.sha256;
  const size = raw?.size;
  const expectedUrl = `${OMP_RELEASE_BASE_URL}/v${OMP_COMPATIBILITY_BASELINE}/${platform.asset}`;
  if (
    pin.version !== OMP_COMPATIBILITY_BASELINE
    || pin.tag_name !== `v${OMP_COMPATIBILITY_BASELINE}`
    || url !== expectedUrl
    || !isValidSha256(sha256)
    || typeof size !== 'number'
    || !Number.isSafeInteger(size)
    || size < 1024
  ) {
    throw new Error(`OMP development runtime pin is invalid for ${platformKey}`);
  }

  return Object.freeze({
    platformKey,
    binaryName: platform.binaryName,
    url,
    sha256,
    size,
  });
}

/**
 * Check the exact pinned bytes without loading the whole runtime in memory.
 *
 * The pre/post identity comparison narrows ordinary replace-during-hash races;
 * it is not an OS-level lock or a claim against a same-user hostile replacer.
 */
export function verifyOmpRuntimeFile(
  filePath: string,
  expected: OmpPinnedRuntimeAsset,
): boolean {
  if (
    typeof filePath !== 'string'
    || !filePath
    || !isValidSha256(expected?.sha256)
    || !Number.isSafeInteger(expected?.size)
    || expected.size < 1024
  ) {
    return false;
  }

  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size !== expected.size
    || (!expected.platformKey.startsWith('win32') && (before.mode & 0o111) === 0)
  ) {
    return false;
  }

  const actual = sha256File(filePath);
  if (!actual) return false;

  let after: fs.Stats;
  try {
    after = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!sameFileIdentity(before, after)) return false;

  const wanted = Buffer.from(expected.sha256, 'hex');
  return wanted.length === actual.length && timingSafeEqual(wanted, actual);
}
