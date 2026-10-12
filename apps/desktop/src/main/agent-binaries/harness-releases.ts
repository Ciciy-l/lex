import { net } from 'electron';
import type { HarnessKind, HarnessSource } from '../../shared/harnessSettings.js';
import { getRuntimeManifest, getRuntimeAssetBaseUrl } from './runtime-manifest.js';
import { getVendorAsset, resolveVendorAssetUrl } from './manifest.js';
import { parsePiRelease } from './pi-self-update.js';

export interface HarnessArtifact {
  version: string;
  source: HarnessSource;
  url: string;
  sha256: string;
  size?: number;
  format: 'binary' | 'zip' | 'tar.gz' | 'gz';
  executable: string;
}
const fields = { 'claude-code': 'claudeCode', codex: 'codexPackage', pi: 'pi', omp: 'omp' };
export function harnessExecutable(kind: HarnessKind, platform = process.platform): string {
  const suffix = platform === 'win32' ? '.exe' : '';
  return kind === 'codex'
    ? 'bin/codex' + suffix
    : (kind === 'claude-code' ? 'claude' : kind) + suffix;
}
export function baselineArtifact(kind: HarnessKind): HarnessArtifact | null {
  const manifest = getRuntimeManifest();
  const asset = manifest && getVendorAsset(manifest, fields[kind]);
  if (!asset) return null;
  return {
    version: asset.version,
    source: 'baseline',
    url: resolveVendorAssetUrl(getRuntimeAssetBaseUrl(), asset),
    sha256: asset.sha256,
    size: asset.size,
    format: kind === 'claude-code' ? 'gz' : kind === 'omp' ? 'binary' : 'tar.gz',
    executable: harnessExecutable(kind),
  };
}
export function stableVersion(value: unknown, prefix = 'v'): string {
  if (typeof value !== 'string' || !value.startsWith(prefix))
    throw new Error('INVALID_RELEASE_VERSION');
  const version = value.slice(prefix.length);
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) throw new Error('INVALID_RELEASE_VERSION');
  return version;
}
const targets: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
export function parseGithubArtifact(
  kind: Exclude<HarnessKind, 'claude-code'>,
  raw: unknown,
  platform = process.platform,
  arch = process.arch,
): HarnessArtifact {
  if (!targets[platform + '-' + arch]) throw new Error('UNSUPPORTED_PLATFORM');
  const release = raw as {
    tag_name?: unknown;
    draft?: boolean;
    prerelease?: boolean;
    assets?: { name?: unknown; digest?: unknown; browser_download_url?: unknown; size?: unknown }[];
  };
  if (!release || release.draft || release.prerelease) throw new Error('INVALID_RELEASE');
  if (kind === 'pi') return { ...parsePiRelease(raw, platform, arch), source: 'upstream' };
  const version = stableVersion(release.tag_name, kind === 'codex' ? 'rust-v' : 'v');
  const repo = kind === 'codex' ? 'openai/codex' : 'can1357/oh-my-pi';
  const name =
    kind === 'codex'
      ? 'codex-package-' + targets[platform + '-' + arch] + '.tar.gz'
      : 'omp-' +
        (platform === 'win32' ? 'windows' : platform) +
        '-' +
        arch +
        (platform === 'win32' ? '.exe' : '');
  const url = 'https://github.com/' + repo + '/releases/download/' + release.tag_name + '/' + name;
  const asset = Array.isArray(release.assets)
    ? release.assets.find((a) => a.name === name)
    : undefined;
  if (
    !asset ||
    asset.browser_download_url !== url ||
    typeof asset.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  )
    throw new Error('RELEASE_HAS_NO_VERIFIED_ASSET');
  return {
    version,
    source: 'upstream',
    url,
    sha256: asset.digest.slice(7),
    ...(typeof asset.size === 'number' && asset.size > 0 ? { size: asset.size } : {}),
    format: kind === 'codex' ? 'tar.gz' : 'binary',
    executable: harnessExecutable(kind, platform),
  };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
async function json(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await net.fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('RELEASE_LOOKUP_HTTP_' + response.status);
  return response.json();
}
export async function upstreamArtifact(
  kind: HarnessKind,
  signal: AbortSignal,
): Promise<HarnessArtifact> {
  if (kind !== 'claude-code') {
    const repo =
      kind === 'codex' ? 'openai/codex' : kind === 'pi' ? 'earendil-works/pi' : 'can1357/oh-my-pi';
    return parseGithubArtifact(
      kind,
      await json('https://api.github.com/repos/' + repo + '/releases/latest', signal),
    );
  }
  const meta = await json('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', signal);
  const version = stableVersion(record(meta).version, '');
  const root = 'https://downloads.claude.ai/claude-code-releases/' + version;
  const manifest = await json(root + '/manifest.json', signal);
  const key = process.platform + '-' + process.arch;
  const asset = record(record(record(manifest).platforms)[key]);
  const executable = harnessExecutable(kind);
  if (
    record(manifest).version !== version ||
    typeof asset?.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(asset.checksum)
  )
    throw new Error('RELEASE_HAS_NO_VERIFIED_ASSET');
  return {
    version,
    source: 'upstream',
    url: root + '/' + key + '/' + executable,
    sha256: asset.checksum.toLowerCase(),
    format: 'binary',
    executable,
    ...(typeof asset.size === 'number' && asset.size > 0 ? { size: asset.size } : {}),
  };
}
