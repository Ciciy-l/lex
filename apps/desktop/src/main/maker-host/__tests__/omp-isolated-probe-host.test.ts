import { readFile } from 'node:fs/promises';

import {
  type OmpProcessHost,
  type OmpProcessHostOptions,
} from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import { __testing } from '../omp-isolated-probe-host.js';
import type { OmpProbePreflight } from '../omp-probe-preflight.js';
import type { OmpProbeRuntime } from '../omp-probe-runtime.js';

type OmpProcessState = ReturnType<OmpProcessHost['getState']>;
type ProbeRequest = Parameters<OmpProcessHost['client']['request']>[0];

interface PendingResponse {
  command: ProbeRequest['type'];
  resolve(response: {
    type: 'response';
    id: string;
    command: ProbeRequest['type'];
    success: true;
    data?: unknown;
  }): void;
  reject(error: Error): void;
}

function createProbeClient() {
  let sequence = 0;
  let closed = false;
  const requests: Array<{ id: string; command: ProbeRequest }> = [];
  const pending = new Map<string, PendingResponse>();
  const client = {
    request(command: ProbeRequest) {
      if (closed) throw new Error('synthetic OMP RPC is closed');
      const id = `omp-${++sequence}`;
      const response = new Promise<{
        type: 'response';
        id: string;
        command: ProbeRequest['type'];
        success: true;
        data?: unknown;
      }>((resolve, reject) => {
        pending.set(id, { command: command.type, resolve, reject });
      });
      requests.push({ id, command });
      return { id, response };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values())
        entry.reject(new Error('synthetic OMP RPC is closed'));
      pending.clear();
    },
  };
  return {
    client: client as unknown as OmpProcessHost['client'],
    requests,
    get closed() {
      return closed;
    },
    respond(id: string, data: unknown) {
      const entry = pending.get(id);
      if (!entry) throw new Error(`No pending response for ${id}`);
      pending.delete(id);
      entry.resolve({
        type: 'response',
        id,
        command: entry.command,
        success: true,
        data,
      });
    },
  };
}

function preflight(dispose = vi.fn(async () => undefined)): OmpProbePreflight {
  return Object.freeze({
    runtime: Object.freeze({
      version: '18.1.18',
      platformKey: 'linux-x64',
      binaryName: 'omp',
      sha256: 'a'.repeat(64),
      size: 123_456,
    }),
    launch: Object.freeze({
      executablePath: '/repo/apps/omp-bin/linux-x64/omp',
      workingDirectory: '/tmp/lex-omp-probe/home/workdir',
      arguments: Object.freeze(['--mode', 'rpc', '--no-tools']),
      environment: Object.freeze({ HOME: '/tmp/lex-omp-probe/home' }),
    }),
    dispose,
  });
}

function verifiedRuntime(): OmpProbeRuntime {
  return Object.freeze({
    version: '18.1.18',
    platformKey: 'linux-x64',
    binaryName: 'omp',
    sha256: 'a'.repeat(64),
    size: 123_456,
    binaryPath: '/repo/apps/omp-bin/linux-x64/omp',
  });
}

async function fixture(
  platform: NodeJS.Platform = 'linux',
  confirmed = true,
) {
  const wire = createProbeClient();
  const dispose = vi.fn(async () => undefined);
  const prepared = preflight(dispose);
  let state: OmpProcessState = 'starting';
  let processOptions: OmpProcessHostOptions | undefined;
  const stopAndWait = vi.fn(async () => confirmed);
  const processHost: OmpProcessHost = {
    client: wire.client,
    pid: 42,
    getState: () => state,
    stopAndWait,
  };
  const prepare = vi.fn(async () => prepared);
  const verifyRuntime = vi.fn(async () => verifiedRuntime());
  const start = vi.fn((options: OmpProcessHostOptions) => {
    processOptions = options;
    return processHost;
  });
  const terminateTree = vi.fn();
  const host = await __testing.startWithDependencies(
    { temporaryRoot: '/host-temp' },
    { prepare, verifyRuntime, start, terminateTree, platform },
  );
  return {
    host,
    prepare,
    verifyRuntime,
    start,
    terminateTree,
    dispose,
    stopAndWait,
    wire,
    get processOptions() {
      if (!processOptions) throw new Error('synthetic process was not started');
      return processOptions;
    },
    state(next: OmpProcessState) {
      state = next;
      processOptions?.onState(next);
    },
    event(event: Readonly<Record<string, unknown>>) {
      processOptions?.onEvent(event);
    },
  };
}

function requestId(
  requests: readonly { id: string; command: ProbeRequest }[],
  type: ProbeRequest['type'],
): string {
  const request = requests.find((entry) => entry.command.type === type);
  if (!request) throw new Error(`Missing ${type} request`);
  return request.id;
}

describe('OMP isolated probe host', () => {
  it('uses only the verified launch inputs and exposes only a safe command probe', async () => {
    const test = await fixture('linux');

    expect(test.prepare).toHaveBeenCalledWith({ temporaryRoot: '/host-temp' });
    expect(test.verifyRuntime).toHaveBeenCalledOnce();
    expect(test.start).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/repo/apps/omp-bin/linux-x64/omp',
        workingDirectory: '/tmp/lex-omp-probe/home/workdir',
        arguments: ['--mode', 'rpc', '--no-tools'],
        environment: { HOME: '/tmp/lex-omp-probe/home' },
        detached: true,
      }),
    );
    expect(Object.keys(test.host).sort()).toEqual([
      'getProcessState',
      'getSnapshot',
      'stopAndDispose',
      'waitForProbe',
    ]);
    expect(test.host).not.toHaveProperty('client');
    expect(test.host).not.toHaveProperty('request');
    expect(test.host).not.toHaveProperty('respondToUi');

    test.state('ready');
    expect(test.wire.requests.map((entry) => entry.command.type)).toEqual([
      'get_available_commands',
      'get_state',
    ]);
    expect(test.wire.requests.map((entry) => entry.command.type)).not.toContain('prompt');
    test.wire.respond(requestId(test.wire.requests, 'get_available_commands'), {
      commands: [{ name: 'plan', aliases: [], source: 'builtin' }],
    });
    test.wire.respond(requestId(test.wire.requests, 'get_state'), {
      sessionId: 'isolated-probe',
      model: { neverProjected: true },
    });

    await expect(test.host.waitForProbe()).resolves.toEqual(
      expect.objectContaining({
        status: 'ready',
        stateAvailable: true,
        commands: expect.objectContaining({
          commands: [expect.objectContaining({ name: 'plan' })],
        }),
      }),
    );
    expect(test.host.getSnapshot()).not.toHaveProperty('model');
    expect(Object.isFrozen(test.host)).toBe(true);
  });

  it('fails closed on a native interaction without writing an approval response', async () => {
    const test = await fixture();
    test.state('ready');
    const beforeInteraction = test.wire.requests.length;

    test.event({
      type: 'extension_ui_request',
      id: 'native-select',
      method: 'select',
      options: ['Approve', 'Deny'],
    });

    await expect(test.host.waitForProbe()).resolves.toMatchObject({
      status: 'failed',
      failure: 'unexpected_interaction',
    });
    expect(test.wire.closed).toBe(true);
    expect(test.wire.requests).toHaveLength(beforeInteraction);
    expect(test.wire.requests.map((entry) => entry.command.type)).not.toContain(
      'extension_ui_response',
    );
  });

  it.each([
    ['linux', true, undefined],
    ['win32', false, { requireWindowsIdentityBoundTermination: true }],
  ] as const)(
    'selects the existing %s process-stop policy without changing probe wire behavior',
    async (platform, detached, forceOptions) => {
      const test = await fixture(platform);
      const child = {
        pid: 99,
        kill: vi.fn(),
      } as unknown as Parameters<OmpProcessHostOptions['terminateProcessTree']>[0];

      expect(test.processOptions.detached).toBe(detached);
      test.processOptions.terminateProcessTree(child, false);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(test.terminateTree).not.toHaveBeenCalled();

      test.processOptions.terminateProcessTree(child, true);
      expect(test.terminateTree).toHaveBeenCalledWith(
        99,
        child,
        undefined,
        forceOptions,
      );
    },
  );

  it('disposes the fresh sandbox once only after a confirmed process close', async () => {
    const test = await fixture('darwin', true);
    const first = test.host.stopAndDispose();
    const concurrent = test.host.stopAndDispose();

    expect(concurrent).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(test.stopAndWait).toHaveBeenCalledOnce();
    expect(test.dispose).toHaveBeenCalledOnce();
    await expect(test.host.stopAndDispose()).resolves.toBe(true);
    expect(test.dispose).toHaveBeenCalledOnce();
  });

  it('retains an unconfirmed sandbox and permits cleanup retry after a late close', async () => {
    const test = await fixture('linux', false);

    await expect(test.host.stopAndDispose()).resolves.toBe(false);
    expect(test.dispose).not.toHaveBeenCalled();
    test.stopAndWait.mockResolvedValueOnce(true);
    test.state('exited');
    await expect(test.host.stopAndDispose()).resolves.toBe(true);
    expect(test.dispose).toHaveBeenCalledOnce();
  });

  it('retains the sandbox if construction cannot prove that no child started', async () => {
    const dispose = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => preflight(dispose));

    await expect(
      __testing.startWithDependencies(
        { temporaryRoot: '/host-temp' },
        {
          prepare,
          verifyRuntime: async () => verifiedRuntime(),
          start: () => {
            throw new Error('synthetic transport construction failure');
          },
          terminateTree: vi.fn(),
          platform: 'linux',
        },
      ),
    ).rejects.toThrow('OMP isolated probe could not be started; sandbox retained');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('removes the sandbox before spawn if its just-in-time runtime check fails', async () => {
    const dispose = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => preflight(dispose));
    const start = vi.fn();

    await expect(
      __testing.startWithDependencies(
        { temporaryRoot: '/host-temp' },
        {
          prepare,
          verifyRuntime: async () => ({
            ...verifiedRuntime(),
            binaryPath: '/different/omp',
          }),
          start,
          terminateTree: vi.fn(),
          platform: 'linux',
        },
      ),
    ).rejects.toThrow('OMP isolated probe runtime verification failed before start');
    expect(start).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('has no Electron, renderer, IPC, agent registration, or raw-process export', async () => {
    const source = await readFile(
      new URL('../omp-isolated-probe-host.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]electron['"]/u);
    expect(source).not.toMatch(/from\s+['"]node:child_process['"]/u);
    expect(source).not.toMatch(/\bipcMain\s*\./u);
    expect(source).not.toMatch(/\bcontextBridge\s*\./u);
    expect(source).not.toMatch(/\bAgentKind\s*[.:=]/u);
    expect(source).not.toMatch(/\bspawn\s*\(/u);
  });
});
