import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  HarnessKind,
  HarnessRuntimeState,
  HarnessSource,
  HarnessFailureStage,
} from '../../shared/harnessSettings.js';
import {
  activeHarnessSelection,
  activeHarnessPath,
  harnessRoot,
  hashRuntimeFile,
  persistHarnessSelection,
  readHarnessSelection,
  type HarnessSelection,
} from './harness-selection.js';
import { baselineArtifact, upstreamArtifact, type HarnessArtifact } from './harness-releases.js';
import { getCachedBinaryStatus } from './index.js';
import { probeBinaryVersion } from './binary-version-probe.js';
import { download } from '../downloader/index.js';
import { extractToolArchive, RUNTIME_ARCHIVE_LIMITS as LIMITS } from './toolArchive.js';
import { renameWithTransientRetry } from './pi-self-update.js';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';
import { createLogger } from '../logger.js';

const log = createLogger('harness-manager');
const CACHE_MS = 15 * 60_000;
const states = new Map<HarnessKind, HarnessRuntimeState>();
const releases = new Map<HarnessKind, HarnessArtifact>();
const operations = new Map<HarnessKind, AbortController>();
const checks = new Map<HarnessKind, Promise<HarnessRuntimeState>>();
const listeners = new Set<(state: HarnessRuntimeState) => void>();
export function onHarnessProgress(listener: (state: HarnessRuntimeState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function state(kind: HarnessKind): HarnessRuntimeState {
  let value = states.get(kind);
  if (!value) {
    // Freeze this process's selection before any GUI mutation.
    activeHarnessSelection(kind);
    const baseline = baselineArtifact(kind);
    value = {
      kind,
      currentVersion: null,
      selectedVersion: null,
      restartRequired: false,
      baseline: baseline && { version: baseline.version, source: 'baseline' },
      upstream: null,
      checkedAt: null,
      phase: 'idle',
      percent: null,
      error: null,
    };
    states.set(kind, value);
  }
  return value;
}
function publish(kind: HarnessKind, patch: Partial<HarnessRuntimeState>): HarnessRuntimeState {
  const value = { ...state(kind), ...patch };
  states.set(kind, value);
  for (const listener of listeners) {
    try {
      listener({ ...value });
    } catch {
      log.warn('Runtime progress listener unavailable');
    }
  }
  return { ...value };
}
export async function harnessState(kind: HarnessKind): Promise<HarnessRuntimeState> {
  const value = state(kind);
  const binary = activeHarnessPath(kind) ?? getCachedBinaryStatus(kind).binaryPath;
  const currentVersion = binary ? await probeBinaryVersion(binary) : null;
  const selected = readHarnessSelection(kind);
  return publish(kind, {
    currentVersion,
    selectedVersion: selected?.version ?? null,
    restartRequired:
      selected !== null && selected.directory !== activeHarnessSelection(kind)?.directory,
    // Preserve operation state while the version probe is in flight.
    baseline: value.baseline,
  });
}
export async function checkHarness(kind: HarnessKind, force = false): Promise<HarnessRuntimeState> {
  if (checks.has(kind)) return checks.get(kind)!;
  if (operations.has(kind)) return { ...state(kind) };
  if (!force && state(kind).checkedAt !== null && Date.now() - state(kind).checkedAt! < CACHE_MS)
    return harnessState(kind);
  const operation = (async () => {
    publish(kind, { phase: 'checking', error: null, failureStage: null });
    try {
      const release = await upstreamArtifact(kind, AbortSignal.timeout(30_000));
      releases.set(kind, release);
      publish(kind, {
        upstream: { version: release.version, source: 'upstream' },
        checkedAt: Date.now(),
        phase: 'idle',
      });
    } catch (error) {
      releases.delete(kind);
      publish(kind, {
        upstream: null,
        phase: 'failed',
        error: errorCode(error, 'RUNTIME_CHECK_FAILED'),
        failureStage: 'check',
        checkedAt: Date.now(),
      });
    }
    return harnessState(kind);
  })();
  checks.set(kind, operation);
  try {
    return await operation;
  } finally {
    checks.delete(kind);
  }
}
function errorCode(error: unknown, fallback = 'RUNTIME_INSTALL_FAILED'): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Z0-9_]{1,80}$/.test(message)) return message;
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === 'string' &&
    [
      'NETWORK',
      'TIMEOUT',
      'CHECKSUM',
      'SIZE',
      'DISK',
      'ENOSPC',
      'EACCES',
      'EPERM',
      'HTTP_4XX',
      'HTTP_5XX',
    ].includes(code)
  )
    return code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  return fallback;
}
async function distributionRoot(
  unpacked: string,
  artifact: HarnessArtifact,
  kind: HarnessKind,
): Promise<string> {
  const candidates = [unpacked, path.join(unpacked, kind), path.join(unpacked, 'codex-package')];
  for (const candidate of candidates) {
    if (!(await fsp.stat(path.join(candidate, artifact.executable)).catch(() => null))?.isFile())
      continue;
    if (kind === 'codex') {
      const manifest = JSON.parse(
        await fsp.readFile(path.join(candidate, 'codex-package.json'), 'utf8'),
      );
      if (
        manifest.version !== artifact.version ||
        manifest.layoutVersion !== 1 ||
        manifest.entrypoint !== artifact.executable
      )
        throw new Error('INVALID_RUNTIME_LAYOUT');
      const suffix = process.platform === 'win32' ? '.exe' : '';
      for (const file of ['bin/codex-code-mode-host' + suffix, 'codex-path/rg' + suffix]) {
        if (!(await fsp.stat(path.join(candidate, file))).isFile())
          throw new Error('INVALID_RUNTIME_LAYOUT');
      }
      if (!(await fsp.stat(path.join(candidate, 'codex-resources'))).isDirectory())
        throw new Error('INVALID_RUNTIME_LAYOUT');
    }
    return candidate;
  }
  throw new Error('INVALID_RUNTIME_LAYOUT');
}
export async function installHarness(input: {
  kind: HarnessKind;
  source: HarnessSource;
  version: string;
}): Promise<HarnessRuntimeState> {
  const { kind, source, version } = input;
  if (operations.has(kind) || checks.has(kind)) throw new Error('RUNTIME_BUSY');
  state(kind);
  // Only host-resolved artifacts are accepted. Renderer never chooses a URL or path.
  const artifact = source === 'baseline' ? baselineArtifact(kind) : releases.get(kind);
  if (!artifact || artifact.version !== version || artifact.source !== source)
    throw new Error('REFRESH_RELEASE_LIST');
  const controller = new AbortController();
  operations.set(kind, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
  const root = harnessRoot(kind);
  let failureStage: HarnessFailureStage = 'download';
  publish(kind, { phase: 'downloading', error: null, failureStage: null, percent: 0 });
  try {
    await fsp.mkdir(root, { recursive: true });
    await withSecurityBoundaryLock(
      path.join(root, 'install.lock'),
      { label: 'harness-' + kind, waitMs: 0 },
      async (lock) => {
        if (!lock.held) throw new Error('RUNTIME_BUSY');
        signal.throwIfAborted();
        const stage = await fsp.mkdtemp(path.join(root, '.stage-'));
        try {
          // Cache a verified archive separately so retry can resume partial downloads.
          const archive = path.join(root, artifact.sha256 + '.download');
          let lastProgress = 0;
          await download({
            url: artifact.url,
            targetPath: archive,
            sha256: artifact.sha256,
            expectedSize: artifact.size,
            maxBytes: LIMITS.archiveBytes,
            signal,
            onProgress: (event) => {
              if (Date.now() - lastProgress > 250) {
                lastProgress = Date.now();
                publish(kind, { percent: event.percent });
              }
            },
            onVerifying: () => {
              publish(kind, { phase: 'verifying' });
            },
          });
          publish(kind, { phase: 'verifying', percent: 100 });
          failureStage = 'extract';
          if (artifact.format === 'gz') {
            let size = 0;
            const limit = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length;
                callback(size > LIMITS.fileBytes ? new Error('RUNTIME_TOO_LARGE') : null, chunk);
              },
            });
            await pipeline(
              fs.createReadStream(archive),
              createGunzip(),
              limit,
              fs.createWriteStream(path.join(stage, artifact.executable), { flags: 'wx' }),
              { signal },
            );
          } else
            await extractToolArchive(
              archive,
              stage,
              { ...artifact, format: artifact.format },
              signal,
              LIMITS,
            );
          failureStage = 'verify';
          const distribution = await distributionRoot(stage, artifact, kind);
          const binary = path.join(distribution, artifact.executable);
          if (process.platform !== 'win32') await fsp.chmod(binary, 0o755);
          if ((await probeBinaryVersion(binary, signal)) !== version)
            throw new Error('RUNTIME_VERSION_MISMATCH');
          const selection: HarnessSelection = {
            version,
            source,
            directory: version + '-' + randomUUID(),
            executableSha256: hashRuntimeFile(binary),
            executableSize: (await fsp.stat(binary)).size,
          };
          signal.throwIfAborted();
          failureStage = 'publish';
          await renameWithTransientRetry(distribution, path.join(root, selection.directory), {
            platform: process.platform,
            signal,
          });
          // Last cancellation/timeout boundary before the atomic publication.
          signal.throwIfAborted();
          persistHarnessSelection(kind, selection);
          publish(kind, {
            phase: 'ready',
            selectedVersion: version,
            restartRequired: true,
            percent: 100,
          });
        } finally {
          await fsp
            .rm(stage, { recursive: true, force: true })
            .catch(() => log.warn('Runtime staging cleanup deferred'));
        }
      },
    );
  } catch (error) {
    publish(kind, {
      phase: controller.signal.aborted ? 'cancelled' : 'failed',
      error: controller.signal.aborted ? null : errorCode(error),
      failureStage: controller.signal.aborted ? null : failureStage,
      percent: null,
    });
  } finally {
    operations.delete(kind);
  }
  return { ...state(kind) };
}
export function cancelHarness(kind: HarnessKind): void {
  operations.get(kind)?.abort();
}
