/**
 * Owns one development-only, isolated OMP capability probe in Desktop Main.
 *
 * This is deliberately not an AgentKind, session host, renderer bridge, or
 * general OMP launcher. Its public surface projects only safe command-probe
 * snapshots and bounded process-stop state; the RPC client never escapes.
 */
import {
  OmpProbeController,
  startOmpProcess,
  type OmpProcessHost,
  type OmpProcessHostOptions,
  type OmpProbeModel,
  type OmpProbeSnapshot,
} from '@cindy/maker-core';

import {
  killProcessTree,
  type KillProcessTreeOptions,
} from '../scheduler-host/proc-util.js';
import {
  prepareOmpIsolatedProbe,
  type OmpProbePreflight,
  type OmpProbePreflightOptions,
} from './omp-probe-preflight.js';
import {
  resolveVerifiedOmpProbeRuntime,
  type OmpProbeRuntime,
} from './omp-probe-runtime.js';

type OmpProcessState = ReturnType<OmpProcessHost['getState']>;
type OmpProcessStarter = (options: OmpProcessHostOptions) => OmpProcessHost;
type OmpProbePreparer = (
  options: OmpProbePreflightOptions,
) => Promise<OmpProbePreflight>;
type OmpRuntimeVerifier = () => Promise<OmpProbeRuntime>;
type OmpTreeTerminator = typeof killProcessTree;

export interface OmpIsolatedProbeHostOptions {
  /** A host-owned system temporary root used to create one fresh probe home. */
  temporaryRoot: string;
  /** Optional explicit model metadata for the no-prompt protocol probe. */
  model?: OmpProbeModel;
  /** Safe command catalog/state projection for an internal Main consumer. */
  onSnapshot?(snapshot: OmpProbeSnapshot): void;
}

/**
 * Main-only ownership of the first OMP probe. It never exposes a raw client,
 * request method, UI-response method, or process handle to its caller.
 */
export interface OmpIsolatedProbeHost {
  getSnapshot(): OmpProbeSnapshot;
  getProcessState(): OmpProcessState;
  /** Settles after the initial command/state reads reach a safe terminal view. */
  waitForProbe(): Promise<OmpProbeSnapshot>;
  /**
   * Requests a stop and removes the unique sandbox only after direct process
   * close is confirmed. A false result deliberately retains the sandbox.
   */
  stopAndDispose(): Promise<boolean>;
}

interface OmpIsolatedProbeHostDependencies {
  prepare: OmpProbePreparer;
  verifyRuntime: OmpRuntimeVerifier;
  start: OmpProcessStarter;
  terminateTree: OmpTreeTerminator;
  platform: NodeJS.Platform;
}

const DEFAULT_DEPENDENCIES: OmpIsolatedProbeHostDependencies = Object.freeze({
  prepare: prepareOmpIsolatedProbe,
  verifyRuntime: resolveVerifiedOmpProbeRuntime,
  start: startOmpProcess,
  terminateTree: killProcessTree,
  platform: process.platform,
});

function validateOptions(
  options: OmpIsolatedProbeHostOptions,
): OmpProbePreflightOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Invalid OMP isolated probe host options');
  if (
    options.onSnapshot !== undefined &&
    typeof options.onSnapshot !== 'function'
  ) {
    throw new Error('Invalid OMP isolated probe snapshot observer');
  }
  return {
    temporaryRoot: options.temporaryRoot,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

function probeTerminal(snapshot: OmpProbeSnapshot): boolean {
  return (
    snapshot.status === 'ready' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'closed'
  );
}

/** The launch path must still be the same pinned file immediately before spawn. */
function matchesPreflightRuntime(
  preflight: OmpProbePreflight,
  runtime: OmpProbeRuntime,
): boolean {
  return (
    runtime.binaryPath === preflight.launch.executablePath &&
    runtime.version === preflight.runtime.version &&
    runtime.platformKey === preflight.runtime.platformKey &&
    runtime.binaryName === preflight.runtime.binaryName &&
    runtime.sha256 === preflight.runtime.sha256 &&
    runtime.size === preflight.runtime.size
  );
}

/**
 * Ask for a graceful direct-process exit first. The lifecycle upgrades to the
 * repository's existing cross-platform tree cleanup only when it must force
 * termination: detached POSIX probes use their process group, while Windows
 * uses the identity-bound fallback rather than a reusable numeric PID tree.
 */
function requestProbeTermination(
  child: Parameters<OmpProcessHostOptions['terminateProcessTree']>[0],
  force: boolean,
  platform: NodeJS.Platform,
  terminateTree: OmpTreeTerminator,
): void {
  if (!force) {
    try {
      child.kill('SIGTERM');
    } catch {
      // The lifecycle still waits for a real close or its bounded timeout.
    }
    return;
  }
  const options: KillProcessTreeOptions | undefined =
    platform === 'win32'
      ? { requireWindowsIdentityBoundTermination: true }
      : undefined;
  terminateTree(child.pid, child, undefined, options);
}

/**
 * Start the internal capability probe. Product startup does not call this yet;
 * callers must remain in Desktop Main and explicitly provide the host temp root.
 */
export async function startOmpIsolatedProbeHost(
  options: OmpIsolatedProbeHostOptions,
): Promise<OmpIsolatedProbeHost> {
  return startWithDependencies(options, DEFAULT_DEPENDENCIES);
}

async function startWithDependencies(
  options: OmpIsolatedProbeHostOptions,
  dependencies: OmpIsolatedProbeHostDependencies,
): Promise<OmpIsolatedProbeHost> {
  const preflightOptions = validateOptions(options);
  const preflight = await dependencies.prepare(preflightOptions);
  try {
    const runtime = await dependencies.verifyRuntime();
    if (!matchesPreflightRuntime(preflight, runtime))
      throw new Error('OMP runtime changed after preflight');
  } catch {
    // No child has been handed to startOmpProcess yet, so this unique root is
    // safe to remove when its just-in-time runtime verification fails.
    await preflight.dispose().catch(() => undefined);
    throw new Error('OMP isolated probe runtime verification failed before start');
  }
  let processHost: OmpProcessHost | undefined;
  // Callbacks registered during startOmpProcess may run before its client can
  // be returned, so this deliberately begins empty and is filled afterward.
  let controller: OmpProbeController | null = null;
  let probeStarted = false;
  let probeSettled = false;
  let settleProbePromise!: (snapshot: OmpProbeSnapshot) => void;
  let stopPromise: Promise<boolean> | undefined;
  const pendingStates: OmpProcessState[] = [];
  const pendingEvents: Readonly<Record<string, unknown>>[] = [];
  const probePromise = new Promise<OmpProbeSnapshot>((resolve) => {
    settleProbePromise = resolve;
  });

  const settleProbe = (snapshot: OmpProbeSnapshot): void => {
    if (probeSettled || !probeTerminal(snapshot)) return;
    probeSettled = true;
    settleProbePromise(snapshot);
  };

  const startProbe = (): void => {
    if (!controller || probeStarted) return;
    probeStarted = true;
    void controller.start().then(
      (snapshot) => settleProbe(snapshot),
      () => {
        // OmpProbeController contains expected wire failures. This is a final
        // defensive boundary for an unexpected implementation rejection.
        controller?.close();
        if (controller) settleProbe(controller.getSnapshot());
      },
    );
  };

  const observeProcessState = (state: OmpProcessState): void => {
    if (!controller) {
      pendingStates.push(state);
      return;
    }
    if (state === 'ready') {
      startProbe();
      return;
    }
    if (state === 'stopping' && controller.getSnapshot().status === 'idle') {
      // A startup timeout or pre-ready failure has no outstanding probe read
      // that can publish its own bounded failure result.
      controller.close();
    } else if (state === 'exit-unconfirmed' || state === 'exited') {
      controller.close();
    }
    settleProbe(controller.getSnapshot());
  };

  const observeEvent = (event: Readonly<Record<string, unknown>>): void => {
    if (!controller) {
      pendingEvents.push(event);
      return;
    }
    controller.observe(event);
  };

  try {
    processHost = dependencies.start({
      ...preflight.launch,
      // POSIX process groups give the existing shared tree helper a stable
      // group target. Windows intentionally stays non-detached.
      detached: dependencies.platform !== 'win32',
      terminateProcessTree: (child, force) =>
        requestProbeTermination(
          child,
          force,
          dependencies.platform,
          dependencies.terminateTree,
        ),
      onEvent: observeEvent,
      onState: observeProcessState,
    });
  } catch {
    // startOmpProcess can fail after a child was created but before it can hand
    // its lifecycle object back. Retaining this unique root is safer than
    // recursively deleting files a still-running child may be using.
    throw new Error('OMP isolated probe could not be started; sandbox retained');
  }

  controller = new OmpProbeController({
    client: processHost.client,
    onSnapshot: (snapshot) => {
      settleProbe(snapshot);
      try {
        options.onSnapshot?.(snapshot);
      } catch {
        // A Main projection observer cannot destabilize the wire connection.
      }
    },
  });
  for (const state of pendingStates) observeProcessState(state);
  pendingStates.length = 0;
  for (const event of pendingEvents) observeEvent(event);
  pendingEvents.length = 0;
  observeProcessState(processHost.getState());

  const ownedProcessHost = processHost;
  return Object.freeze({
    getSnapshot: () => controller!.getSnapshot(),
    getProcessState: () => ownedProcessHost.getState(),
    waitForProbe: () => probePromise,
    stopAndDispose: () => {
      if (stopPromise) return stopPromise;
      const pending = (async (): Promise<boolean> => {
        controller!.close();
        const confirmed = await ownedProcessHost.stopAndWait();
        if (!confirmed) return false;
        await preflight.dispose();
        return true;
      })();
      stopPromise = pending;
      void pending.then(
        (confirmed) => {
          // A late child close may turn a previous unconfirmed stop into a
          // confirmed one. Let the caller retry cleanup only in that case.
          if (!confirmed && stopPromise === pending) stopPromise = undefined;
        },
        () => {
          // A transient cleanup error is retriable through the preflight's
          // single-flight disposer once the direct child is confirmed gone.
          if (stopPromise === pending) stopPromise = undefined;
        },
      );
      return pending;
    },
  });
}

/** Test-only dependency injection; production uses the fixed Main-only path. */
export const __testing = Object.freeze({ startWithDependencies });
