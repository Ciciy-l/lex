/**
 * Resolves the development-only OMP binary used by the isolated capability
 * probe. It deliberately does not download, execute, or register OMP as a
 * production agent runtime. Packaged builds must have a separately reviewed
 * runtime-snapshot contract before this becomes available there.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { OMP_COMPATIBILITY_BASELINE } from '@cindy/maker-core';

import ompRuntimePin from '../../../../../tools/omp/latest.json';
import { getPlatformKey } from '../manifestService.js';

const OMP_RELEASE_ROOT = 'https://github.com/can1357/oh-my-pi/releases/download';

const PLATFORM_FILES = Object.freeze({
  'darwin-arm64': { assetName: 'omp-darwin-arm64', binaryName: 'omp' },
  'darwin-x64': { assetName: 'omp-darwin-x64', binaryName: 'omp' },
  'linux-arm64': { assetName: 'omp-linux-arm64', binaryName: 'omp' },
  'linux-x64': { assetName: 'omp-linux-x64', binaryName: 'omp' },
  'win32-arm64': { assetName: 'omp-windows-arm64.exe', binaryName: 'omp.exe' },
  'win32-x64': { assetName: 'omp-windows-x64.exe', binaryName: 'omp.exe' },
});

type OmpPlatformKey = keyof typeof PLATFORM_FILES;

export interface OmpProbeRuntimeDescriptor {
  readonly version: string;
  readonly platformKey: string;
  readonly binaryName: string;
  readonly sha256: string;
  readonly size: number;
}

export interface OmpProbeRuntime extends OmpProbeRuntimeDescriptor {
  readonly binaryPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rebuild the descriptor from the committed pin rather than trusting a marker,
 * PATH, Pi's runtime, or a mutable release response. This is also kept
 * separate from the production agent-binaries registry so OMP cannot become a
 * packaged runtime by accident.
 */
export function getOmpProbeRuntimeDescriptor(
  platformKey: string = getPlatformKey(),
): OmpProbeRuntimeDescriptor {
  const platform = PLATFORM_FILES[platformKey as OmpPlatformKey];
  const pin = ompRuntimePin as unknown;
  if (
    !platform ||
    !isRecord(pin) ||
    pin.version !== OMP_COMPATIBILITY_BASELINE ||
    pin.tag_name !== `v${OMP_COMPATIBILITY_BASELINE}` ||
    !isRecord(pin.runtimeAssets)
  ) {
    throw new Error('OMP development runtime pin is invalid');
  }
  const asset = pin.runtimeAssets[platformKey];
  const expectedUrl = `${OMP_RELEASE_ROOT}/v${OMP_COMPATIBILITY_BASELINE}/${platform.assetName}`;
  if (
    !isRecord(asset) ||
    asset.url !== expectedUrl ||
    typeof asset.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
    typeof asset.size !== 'number' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1024
  ) {
    throw new Error('OMP development runtime pin is invalid');
  }
  return Object.freeze({
    version: OMP_COMPATIBILITY_BASELINE,
    platformKey,
    binaryName: platform.binaryName,
    sha256: asset.sha256,
    size: asset.size,
  });
}

function candidatePaths(
  descriptor: OmpProbeRuntimeDescriptor,
  appPath: string = app.getAppPath(),
  workingDirectory: string = process.cwd(),
): readonly string[] {
  const candidates = [
    path.resolve(
      appPath,
      '..',
      '..',
      'apps',
      'omp-bin',
      descriptor.platformKey,
      descriptor.binaryName,
    ),
    path.resolve(
      workingDirectory,
      'apps',
      'omp-bin',
      descriptor.platformKey,
      descriptor.binaryName,
    ),
  ];
  return Object.freeze([...new Set(candidates)]);
}

function isExecutableFile(stat: fs.Stats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
  );
}

function sameFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk: Buffer) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function sameDigest(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(actual) || !/^[0-9a-f]{64}$/u.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

async function verifyRuntimeFile(
  candidate: string,
  descriptor: OmpProbeRuntimeDescriptor,
): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  let before: fs.Stats;
  try {
    before = fs.lstatSync(candidate);
    if (!isExecutableFile(before) || before.size !== descriptor.size) return false;
  } catch {
    return false;
  }

  let digest: string;
  try {
    digest = await sha256File(candidate);
  } catch {
    return false;
  }

  try {
    const after = fs.lstatSync(candidate);
    return sameFile(before, after) && sameDigest(digest, descriptor.sha256);
  } catch {
    return false;
  }
}

/**
 * Return only a locally pinned OMP development binary. This cannot fall back
 * to PATH, Pi, user configuration, a sibling-worktree search, downloads, or
 * a packaged runtime directory.
 */
export async function resolveVerifiedOmpProbeRuntime(): Promise<OmpProbeRuntime> {
  if (app.isPackaged)
    throw new Error(
      'OMP capability probing is development-only until a packaged runtime snapshot is reviewed',
    );

  const descriptor = getOmpProbeRuntimeDescriptor();
  for (const candidate of candidatePaths(descriptor)) {
    if (await verifyRuntimeFile(candidate, descriptor))
      return Object.freeze({ ...descriptor, binaryPath: candidate });
  }
  throw new Error(
    `OMP development runtime is unavailable for ${descriptor.platformKey}; run pnpm install:omp`,
  );
}

/** Test-only pure hooks; production callers must use resolveVerifiedOmpProbeRuntime. */
export const __testing = Object.freeze({
  candidatePaths,
  verifyRuntimeFile,
});
