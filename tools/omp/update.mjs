#!/usr/bin/env node

/**
 * Prepare the one audited Oh My Pi runtime for local development.
 *
 * This intentionally is not an "update to latest" command. OMP's RPC adapter
 * is audited against one upstream version, so a new runtime must first be
 * reviewed and paired with an adapter baseline change. The script only obtains
 * the version pinned in latest.json and verifies the live GitHub asset metadata
 * against the committed URL, SHA-256, and size before it downloads anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createDownloadProgressLogger,
  downloadToFileWithTimeout,
  fetchJsonWithTimeout,
} from '../shared/fetch-with-timeout.mjs';
import {
  normalizeExpectedSha256,
  sha256File,
  verifyFileSha256OrRemove,
} from '../shared/verify-sha256.mjs';

export const OMP_COMPATIBILITY_BASELINE = '18.1.18';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'omp-bin');
const RELEASE_URL = (tag) => `https://api.github.com/repos/can1357/oh-my-pi/releases/tags/${tag}`;
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

export const OMP_RELEASE_PLATFORMS = Object.freeze([
  { key: 'darwin-arm64', asset: 'omp-darwin-arm64', file: 'omp' },
  { key: 'darwin-x64', asset: 'omp-darwin-x64', file: 'omp' },
  { key: 'linux-arm64', asset: 'omp-linux-arm64', file: 'omp' },
  { key: 'linux-x64', asset: 'omp-linux-x64', file: 'omp' },
  { key: 'win32-arm64', asset: 'omp-windows-arm64.exe', file: 'omp.exe' },
  { key: 'win32-x64', asset: 'omp-windows-x64.exe', file: 'omp.exe' },
]);

function githubHeaders() {
  const headers = { 'User-Agent': 'lex-omp-runtime-pin' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

function readPin() {
  try {
    const value = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function readPinnedVersion() {
  const pin = readPin();
  return typeof pin?.version === 'string' ? pin.version : null;
}

function requireAuditedVersion(version) {
  if (version !== OMP_COMPATIBILITY_BASELINE) {
    throw new Error(
      `OMP ${version} is not the audited RPC baseline ${OMP_COMPATIBILITY_BASELINE}; ` +
        'update the adapter review and pin together before obtaining a new runtime.',
    );
  }
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isUsableCache(filePath) {
  try {
    if (fs.statSync(filePath).size < 1024) return false;
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(64);
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      return !buffer.subarray(0, read).toString('utf8').startsWith(LFS_POINTER_HEADER);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

function platformFor(platformKey) {
  const platform = OMP_RELEASE_PLATFORMS.find((entry) => entry.key === platformKey);
  if (!platform) {
    throw new Error(
      `Unknown OMP platform ${platformKey} (known: ${OMP_RELEASE_PLATFORMS.map((entry) => entry.key).join(', ')})`,
    );
  }
  return platform;
}

/**
 * Resolve the immutable local expectation used both before a download and when
 * an already-installed development runtime is considered for reuse.  Keeping
 * this separate from the mutable GitHub response is intentional: a local
 * binary may be trusted only when it matches the audited source pin exactly.
 */
function pinnedRuntimeAsset(pin, version, platformKey) {
  requireAuditedVersion(version);
  if (!pin || pin.version !== version || pin.tag_name !== `v${version}`) {
    throw new Error(`OMP runtime pin is missing for ${platformKey}@${version}`);
  }

  const platform = platformFor(platformKey);
  const expected = pin.runtimeAssets?.[platformKey];
  const sha256 = normalizeExpectedSha256(expected?.sha256);
  if (
    !expected ||
    typeof expected.url !== 'string' ||
    !sha256 ||
    sha256 !== expected.sha256 ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1024
  ) {
    throw new Error(`OMP runtime pin is invalid for ${platformKey}@${version}`);
  }
  return { expected: { ...expected, sha256 }, platform };
}

/**
 * Return whether a file exactly matches a pinned asset without deleting it.
 * This is deliberately non-destructive because callers may be inspecting a
 * sibling worktree.  The promoted runtime path uses the removing verifier
 * below, where Lex owns the destination and can safely self-heal.
 */
export function isVerifiedRuntimeFile(filePath, expected) {
  const sha256 = normalizeExpectedSha256(expected?.sha256);
  if (!sha256 || !Number.isSafeInteger(expected?.size) || expected.size < 1024) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size === expected.size && sha256File(filePath) === sha256;
  } catch {
    return false;
  }
}

/**
 * Verify an existing app runtime before the generic installer may skip work.
 * It is intentionally independent of the cached download so a corrupt app
 * copy can never be blessed by just a matching .version marker.
 */
export function isVerifiedInstalledPlatform({ version, platformKey, filePath }) {
  const { expected } = pinnedRuntimeAsset(readPin(), version, platformKey);
  return isVerifiedRuntimeFile(filePath, expected);
}

function verifyPromotedRuntime(version, platformKey, filePath) {
  const { expected, platform } = pinnedRuntimeAsset(readPin(), version, platformKey);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size !== expected.size) {
      fs.rmSync(filePath, { force: true });
      throw new Error(`OMP ${platform.key} promoted binary size does not match its pin`);
    }
  } catch (error) {
    if (error?.message?.includes('does not match its pin')) throw error;
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw new Error(`OMP ${platform.key} promoted binary could not be verified: ${error.message}`);
  }
  verifyFileSha256OrRemove(
    filePath,
    expected.sha256,
    `OMP ${platform.key} promoted binary v${version}`,
  );
}

/**
 * Validate mutable GitHub release metadata against the committed supply-chain
 * pin. This must stay strict even when a cached local binary already exists.
 */
export function assertPinnedRuntimeAsset(pin, release, version, platformKey) {
  const { expected, platform } = pinnedRuntimeAsset(pin, version, platformKey);
  const asset = Array.isArray(release?.assets)
    ? release.assets.find((candidate) => candidate?.name === platform.asset)
    : undefined;
  const assetSha256 = normalizeExpectedSha256(asset?.digest);
  if (
    !expected ||
    !asset ||
    !assetSha256 ||
    assetSha256 !== expected.sha256 ||
    asset.browser_download_url !== expected.url ||
    asset.size !== expected.size
  ) {
    throw new Error(
      `OMP runtime asset metadata does not match the committed pin for ${platformKey}@${version}`,
    );
  }
  return { asset, expected, platform };
}

async function fetchRelease(version) {
  return fetchJsonWithTimeout(RELEASE_URL(`v${version}`), {
    headers: githubHeaders(),
  });
}

async function verifiedRuntimeAsset(version, platformKey) {
  const pin = readPin();
  const release = await fetchRelease(version);
  return assertPinnedRuntimeAsset(pin, release, version, platformKey);
}

async function downloadBinary(version, platformKey, { force = false } = {}) {
  const { asset, expected, platform } = await verifiedRuntimeAsset(version, platformKey);
  const destinationDirectory = path.join(UPDATES_DIR, version, platform.key);
  const destination = path.join(destinationDirectory, platform.file);
  fs.mkdirSync(destinationDirectory, { recursive: true });

  if (!force && isUsableCache(destination)) {
    verifyFileSha256OrRemove(
      destination,
      expected.sha256,
      `OMP ${platform.key} binary v${version} (cached)`,
    );
    if (fs.statSync(destination).size !== expected.size) {
      fs.rmSync(destination, { force: true });
      throw new Error(`OMP ${platform.key} cached binary size does not match its pin`);
    }
    console.log(`  [${platform.key}] skip (cached, sha256 ok, ${formatMB(expected.size)})`);
    return destination;
  }

  console.log(`  [${platform.key}] ${asset.browser_download_url}`);
  const progress = createDownloadProgressLogger(platform.key);
  try {
    await downloadToFileWithTimeout(
      asset.browser_download_url,
      destination,
      { headers: githubHeaders() },
      { onProgress: progress.onProgress },
    );
  } finally {
    progress.finish();
  }
  verifyFileSha256OrRemove(destination, expected.sha256, `OMP ${platform.key} binary v${version}`);
  if (fs.statSync(destination).size !== expected.size) {
    fs.rmSync(destination, { force: true });
    throw new Error(`OMP ${platform.key} binary size does not match its pin`);
  }
  if (!platform.file.endsWith('.exe')) {
    try {
      fs.chmodSync(destination, 0o755);
    } catch {
      // The later executable probe remains the authoritative platform check.
    }
  }
  console.log(`    → ${destination} (${formatMB(expected.size)})`);
  return destination;
}

function promoteOnePlatform(version, platformKey, source) {
  const platform = platformFor(platformKey);
  const destinationDirectory = path.join(BIN_DIR, platform.key);
  const destination = path.join(destinationDirectory, platform.file);
  fs.mkdirSync(destinationDirectory, { recursive: true });
  try {
    fs.copyFileSync(source, destination);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'ETXTBSY') {
      throw new Error(`OMP ${platform.key} target is locked; close the app and retry`);
    }
    throw error;
  }
  if (!platform.file.endsWith('.exe')) {
    try {
      fs.chmodSync(destination, 0o755);
    } catch {
      // The source hash and later executable probe remain authoritative.
    }
  }
  verifyPromotedRuntime(version, platformKey, destination);
  fs.writeFileSync(path.join(destinationDirectory, '.version'), `${version}\n`);
  return destination;
}

/** Used by the existing opt-in development runtime installer. */
export async function ensurePlatform({ version, platformKey, force = false }) {
  requireAuditedVersion(version);
  const source = await downloadBinary(version, platformKey, { force });
  return promoteOnePlatform(version, platformKey, source);
}

function parseArgs(argv) {
  const values = { force: false, platform: null, version: null };
  for (const value of argv) {
    if (value === '--force' || value === '-f') values.force = true;
    else if (value.startsWith('--platform=')) values.platform = value.slice('--platform='.length);
    else if (value.startsWith('--version=')) values.version = value.slice('--version='.length);
    else if (!value.startsWith('-')) values.version = value;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version ?? readPinnedVersion();
  if (!version) throw new Error('OMP runtime pin is missing');
  requireAuditedVersion(version);
  const targets = args.platform ? [platformFor(args.platform)] : OMP_RELEASE_PLATFORMS;
  console.log(`==> Ensuring audited OMP ${version} runtime assets...`);
  for (const target of targets) {
    await ensurePlatform({
      version,
      platformKey: target.key,
      force: args.force,
    });
  }
  console.log('=== Done ===');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
