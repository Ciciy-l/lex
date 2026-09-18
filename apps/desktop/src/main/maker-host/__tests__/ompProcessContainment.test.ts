import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  container: null as string | null,
  packaged: false,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return env.packaged;
    },
  },
}));

vi.mock('../../agent-binaries/dev-fallback.js', () => ({
  findDevBinary: () => env.container,
}));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import {
  createWindowsOmpProcessSpawner,
  OMP_WINDOWS_CONTAINER_PROTOCOL,
  resolveWindowsOmpProcessContainer,
} from '../omp-process-containment.js';

const roots: string[] = [];

function makeContainer(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lex-omp-container-'));
  roots.push(root);
  const container = path.join(root, 'cindy-omp-process-container.exe');
  writeFileSync(container, Buffer.alloc(2048, 1));
  return container;
}

describe.runIf(process.platform === 'win32')('OMP Windows process containment', () => {
  beforeEach(() => {
    env.packaged = false;
    env.container = makeContainer();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('resolves only a regular, development helper and rejects packaged execution', () => {
    expect(resolveWindowsOmpProcessContainer()).toBe(env.container);
    env.packaged = true;
    expect(resolveWindowsOmpProcessContainer()).toBeNull();
  });

  it('spawns the fixed native container with explicit argv, cwd, and isolated environment', () => {
    const child = {} as ChildProcessWithoutNullStreams;
    vi.mocked(spawn).mockReturnValue(child);
    const spawner = createWindowsOmpProcessSpawner();
    expect(spawner).not.toBeNull();

    const request = {
      // Forward slashes keep these Windows paths literal in a TypeScript
      // string (rather than turning `\r` or `\w` into escape sequences).
      executablePath: 'C:/runtime/omp.exe',
      workingDirectory: 'C:/runtime/home/workdir',
      arguments: ['--mode', 'rpc'],
      environment: { PATH: 'C:\Windows\System32', OMP_SECRET: 'session-only' },
    };
    expect(spawner?.(request)).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      env.container,
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
        env: request.environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  });

  it('fails closed when the helper disappears or the request is malformed', () => {
    const spawner = createWindowsOmpProcessSpawner();
    expect(spawner).not.toBeNull();
    expect(() => spawner?.({
      executablePath: 'relative/omp.exe',
      workingDirectory: 'C:/runtime/workdir',
      arguments: [],
      environment: {},
    })).toThrow('Invalid OMP Windows containment launch request');
    expect(spawn).not.toHaveBeenCalled();
    env.container = null;
    expect(() => spawner?.({
      executablePath: 'C:/runtime/omp.exe',
      workingDirectory: 'C:/runtime/workdir',
      arguments: [],
      environment: {},
    })).toThrow('containment helper is unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });
});
