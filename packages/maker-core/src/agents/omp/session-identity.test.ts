import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

let pendingFakeProcess: FakeOmpProcess | undefined;

vi.mocked(spawn).mockImplementation(() => {
  if (!pendingFakeProcess) throw new Error('fake OMP process was not selected');
  return pendingFakeProcess.spawn() as never;
});

import { OmpAgent } from './index.js';
import type { AgentDeps } from '../base-agent.js';
import type { McpProvider } from '../../interfaces/mcp-provider.js';
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

interface FakeOmpProcess {
  readonly commands: Array<Record<string, unknown>>;
  spawn(): ChildProcessWithoutNullStreams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Minimal wire-faithful process fixture: OMP answers the session command, then
 * reports the chosen path through get_state. No binary, provider, or user
 * configuration is involved.
 */
function fakeOmpProcess(reportedSessionFile: string): FakeOmpProcess {
  const commands: Array<Record<string, unknown>> = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const respond = (request: Record<string, unknown>, data?: unknown) => {
    const id = request.id;
    const command = request.type;
    if (typeof id !== 'string' || typeof command !== 'string') return;
    queueMicrotask(() => {
      stdout.write(
        JSON.stringify({
          type: 'response',
          id,
          command,
          success: true,
          ...(data === undefined ? {} : { data }),
        }) + '\n',
      );
    });
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      let request: unknown;
      try {
        request = JSON.parse(Buffer.from(chunk).toString('utf8'));
      } catch {
        callback(new Error('invalid fake OMP request'));
        return;
      }
      if (!isRecord(request) || typeof request.type !== 'string') {
        callback(new Error('invalid fake OMP request'));
        return;
      }
      commands.push(request);
      if (request.type === 'get_state') respond(request, { sessionFile: reportedSessionFile });
      else respond(request);
      callback();
    },
  });
  const eventEmitter = new EventEmitter();
  const child = Object.assign(eventEmitter, {
    stdin,
    stdout,
    stderr,
    // Deliberately non-existent, so the POSIX process-group fallback cannot
    // affect a real process when the failed startup is cleaned up.
    pid: 987_654_321,
    kill: () => {
      queueMicrotask(() => eventEmitter.emit('close', null, null));
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;

  return {
    commands,
    spawn: () => {
      queueMicrotask(() => {
        stdout.write(
          JSON.stringify({
            type: 'ready',
            protocolVersion: 1,
            supportedProtocolVersions: [1],
          }) + '\n',
        );
      });
      return child;
    },
  };
}

function agentFor(
  root: string,
  fake: FakeOmpProcess,
  mcpProviders?: McpProvider[],
  overrides: Partial<AgentDeps> = {},
): OmpAgent {
  pendingFakeProcess = fake;
  const deps: AgentDeps = {
    auth: {
      getState: async () => ({ authenticated: false }),
      triggerLogin: async () => ({ authenticated: false }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: {},
    binaryPath: globalThis.process.execPath,
    logger: silentLogger,
    mcpProviders,
    resolveOmpAgentHome: () => path.join(root, 'agent-home'),
    resolveOmpExecutableEnvironment: () =>
      globalThis.process.platform === 'win32'
        ? { systemRoot: globalThis.process.env.SystemRoot ?? 'C:\\Windows' }
        : {},
  };
  return new OmpAgent({ ...deps, ...overrides });
}

function commandTypes(process: FakeOmpProcess): string[] {
  return process.commands.flatMap((command) =>
    typeof command.type === 'string' ? [command.type] : [],
  );
}

describe('OMP upstream session identity', () => {
  it('uses an empty host-tool roster for a host-owned ephemeral probe only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-identity-'));
    const provider: McpProvider = {
      name: 'ordinary-host-tools',
      toOmpRpcHostTools: () => [{
        name: 'ordinary_host_tool',
        description: 'ordinary host tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }],
    };
    try {
      const workspace = path.join(root, 'workspace');
      const sessionFile = path.join(root, 'sessions', 'probe.jsonl');
      await mkdir(workspace, { recursive: true });

      const probeProcess = fakeOmpProcess(sessionFile);
      const probe = await agentFor(root, probeProcess, [provider]).startSession({
        sessionId: 'ephemeral-probe',
        workingDir: workspace,
        model: 'test-model',
        disableHostTools: true,
      });
      expect(probeProcess.commands.find((command) => command.type === 'set_host_tools')).toMatchObject({
        tools: [],
      });
      await probe.close({ reason: 'navigation' });

      const normalProcess = fakeOmpProcess(path.join(root, 'sessions', 'normal.jsonl'));
      const normal = await agentFor(root, normalProcess, [provider]).startSession({
        sessionId: 'ordinary-session',
        workingDir: workspace,
        model: 'test-model',
      });
      expect(normalProcess.commands.find((command) => command.type === 'set_host_tools')).toMatchObject({
        tools: [expect.objectContaining({ name: 'ordinary_host_tool' })],
      });
      await normal.close({ reason: 'navigation' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a relative new-session path before it can be adopted or retried', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-identity-'));
    try {
      const process = fakeOmpProcess('relative-history.jsonl');
      const invalidResume = vi.fn(async () => true);
      await mkdir(path.join(root, 'workspace'), { recursive: true });

      await expect(
        agentFor(root, process).startSession({
          sessionId: 'business-session',
          workingDir: path.join(root, 'workspace'),
          model: 'test-model',
          onInvalidResumeSession: invalidResume,
        }),
      ).rejects.toThrow('OMP did not report a session file');

      // The sole new_session is the original request. A malformed reply never
      // becomes sdkSessionId and cannot trigger another fresh-session fallback.
      expect(commandTypes(process)).toEqual(['new_session', 'get_state']);
      expect(invalidResume).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(globalThis.process.platform !== 'win32')(
    'rejects a current-drive-rooted Windows session path',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-identity-'));
      try {
        // `\\sessions\\history.jsonl` has no drive or UNC authority. Windows
        // resolves it on the current drive, which may differ after restart.
        const process = fakeOmpProcess('\\sessions\\history.jsonl');
        await mkdir(path.join(root, 'workspace'), { recursive: true });

        await expect(
          agentFor(root, process).startSession({
            sessionId: 'business-session',
            workingDir: path.join(root, 'workspace'),
            model: 'test-model',
          }),
        ).rejects.toThrow('OMP did not report a session file');

        expect(commandTypes(process)).toEqual(['new_session', 'get_state']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('fails closed when a resumed session reports a different absolute identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-identity-'));
    try {
      const expectedSessionFile = path.join(root, 'sessions', 'expected.jsonl');
      const process = fakeOmpProcess(path.join(root, 'sessions', 'different.jsonl'));
      const invalidResume = vi.fn(async () => true);
      await mkdir(path.join(root, 'workspace'), { recursive: true });

      await expect(
        agentFor(root, process).startSession({
          sessionId: 'business-session',
          workingDir: path.join(root, 'workspace'),
          model: 'test-model',
          resumeSessionId: expectedSessionFile,
          onInvalidResumeSession: invalidResume,
        }),
      ).rejects.toThrow('OMP resume session identity mismatch');

      // A successful switch_session does not authorize adoption of another
      // JSONL file or a fresh fallback.
      expect(commandTypes(process)).toEqual(['switch_session', 'get_state']);
      expect(invalidResume).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe('OMP Harness startup wiring', () => {
  it('materializes unified memory and captured native settings without replacing the native prompt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-harness-session-'));
    try {
      const workdir = path.join(root, 'work');
      await mkdir(workdir);
      const toTools = vi.fn(() => []);
      const getStore = vi.fn(async () => ({ getIndex: async () => 'project memory index' }));
      const models = vi.fn(() => undefined);
      const session = await agentFor(root, fakeOmpProcess(path.join(root, 'history.jsonl')), [
        { name: 'memory', toOmpRpcHostTools: toTools },
      ], {
        makerMemory: { isEnabled: () => true, currentOwnerScopeKey: () => 'owner-a', getStore } as unknown as AgentDeps['makerMemory'],
        resolveOmpHarnessSettings: () => ({ unifiedMemoryEnabled: true, compactionEnabled: false, maxConcurrency: 4, subagentModel: 'child' }),
        resolveOmpModelsYaml: models,
      }).startSession({ sessionId: 'harness-task', sessionInstanceId: 'harness-instance', workingDir: workdir,
        model: 'parent', providerId: 'source', makerMemoryScopeKey: '/project-key', userPrompt: 'custom instructions' });
      try {
        const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
        const settings = await readFile(args[args.indexOf('--config') + 1], 'utf8');
        expect(settings).toContain('enabled: false');
        expect(settings).toContain('maxConcurrency: 4');
        expect(settings).toContain('task: "cindy/child"');
        expect(settings).toContain('backend: off');
        const prompt = await readFile(args[args.indexOf('--append-system-prompt') + 1], 'utf8');
        expect(prompt).toContain('project memory index');
        expect(prompt).toContain('custom instructions');
        expect(args).not.toContain('--system-prompt');
        expect(getStore).toHaveBeenCalledWith('/project-key');
        expect(toTools).toHaveBeenCalledWith(expect.objectContaining({ memoryEnabled: true, memoryScopeKey: '/project-key' }));
        expect(models).toHaveBeenCalledWith(expect.objectContaining({ subagentModel: 'child', providerId: 'source' }));
      } finally { await session.close({ reason: 'navigation' }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('holds native memory until the runtime exits and releases on failed startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-harness-lease-'));
    try {
      const workdir = path.join(root, 'work');
      await mkdir(workdir);
      const release = vi.fn(async () => {});
      const acquire = vi.fn(async () => release);
      const deps: Partial<AgentDeps> = {
        resolveOmpHarnessSettings: () => ({ unifiedMemoryEnabled: false, compactionEnabled: true, nativeMemoryDbPath: path.join(root, 'memory.db') }),
        acquireOmpMemoryLease: acquire,
      };
      const session = await agentFor(root, fakeOmpProcess(path.join(root, 'ok.jsonl')), [], deps)
        .startSession({ sessionId: 'native', workingDir: workdir, model: 'parent' });
      expect(acquire).toHaveBeenCalledWith(path.join(root, 'memory.db'));
      expect(release).not.toHaveBeenCalled();
      await session.close({ reason: 'navigation' });
      expect(release).toHaveBeenCalled();
      release.mockClear();
      await expect(agentFor(root, fakeOmpProcess('invalid-relative.jsonl'), [], deps)
        .startSession({ sessionId: 'bad', workingDir: workdir, model: 'parent' })).rejects.toThrow();
      expect(release).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
