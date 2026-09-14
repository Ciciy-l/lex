/**
 * Pairs the two inputs that a future OMP probe launcher must never mix:
 * a locally hash-verified development runtime and a freshly materialized,
 * isolated filesystem sandbox.
 *
 * This module is intentionally not a launcher. It imports no child-process
 * API and does not make OMP available to sessions, the renderer, or packaged
 * builds. A later launcher must still supply platform-safe process containment
 * and re-verify the runtime immediately before it executes the binary.
 */
import { validateOmpProbeModel, type OmpProbeModel } from '@cindy/maker-core';

import {
  createOmpProbeSandbox,
  type OmpProbeSandbox,
  validateOmpProbeTemporaryRoot,
} from './omp-probe-sandbox.js';
import { resolveVerifiedOmpProbeRuntime, type OmpProbeRuntime } from './omp-probe-runtime.js';

export interface OmpProbePreflightOptions {
  /** Host-owned system temporary directory; never a worktree or user home. */
  temporaryRoot: string;
  model?: OmpProbeModel;
}

/**
 * Narrow spawn inputs only. There is deliberately no termination callback,
 * client, or send method here, so obtaining this preflight cannot send a
 * prompt, reply to native UI, or begin a process.
 */
export interface OmpPreparedProbeLaunch {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface OmpProbePreflight {
  readonly runtime: Omit<OmpProbeRuntime, 'binaryPath'>;
  readonly launch: OmpPreparedProbeLaunch;
  /** Release only the unique sandbox root; safe to call more than once. */
  dispose(): Promise<void>;
}

function publicRuntime(runtime: OmpProbeRuntime): Omit<OmpProbeRuntime, 'binaryPath'> {
  return Object.freeze({
    version: runtime.version,
    platformKey: runtime.platformKey,
    binaryName: runtime.binaryName,
    sha256: runtime.sha256,
    size: runtime.size,
  });
}

/**
 * Produce a no-spawn preflight. Resolve the binary first so a missing or
 * untrusted local runtime never creates a sandbox directory to clean up.
 */
export async function prepareOmpIsolatedProbe(
  options: OmpProbePreflightOptions,
): Promise<OmpProbePreflight> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Invalid OMP probe preflight options');
  const temporaryRoot = validateOmpProbeTemporaryRoot(options.temporaryRoot);
  const model = validateOmpProbeModel(options.model);
  const runtime = await resolveVerifiedOmpProbeRuntime();
  const sandbox = await createOmpProbeSandbox({
    temporaryRoot,
    ...(model === undefined ? {} : { model }),
  });
  return buildPreflight(runtime, sandbox);
}

function buildPreflight(runtime: OmpProbeRuntime, sandbox: OmpProbeSandbox): OmpProbePreflight {
  let disposePromise: Promise<void> | undefined;
  const launch = Object.freeze({
    executablePath: runtime.binaryPath,
    workingDirectory: sandbox.plan.roots.workingDirectory,
    arguments: sandbox.plan.arguments,
    environment: sandbox.plan.environment,
  });
  return Object.freeze({
    runtime: publicRuntime(runtime),
    launch,
    dispose: () => {
      if (!disposePromise) {
        disposePromise = sandbox.dispose().catch((error: unknown) => {
          // A transient filesystem failure must not permanently suppress a
          // later safe retry of this same unique sandbox root.
          disposePromise = undefined;
          throw error;
        });
      }
      return disposePromise;
    },
  });
}

/** Test-only construction hook; production must call prepareOmpIsolatedProbe. */
export const __testing = Object.freeze({ buildPreflight });
