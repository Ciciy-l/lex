import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OmpProbeLaunchPlan } from '@cindy/maker-core';
import type { OmpProbeRuntime } from '../omp-probe-runtime.js';

const mocks = vi.hoisted(() => ({
  resolveRuntime: vi.fn(),
  createSandbox: vi.fn(),
}));

vi.mock('../omp-probe-runtime.js', () => ({
  resolveVerifiedOmpProbeRuntime: mocks.resolveRuntime,
}));

vi.mock('../omp-probe-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../omp-probe-sandbox.js')>()),
  createOmpProbeSandbox: mocks.createSandbox,
}));

import { __testing, prepareOmpIsolatedProbe } from '../omp-probe-preflight.js';

function runtime(): OmpProbeRuntime {
  return Object.freeze({
    version: '18.1.18',
    platformKey: 'win32-x64',
    binaryName: 'omp.exe',
    sha256: 'a'.repeat(64),
    size: 123_456,
    binaryPath: 'C:/repo/apps/omp-bin/win32-x64/omp.exe',
  });
}

function plan(): OmpProbeLaunchPlan {
  return Object.freeze({
    roots: Object.freeze({
      sandboxRoot: 'C:/temp/lex-omp-probe-1',
      home: 'C:/temp/lex-omp-probe-1/home',
      config: 'C:/temp/lex-omp-probe-1/home/.omp',
      agent: 'C:/temp/lex-omp-probe-1/agent',
      workingDirectory: 'C:/temp/lex-omp-probe-1/home/workdir',
      temporary: 'C:/temp/lex-omp-probe-1/tmp',
      settingsFile: 'C:/temp/lex-omp-probe-1/omp-probe-settings.yaml',
    }),
    settingsYaml: 'enabledProviders: []\n',
    arguments: Object.freeze(['--mode', 'rpc']),
    environment: Object.freeze({ HOME: 'C:/temp/lex-omp-probe-1/home' }),
  });
}

describe('OMP isolated probe preflight', () => {
  beforeEach(() => {
    mocks.resolveRuntime.mockReset();
    mocks.createSandbox.mockReset();
  });

  it('resolves the pinned runtime before materializing a sandbox and passes only explicit probe inputs', async () => {
    const dispose = vi.fn(async () => undefined);
    mocks.resolveRuntime.mockResolvedValue(runtime());
    mocks.createSandbox.mockResolvedValue({ plan: plan(), dispose });

    const result = await prepareOmpIsolatedProbe({
      temporaryRoot: 'C:/host-temp',
      model: { provider: 'test-provider', model: 'test-model' },
    });

    expect(mocks.resolveRuntime).toHaveBeenCalledOnce();
    expect(mocks.createSandbox).toHaveBeenCalledWith({
      temporaryRoot: 'C:/host-temp',
      model: { provider: 'test-provider', model: 'test-model' },
    });
    expect(result.launch.executablePath).toBe(runtime().binaryPath);
    await result.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not materialize a sandbox when runtime verification fails', async () => {
    mocks.resolveRuntime.mockRejectedValue(new Error('untrusted runtime'));

    await expect(prepareOmpIsolatedProbe({ temporaryRoot: 'C:/host-temp' })).rejects.toThrow(
      'untrusted runtime',
    );
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('rejects malformed options before it hashes a runtime', async () => {
    await expect(
      prepareOmpIsolatedProbe(undefined as unknown as { temporaryRoot: string }),
    ).rejects.toThrow('Invalid OMP probe preflight options');
    expect(mocks.resolveRuntime).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'relative-temp-root', `C:/host-temp${String.fromCharCode(0)}suffix`])(
    'rejects an invalid temporary root before it hashes a runtime: %j',
    async (temporaryRoot) => {
      await expect(
        prepareOmpIsolatedProbe({ temporaryRoot } as unknown as { temporaryRoot: string }),
      ).rejects.toThrow('OMP probe requires an absolute host temporary directory');
      expect(mocks.resolveRuntime).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { provider: '--unsafe', model: 'safe-model' },
    { provider: 'safe-provider', model: '' },
  ])('rejects an invalid model before it hashes a runtime: %j', async (model) => {
    await expect(
      prepareOmpIsolatedProbe({
        temporaryRoot: 'C:/host-temp',
        model,
      } as unknown as { temporaryRoot: string }),
    ).rejects.toThrow(/Invalid OMP probe/);
    expect(mocks.resolveRuntime).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('propagates sandbox materialization failures after validation', async () => {
    mocks.resolveRuntime.mockResolvedValue(runtime());
    mocks.createSandbox.mockRejectedValue(new Error('synthetic sandbox failure'));

    await expect(prepareOmpIsolatedProbe({ temporaryRoot: 'C:/host-temp' })).rejects.toThrow(
      'synthetic sandbox failure',
    );
    expect(mocks.resolveRuntime).toHaveBeenCalledOnce();
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
  });

  it('pairs only the verified runtime with the isolated sandbox launch inputs', async () => {
    const dispose = vi.fn(async () => undefined);
    const preflight = __testing.buildPreflight(runtime(), {
      plan: plan(),
      dispose,
    });

    expect(preflight.runtime).toEqual({
      version: '18.1.18',
      platformKey: 'win32-x64',
      binaryName: 'omp.exe',
      sha256: 'a'.repeat(64),
      size: 123_456,
    });
    expect(preflight.runtime).not.toHaveProperty('binaryPath');
    expect(preflight.launch).toEqual({
      executablePath: 'C:/repo/apps/omp-bin/win32-x64/omp.exe',
      workingDirectory: 'C:/temp/lex-omp-probe-1/home/workdir',
      arguments: ['--mode', 'rpc'],
      environment: { HOME: 'C:/temp/lex-omp-probe-1/home' },
    });
    expect(Object.isFrozen(preflight)).toBe(true);
    expect(Object.isFrozen(preflight.runtime)).toBe(true);
    expect(Object.isFrozen(preflight.launch)).toBe(true);

    await preflight.dispose();
    await preflight.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('single-flights concurrent cleanup and allows a failed cleanup to retry', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const dispose = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const preflight = __testing.buildPreflight(runtime(), { plan: plan(), dispose });

    const first = preflight.dispose();
    const concurrent = preflight.dispose();
    expect(concurrent).toBe(first);
    expect(dispose).toHaveBeenCalledOnce();
    rejectFirst!(new Error('synthetic cleanup failure'));
    await expect(first).rejects.toThrow('synthetic cleanup failure');

    await expect(preflight.dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('does not import a process launcher or expose any client-capable surface', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../omp-probe-preflight.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from\s+['"]node:child_process['"]/u);
    expect(source).not.toMatch(/\bstartOmpProcess\s*\(/u);
    const preflight = __testing.buildPreflight(runtime(), {
      plan: plan(),
      dispose: async () => undefined,
    });
    expect(Object.keys(preflight).sort()).toEqual(['dispose', 'launch', 'runtime']);
    expect(preflight).not.toHaveProperty('client');
    expect(preflight).not.toHaveProperty('request');
    expect(preflight).not.toHaveProperty('respondToUi');
  });
});
