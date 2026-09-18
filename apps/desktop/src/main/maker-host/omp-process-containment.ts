/**
 * Windows-only native containment boundary for managed OMP sessions.
 *
 * POSIX sessions use the process-group implementation in maker-core. Windows
 * cannot recover a descendant from an exited root by PID tree walking, so Main
 * launches this fixed, repo-local helper instead. The helper assigns OMP to a
 * KILL_ON_JOB_CLOSE Job Object before resume and owns that Job handle for the
 * duration of the session. No Renderer IPC points here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { OmpProcessSpawner } from '@cindy/maker-core';

import { findDevBinary } from '../agent-binaries/dev-fallback.js';

export const OMP_WINDOWS_CONTAINER_PROTOCOL = '1';
const CONTAINER_BINARY_NAME = 'cindy-omp-process-container.exe';
const MIN_CONTAINER_BYTES = 1024;

function isUsableContainer(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size >= MIN_CONTAINER_BYTES;
  } catch {
    return false;
  }
}

/**
 * OMP is currently an explicit development runtime. Packaged Windows builds
 * fail closed until the helper has a signed, shipped runtime path instead of
 * silently falling back to an unmanaged Node spawn.
 */
export function resolveWindowsOmpProcessContainer(): string | null {
  if (process.platform !== 'win32' || app.isPackaged) return null;
  const candidate = findDevBinary({
    vendorBinDir: 'omp-bin',
    binaryName: CONTAINER_BINARY_NAME,
  });
  return candidate !== null && isUsableContainer(candidate) ? candidate : null;
}

function validateSpawnRequest(request: Parameters<OmpProcessSpawner>[0]): void {
  if (
    !path.isAbsolute(request.executablePath)
    || !path.isAbsolute(request.workingDirectory)
    || request.executablePath.includes('\0')
    || request.workingDirectory.includes('\0')
    || !Array.isArray(request.arguments)
    || request.arguments.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  ) {
    throw new Error('Invalid OMP Windows containment launch request');
  }
}

/**
 * Return the Main-only spawner when the current dev checkout contains its
 * locally built helper. The returned closure re-resolves the fixed dev path on
 * every session, so a removed, symlinked, or undersized helper fails closed
 * after agent registration. Development build outputs are not release-signed;
 * packaged builds remain disabled until a signed runtime path is introduced.
 */
export function createWindowsOmpProcessSpawner(): OmpProcessSpawner | null {
  if (resolveWindowsOmpProcessContainer() === null) return null;
  return (request): ChildProcessWithoutNullStreams => {
    validateSpawnRequest(request);
    const container = resolveWindowsOmpProcessContainer();
    if (container === null) {
      throw new Error('OMP Windows containment helper is unavailable; run pnpm install:omp');
    }
    const environment: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(request.environment)) environment[key] = value;
    return spawn(
      container,
      [
        '--protocol',
        OMP_WINDOWS_CONTAINER_PROTOCOL,
        '--parent-pid',
        String(process.pid),
        '--',
        request.executablePath,
        ...request.arguments,
      ],
      {
        cwd: request.workingDirectory,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  };
}
