import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { OmpProcessLifecycle, type OmpProcessState } from './process-lifecycle.js';
import { OmpRpcClient } from './rpc-client.js';
import { createOmpStreamTransport } from './stream-transport.js';

/**
 * Host-owned OMP process creation request. `maker-core` keeps the common
 * lifecycle and RPC transport, while a platform host may replace the narrow
 * creation boundary to establish native containment before OMP is resumed.
 */
export interface OmpProcessSpawnRequest {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly detached?: boolean;
}

export type OmpProcessSpawner = (
  request: OmpProcessSpawnRequest,
) => ChildProcessWithoutNullStreams;

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
  /**
   * The caller owns every descendant of this process. On POSIX this requires
   * `detached: true`, which makes the direct child the leader of a private
   * process group. Windows requires a host-native containment spawner, which
   * puts OMP in a Job Object before its first instruction is resumed.
   */
  ownsProcessTree?: boolean;
  /**
   * Optional host-native spawn boundary. Desktop uses this on Windows so OMP
   * enters a kill-on-close Job Object before its first instruction runs.
   */
  spawnProcess?: OmpProcessSpawner;
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
  if (options.ownsProcessTree !== undefined && typeof options.ownsProcessTree !== 'boolean')
    throw new Error('Invalid OMP process-tree ownership setting');
  if (
    options.ownsProcessTree === true &&
    process.platform !== 'win32' &&
    options.detached !== true
  ) {
    throw new Error('OMP process-tree ownership requires an isolated POSIX process group');
  }
  if (
    options.ownsProcessTree === true
    && process.platform === 'win32'
    && typeof options.spawnProcess !== 'function'
  ) {
    throw new Error('OMP process-tree ownership requires a Windows containment host');
  }
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
  const spawnRequest: OmpProcessSpawnRequest = Object.freeze({
    executablePath: options.executablePath,
    workingDirectory: options.workingDirectory,
    arguments: Object.freeze([...options.arguments]),
    environment: Object.freeze({ ...environment }),
    ...(options.detached === true ? { detached: true } : {}),
  });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = options.spawnProcess
      ? options.spawnProcess(spawnRequest)
      : spawn(options.executablePath, [...options.arguments], {
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
  const ownsProcessTree = options.ownsProcessTree === true;
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
      if (child.pid !== undefined && (!directExited || ownsProcessTree))
        options.terminateProcessTree(child, force);
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
    // The OMP root may exit while a descendant still owns one of its stdio
    // pipes. Reclaim that private tree now, but keep stdout open below so the
    // root's already-buffered JSONL tail can still be drained.
    if (ownsProcessTree && child.pid !== undefined) {
      try {
        options.terminateProcessTree(child, true);
      } catch {
        // The bounded drain deadline retries force termination and never turns
        // a failed signal into a confirmed process exit.
      }
    }
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
