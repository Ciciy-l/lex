/**
 * Creates the filesystem half of OMP's first, no-prompt capability probe.
 *
 * This is deliberately not an OMP session home and not a general launcher.
 * It controls the roots used by OMP's eager dotenv/configuration discovery.
 * It is not an OS sandbox or a general project launcher.
 */
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createOmpIsolatedProbeLaunchPlan,
  type OmpProbeLaunchPlan,
  type OmpProbeModel,
} from '@cindy/maker-core';

export interface OmpProbeSandboxOptions {
  /** Must be a host-owned system temporary directory, never the worktree. */
  temporaryRoot: string;
  model?: OmpProbeModel;
}

export interface OmpProbeSandbox {
  readonly plan: OmpProbeLaunchPlan;
  /** Remove only the unique directory created for this probe. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * Pure validation used by preflight before it hashes a runtime or creates a
 * directory. The sandbox repeats it because callers may use it directly.
 */
export function validateOmpProbeTemporaryRoot(temporaryRoot: unknown): string {
  if (
    typeof temporaryRoot !== 'string' ||
    !temporaryRoot ||
    temporaryRoot.includes('\0') ||
    !path.isAbsolute(temporaryRoot)
  ) {
    throw new Error('OMP probe requires an absolute host temporary directory');
  }
  return temporaryRoot;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function removeCreatedProbeRoot(parent: string, root: string): Promise<void> {
  if (!isInside(parent, root)) throw new Error('Unsafe OMP probe cleanup target');
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // A replaced reparse point is not a safe recursive-delete target.
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error('Unsafe OMP probe cleanup target');
  await rm(root, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
}

/**
 * Materializes a plan from maker-core in a brand-new temporary directory.
 * No process is spawned here. The caller owns process termination and must
 * dispose this sandbox only after the probe child has finished using it.
 */
export async function createOmpProbeSandbox(
  options: OmpProbeSandboxOptions,
): Promise<OmpProbeSandbox> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('OMP probe requires an absolute host temporary directory');
  const temporaryRoot = await realpath(validateOmpProbeTemporaryRoot(options.temporaryRoot));
  const root = await mkdtemp(path.join(temporaryRoot, 'lex-omp-probe-'));
  let disposed = false;
  try {
    const plan = createOmpIsolatedProbeLaunchPlan(
      {
        sandboxRoot: root,
        ...(process.platform === 'win32'
          ? {
              windowsSystemRoot:
                process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR,
            }
          : {}),
      },
      options.model,
    );
    // config is intentionally HOME/.omp because OMP joins PI_CONFIG_DIR onto
    // HOME. The probe cwd is also below HOME, which bounds OMP's known
    // project-plugin ancestor walk at this fresh directory.
    await mkdir(plan.roots.home, { recursive: false });
    await Promise.all(
      [
        plan.roots.config,
        plan.roots.agent,
        plan.roots.workingDirectory,
        plan.roots.temporary,
        plan.environment.XDG_CONFIG_HOME,
        plan.environment.XDG_DATA_HOME,
        plan.environment.XDG_STATE_HOME,
        plan.environment.XDG_CACHE_HOME,
        ...(process.platform === 'win32'
          ? [plan.environment.APPDATA, plan.environment.LOCALAPPDATA]
          : []),
      ].map((directory) => mkdir(directory!, { recursive: false })),
    );
    await writeFile(plan.roots.settingsFile, plan.settingsYaml, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return Object.freeze({
      plan,
      dispose: async () => {
        if (disposed) return;
        await removeCreatedProbeRoot(temporaryRoot, root);
        disposed = true;
      },
    });
  } catch (error) {
    await removeCreatedProbeRoot(temporaryRoot, root).catch(() => undefined);
    throw error;
  }
}
