import { describe, expect, it, vi } from 'vitest';

import { OmpAgent, createOmpSessionRuntimeHome } from './index.js';
import type { OmpRemoteTransport } from './process-host.js';
import type { AgentDeps, OmpRemoteFileOps } from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

class RemoteOmpFixture implements OmpRemoteTransport {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readyQueued = false;

  writeLine(line: string): void {
    const request = JSON.parse(line) as Record<string, unknown>;
    this.requests.push(request);
    const id = request.id;
    const type = request.type;
    if (typeof id !== 'string' || typeof type !== 'string') return;
    const data = type === 'get_state'
      ? { sessionFile: '/remote/runtime/sessions/probe.jsonl' }
      : type === 'get_available_commands'
        ? []
        : undefined;
    queueMicrotask(() => this.emit({ type: 'response', id, command: type, success: true, ...(data === undefined ? {} : { data }) }));
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    if (!this.readyQueued) {
      this.readyQueued = true;
      queueMicrotask(() => this.emit({
        type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1],
      }));
    }
    return () => this.lineListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    queueMicrotask(() => {
      for (const listener of this.closeListeners) listener();
    });
  }

  private emit(frame: Record<string, unknown>): void {
    const line = JSON.stringify(frame);
    for (const listener of this.lineListeners) listener(line);
  }
}

function remoteFileOps() {
  const mkdirp = vi.fn(async () => undefined);
  const writeFile = vi.fn(async () => undefined);
  const rm = vi.fn(async () => undefined);
  const stat = vi.fn(async () => ({ isFile: false }));
  const linkDirectory = vi.fn(async () => undefined);
  const ops: OmpRemoteFileOps = {
    mkdirp,
    writeFile,
    rm,
    stat,
    listDir: async () => [],
    readFile: async () => '',
    sha256File: async () => '0'.repeat(64),
    linkDirectory,
  };
  return { ops, mkdirp, writeFile, rm, stat, linkDirectory };
}

function remoteAgent(
  transport: RemoteOmpFixture,
  fileOps: OmpRemoteFileOps,
  captured: { cwd?: string },
): OmpAgent {
  const deps: AgentDeps = {
    auth: {
      getState: async () => ({ authenticated: false }),
      triggerLogin: async () => ({ authenticated: false }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: silentLogger,
    resolveRemoteOmpRuntime: async () => ({
      binaryPath: '/home/user/.xdt-server/omp/omp',
      agentHome: '/home/user/.xdt-server/omp-agent-home',
      userHome: '/home/user',
    }),
    getRemoteOmpFileOps: () => fileOps,
    getRemoteOmpTransport: (_hostId, options) => {
      captured.cwd = options.cwd;
      return transport;
    },
    openRemoteOmpProviderForward: async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      release: async () => {},
    }),
  };
  return new OmpAgent(deps);
}

describe('OMP isolated remote probe', () => {
  it('starts below its private HOME and never projects a remote user Skill root', async () => {
    const transport = new RemoteOmpFixture();
    const files = remoteFileOps();
    const captured: { cwd?: string } = {};
    const instanceId = 'isolated-probe-instance';
    const runtimeHome = createOmpSessionRuntimeHome(
      '/home/user/.xdt-server/omp-agent-home',
      instanceId,
      'linux',
    );

    const session = await remoteAgent(transport, files.ops, captured).startSession({
      sessionId: 'quick-test',
      sessionInstanceId: instanceId,
      remoteHostId: 'remote-a',
      // This input is intentionally not a native cwd in isolated-probe mode.
      workingDir: '/__lex_omp_isolated_probe__',
      model: 'model-a',
      disableHostTools: true,
      isolatedProbe: true,
    });

    expect(captured.cwd).toBe(`${runtimeHome}/workdir`);
    expect(files.mkdirp).toHaveBeenCalledWith(`${runtimeHome}/workdir`);
    expect(files.stat).not.toHaveBeenCalled();
    expect(files.linkDirectory).not.toHaveBeenCalled();
    expect(files.mkdirp.mock.calls.flat()).not.toContain('/home/user/.agents/skills');
    expect(files.writeFile.mock.calls.flat()).not.toContain('/home/user/.agents/skills');

    await session.close({ reason: 'navigation' });
    expect(files.rm).toHaveBeenCalledWith(runtimeHome, { recursive: true });
  });

  it('keeps a normal remote project session on its requested cwd and projects global Skills', async () => {
    const transport = new RemoteOmpFixture();
    const files = remoteFileOps();
    const captured: { cwd?: string } = {};

    const session = await remoteAgent(transport, files.ops, captured).startSession({
      sessionId: 'normal-session',
      sessionInstanceId: 'normal-instance',
      remoteHostId: 'remote-a',
      workingDir: '/projects/real-project',
      model: 'model-a',
    });

    expect(captured.cwd).toBe('/projects/real-project');
    expect(files.stat).toHaveBeenCalledWith('/home/user/.agents/skills');
    expect(files.linkDirectory).toHaveBeenCalledWith(
      '/home/user/.agents/skills',
      expect.stringContaining('/.agents/skills'),
    );

    await session.close({ reason: 'navigation' });
  });
});
