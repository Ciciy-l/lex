import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { OmpProcessLifecycle, type OmpProcessState } from './process-lifecycle.js';
import { OmpRpcClient } from './rpc-client.js';
import { createOmpStreamTransport } from './stream-transport.js';

export interface OmpProcessHostOptions {
  executablePath: string;
  workingDirectory: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  /**
   * A caller that owns an isolated one-shot process may opt into a detached
   * process group so its force-termination callback can address descendants on
   * POSIX. It is deliberately opt-in: ordinary hosts retain Node's default.
   */
  detached?: boolean;
  terminateProcessTree(child: ChildProcessWithoutNullStreams, force: boolean): void;
  onEvent(event: Readonly<Record<string, unknown>>): void;
  onState(state: OmpProcessState): void;
}

export interface OmpProcessHost {
  readonly client: OmpRpcClient;
  readonly pid: number | undefined;
  getState(): OmpProcessState;
  stopAndWait(): Promise<boolean>;
}

export function startOmpProcess(options: OmpProcessHostOptions): OmpProcessHost {
  if (
    !isAbsolute(options.executablePath) ||
    !isAbsolute(options.workingDirectory) ||
    /\.(?:cmd|bat)$/iu.test(options.executablePath) ||
    options.executablePath.includes('\0') ||
    options.workingDirectory.includes('\0')
  ) {
    throw new Error('OMP requires an absolute executable and working directory without a shell');
  }
  if (
    !Array.isArray(options.arguments) ||
    options.arguments.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  )
    throw new Error('Invalid OMP arguments');
  if (
    !options.environment ||
    typeof options.environment !== 'object' ||
    Array.isArray(options.environment)
  ) {
    throw new Error('OMP requires an explicit isolated environment');
  }
  if (options.detached !== undefined && typeof options.detached !== 'boolean')
    throw new Error('Invalid OMP detached-process setting');
  const environment: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(options.environment)) {
    if (
      !key ||
      key.includes('=') ||
      key.includes('\0') ||
      typeof value !== 'string' ||
      value.includes('\0')
    ) {
      throw new Error('Invalid OMP environment');
    }
    environment[key] = value;
  }
  if (
    typeof options.terminateProcessTree !== 'function' ||
    typeof options.onEvent !== 'function' ||
    typeof options.onState !== 'function'
  )
    throw new Error('OMP requires lifecycle callbacks');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executablePath, [...options.arguments], {
      cwd: options.workingDirectory,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.detached === true ? { detached: true } : {}),
    });
  } catch {
    throw new Error('OMP process could not be started');
  }

  let client: OmpRpcClient | undefined;
  let transport: ReturnType<typeof createOmpStreamTransport> | undefined;
  let directExited = false;
  let resourcesClosed = false;
  const closeResources = (): void => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    client?.close();
    transport?.close();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try {
        stream.destroy();
      } catch {
        continue;
      }
    }
  };
  const lifecycle = new OmpProcessLifecycle({
    requestTermination: (force) => {
      if (child.pid !== undefined && !directExited) options.terminateProcessTree(child, force);
    },
    onState: (state) => {
      if (state === 'stopping' || state === 'exit-unconfirmed') closeResources();
      try {
        options.onState(state);
      } catch (error) {
        closeResources();
        throw error;
      }
    },
  });
  const shutdown = (): void => {
    lifecycle.stop();
    closeResources();
  };
  child.on('exit', () => {
    directExited = true;
    client?.stopAcceptingRequests();
    transport?.beginDrain();
    lifecycle.beginDrain();
  });
  child.on('error', () => {
    shutdown();
    if (child.pid === undefined) lifecycle.confirmExit();
  });
  child.on('close', () => {
    lifecycle.confirmExit();
    client?.close();
    transport?.close();
  });
  child.stderr.on('error', shutdown);
  child.stderr.resume();
  try {
    transport = createOmpStreamTransport(child.stdin, child.stdout, shutdown);
    const ownedTransport = transport;
    client = new OmpRpcClient(
      ownedTransport,
      (event) => {
        if (event.type === 'ready') {
          if (
            event.protocolVersion !== 1 ||
            !Array.isArray(event.supportedProtocolVersions) ||
            !event.supportedProtocolVersions.includes(1)
          ) {
            shutdown();
            return;
          }
          if (!lifecycle.markReady()) return;
        }
        options.onEvent(event);
      },
      () => ownedTransport.close(),
    );
  } catch {
    shutdown();
    throw new Error('OMP process transport could not be initialized');
  }
  const ownedClient = client;
  return {
    client: ownedClient,
    pid: child.pid,
    getState: () => lifecycle.getState(),
    stopAndWait: () => {
      const result = lifecycle.stopAndWait();
      shutdown();
      return result;
    },
  };
}
