import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { OmpProcessLifecycle, type OmpProcessState } from './process-lifecycle.js';
import { OmpRpcClient, type OmpRpcTransport } from './rpc-client.js';
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

/**
 * A host-owned remote JSONL channel. It intentionally exposes the same
 * narrow RPC surface as local stdio, but its close implementation must only
 * request transport shutdown; onClose is the evidence that the SSH command
 * channel actually finished.
 */
export interface OmpRemoteTransport extends OmpRpcTransport {
  close(): void | Promise<void>;
  /**
   * The channel became unusable (local close request, transport error, setup
   * failure, or physical close). This fences pending RPCs but is not proof
   * that the remote command has exited; only onClose supplies that evidence.
   */
  onTransportClose?(handler: () => void): () => void;
}

export interface OmpRemoteProcessHostOptions {
  transport: OmpRemoteTransport;
  onEvent(event: Readonly<Record<string, unknown>>): void;
  onState(state: OmpProcessState): void;
}

/**
 * Build an OMP process host around a remote SSH JSONL channel.
 *
 * Do not fabricate a Node ChildProcess for an SSH command: there is no local
 * pid whose exit can prove anything about the remote process. The lifecycle
 * instead waits for the transport's actual close notification and returns
 * false if that evidence never arrives within the existing bounded timeout.
 */
export function startOmpRemoteProcess(
  options: OmpRemoteProcessHostOptions,
): OmpProcessHost {
  if (
    !options ||
    typeof options !== 'object' ||
    !options.transport ||
    typeof options.transport.writeLine !== 'function' ||
    typeof options.transport.onLine !== 'function' ||
    typeof options.transport.onClose !== 'function' ||
    typeof options.transport.close !== 'function' ||
    typeof options.onEvent !== 'function' ||
    typeof options.onState !== 'function'
  ) {
    throw new Error('OMP remote process host requires a managed transport');
  }

  let closeRequested = false;
  const requestClose = (): void => {
    if (closeRequested) return;
    closeRequested = true;
    try {
      const result = options.transport.close();
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // The lifecycle timer below makes a failed close attempt visible as an
      // unconfirmed remote exit rather than treating it as completion.
    }
  };

  let client: OmpRpcClient | undefined;
  const lifecycle = new OmpProcessLifecycle({
    requestTermination: () => requestClose(),
    onState: (state) => {
      if (state === 'stopping' || state === 'exit-unconfirmed')
        client?.stopAcceptingRequests();
      options.onState(state);
    },
  });

  let physicalCloseObserved = false;
  let unsubscribePhysicalClose: (() => void) | undefined;
  let transportCloseObserved = false;
  let unsubscribeTransportClose: (() => void) | undefined;
  // A synchronously pre-closed transport is allowed to call listeners while
  // they are being registered. Until this flips, no process host exists for
  // callers to observe, so closure must only be recorded for the guard below.
  let initializationComplete = false;
  try {
    if (typeof options.transport.onTransportClose === 'function') {
      unsubscribeTransportClose = options.transport.onTransportClose(() => {
        // A requested local close or SSH transport failure immediately makes
        // the RPC channel unusable, so reject pending responses now. It is
        // deliberately not exit evidence: stopAndWait remains pending until
        // the physical SSH command channel closes (or times out unconfirmed).
        transportCloseObserved = true;
        client?.close();
        // During listener registration there is no returned host yet. Defer
        // lifecycle transition to the initialization guard below so a
        // synchronously pre-closed transport cannot leave force/exit timers
        // behind after construction throws.
        if (initializationComplete) lifecycle.stop();
      });
    }
    unsubscribePhysicalClose = options.transport.onClose(() => {
      // A remote command channel closing is the only completion evidence this
      // abstraction has. It can follow a normal exit, an SSH disconnect, or a
      // requested stop; all three make the current RPC channel unusable.
      physicalCloseObserved = true;
      client?.close();
      if (initializationComplete) lifecycle.confirmExit();
    });
    client = new OmpRpcClient(
      options.transport,
      (event) => {
        if (event.type === 'ready') {
          if (
            event.protocolVersion !== 1 ||
            !Array.isArray(event.supportedProtocolVersions) ||
            !event.supportedProtocolVersions.includes(1)
          ) {
            lifecycle.stop();
            return;
          }
          if (!lifecycle.markReady()) return;
        }
        options.onEvent(event);
      },
      () => {
        if (initializationComplete) lifecycle.stop();
      },
    );
    // A managed transport is allowed to report an already-observed close while
    // a listener is being registered. Do not return a host with an RPC client
    // that was constructed after that terminal event: callers must fail
    // immediately instead of waiting for the ready timeout on a dead channel.
    const stateAfterClientInit = lifecycle.getState();
    if (
      physicalCloseObserved
      || transportCloseObserved
      || stateAfterClientInit === 'stopping'
      || stateAfterClientInit === 'exit-unconfirmed'
      || stateAfterClientInit === 'exited'
    ) {
      client.close();
      throw new Error('OMP remote transport closed during initialization');
    }
    initializationComplete = true;
  } catch {
    lifecycle.abort();
    try {
      unsubscribePhysicalClose?.();
    } catch {
      // Best effort only; requestClose still owns the remote command.
    }
    try {
      unsubscribeTransportClose?.();
    } catch {
      // Best effort only; requestClose still owns the remote command.
    }
    requestClose();
    throw new Error('OMP remote process transport could not be initialized');
  }

  const ownedClient = client;
  return {
    client: ownedClient,
    pid: undefined,
    getState: () => lifecycle.getState(),
    stopAndWait: () => lifecycle.stopAndWait(),
  };
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
