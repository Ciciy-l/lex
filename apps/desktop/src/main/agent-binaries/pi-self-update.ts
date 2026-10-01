import { net } from 'electron';
import type { PiBinaryUpdateFailureStage } from '@cindy/maker-core';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { download } from '../downloader/index.js';
import { extractToolArchive } from './toolArchive.js';
import { isBinaryVersionNotOlder, probeBinaryVersion } from './binary-version-probe.js';
import { createLogger } from '../logger.js';

const log = createLogger('pi-self-update');

const failureStages = new WeakMap<object, PiBinaryUpdateFailureStage>();

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown';
}

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Bounded (~9.75s) and still inside the install AbortSignal. */
export const PI_PUBLISH_RENAME_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 3000, 3000];

export async function renameWithTransientRetry(
  from: string, to: string, options: {
    platform: string;
    signal: AbortSignal;
    delaysMs?: readonly number[];
    waitBeforeRetry?: (delayMs: number) => Promise<void>;
  },
): Promise<void> {
  // Elsewhere EPERM/EACCES are real permission failures; retrying only delays the error.
  const delays = options.platform === 'win32' ? options.delaysMs ?? PI_PUBLISH_RENAME_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt += 1) {
    // fs.rename cannot be cancelled, so do not start it after the install budget expires.
    options.signal.throwIfAborted();
    try {
      await fs.rename(from, to);
      if (attempt > 0) log.info('Pi publish rename succeeded after transient retry', { attempts: attempt + 1 });
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= delays.length || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      log.warn('Pi publish rename hit transient error; retrying', { code, attempt: attempt + 1, delayMs: delays[attempt] });
      await (options.waitBeforeRetry ?? ((delayMs) => delay(delayMs, undefined, { signal: options.signal })))(delays[attempt]);
    }
  }
}

function logCleanupFailure(target: 'staging' | 'unpublished-destination') {
  // Target label and errno only: the path carries the user's profile directory.
  return (error: unknown): void => log.warn('Pi install cleanup failed; leftover directory', {
    target, code: errorCode(error),
  });
}

export function piBinaryUpdateFailureStage(error: unknown): PiBinaryUpdateFailureStage | undefined {
  return error !== null && typeof error === 'object' ? failureStages.get(error) : undefined;
}

export interface PiBinaryUpdateDeps {
  fetchRelease(signal: AbortSignal): Promise<unknown>;
  download: typeof download;
  extract: typeof extractToolArchive;
  probe: typeof probeBinaryVersion;
}
const defaults: PiBinaryUpdateDeps = {
  fetchRelease: async signal => {
    // Match the Electron downloader's system-proxy/PAC-aware network stack.
    const response = await net.fetch('https://api.github.com/repos/earendil-works/pi/releases/latest', {
      signal, headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`Pi release lookup failed (${response.status})`);
    return response.json();
  },
  download, extract: extractToolArchive, probe: probeBinaryVersion,
};

export function parsePiRelease(value: unknown, platform: string, arch: string) {
  const release = value as { tag_name?: unknown; assets?: Array<{ name?: unknown; digest?: unknown; browser_download_url?: unknown }> } | null;
  if (!release || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Invalid Pi release version');
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Pi host platform');
  const format = platform === 'win32' ? 'zip' as const : 'tar.gz' as const;
  const name = `pi-${platform}-${arch}.${format}`;
  const url = `https://github.com/earendil-works/pi/releases/download/${release.tag_name}/${name}`;
  const asset = Array.isArray(release.assets) ? release.assets.find(asset => asset.name === name) : undefined;
  if (!asset || asset.browser_download_url !== url || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Pi release has no verified asset for this platform');
  return { version: release.tag_name.slice(1), url, sha256: asset.digest.slice(7), format,
    executable: platform === 'win32' ? 'pi.exe' : 'pi' };
}

/** The standalone upstream CLI cannot self-update. Install its official release
 * beside the running distribution, verify it, then let the caller publish it.
 * Never replace/delete a directory backing an active Pi process. */
export async function installPiBinaryUpdate(
  root: string, currentBinary: string, force: boolean,
  deps: PiBinaryUpdateDeps = defaults,
  platform = process.platform, arch = process.arch,
): Promise<{ binaryPath: string; version: string }> {
  let failureStage: PiBinaryUpdateFailureStage = 'release-lookup';
  try {
    const signal = AbortSignal.timeout(180_000);
    const metadata = await deps.fetchRelease(signal);
    failureStage = 'asset-validation';
    const release = parsePiRelease(metadata, platform, arch);
    failureStage = 'version-verification';
    const current = await deps.probe(currentBinary, signal);
    if (!force && current && isBinaryVersionNotOlder(current, release.version)) return { binaryPath: currentBinary, version: current };
    failureStage = 'prepare';
    await fs.mkdir(root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(path.dirname(root), '.pi-update-'));
    const destination = path.join(root, `${release.version}-${randomUUID()}`);
    let published = false;
    try {
      const archive = path.join(stage, `release.${release.format}`);
      const unpacked = path.join(stage, 'unpacked');
      await fs.mkdir(unpacked);
      failureStage = 'download';
      await deps.download({ url: release.url, sha256: release.sha256, targetPath: archive, signal });
      failureStage = 'extract';
      await deps.extract(archive, unpacked, release, signal);
      const nested = path.join(unpacked, 'pi', release.executable);
      const distribution = await fs.stat(nested).then(s => s.isFile()).catch(() => false)
        ? path.join(unpacked, 'pi') : unpacked;
      const binary = path.join(distribution, release.executable);
      if (platform !== 'win32') await fs.chmod(binary, 0o755);
      failureStage = 'version-verification';
      if (await deps.probe(binary, signal) !== release.version) throw new Error('Downloaded Pi version verification failed');
      failureStage = 'publish';
      await renameWithTransientRetry(distribution, destination, { platform, signal });
      const finalBinary = path.join(destination, release.executable);
      failureStage = 'version-verification';
      if (await deps.probe(finalBinary, signal) !== release.version) throw new Error('Installed Pi version verification failed');
      failureStage = 'publish';
      await fs.writeFile(path.join(destination, '.verified'), release.sha256, { mode: 0o600 });
      signal.throwIfAborted();
      published = true;
      return { binaryPath: finalBinary, version: release.version };
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(logCleanupFailure('staging'));
      if (!published) await fs.rm(destination, { recursive: true, force: true }).catch(logCleanupFailure('unpublished-destination'));
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Pi Host update failed');
    failureStages.set(failure, failureStage);
    log.warn('Pi Host binary update failed', { stage: failureStage, code: errorCode(error) });
    throw failure;
  }
}
