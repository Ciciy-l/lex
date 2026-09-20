import path from 'node:path';
import { CINDY_MAKE_SESSION_SOURCE } from '../../../shared/cindyMakeSession.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import {
  isCindyMakeWorktreePath,
  type CindyMakeWorktreeVerificationDeps,
  verifyCindyMakeWorktree,
} from '../../cindy-make/taskWorkspace.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolchainProcessEnvironment,
} from '../../cindy-make/toolchainEnvironment.js';
import { normalizeRemoteHostId } from '../mapper.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

type CindyMakeGitExecution = Pick<
  CindyMakeWorktreeVerificationDeps,
  'processEnvironment' | 'gitExecutable'
>;

/**
 * Renderer may only request the Cindy Make purpose, and only for a task
 * worktree Cindy created under its managed source root: the marker later
 * exposes the `cindy_make` tool and commits the worktree on completion. Bot
 * tasks keep going through the Bot lifecycle service.
 */
export interface SessionSourceGuardDeps {
  /** Selects a system or managed Git before the verifier starts any Git command. */
  resolveGitEnvironment?: (
    userData: string,
    signal: AbortSignal,
  ) => Promise<CindyMakeGitExecution | null>;
  verifyWorktree?: (
    userData: string,
    workingDir: string,
    signal: AbortSignal,
    git: CindyMakeGitExecution,
  ) => Promise<boolean>;
}

async function resolveCindyMakeGitEnvironment(
  userData: string,
  signal: AbortSignal,
): Promise<CindyMakeGitExecution | null> {
  const toolchain = await createMakeToolchainEnvironment(userData);
  const processEnvironment = await resolveMakeToolchainProcessEnvironment(
    toolchain,
    ['git'],
    signal,
  );
  const gitExecutable = toolchain.selectedToolPath('git');
  return processEnvironment && gitExecutable && path.isAbsolute(gitExecutable)
    ? { processEnvironment, gitExecutable }
    : null;
}

export async function assertRendererSessionSourceAllowed(
  input: {
    source: unknown;
    workingDir: string | undefined;
    remoteHostId: unknown;
    userData: string;
  },
  deps: SessionSourceGuardDeps = {},
): Promise<void> {
  if (input.source === undefined) return;
  if (input.source !== CINDY_MAKE_SESSION_SOURCE) {
    throwIpcError(
      'UNSUPPORTED_CAPABILITY',
      'Bot task creation is only available through the Bot lifecycle service',
    );
  }
  if (normalizeRemoteHostId(typeof input.remoteHostId === 'string' ? input.remoteHostId : null)) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cindy Make tasks are local-only');
  }
  const requested = normalizeWorkingDirForStorage(input.workingDir);
  const signal = AbortSignal.timeout(10_000);
  let verified = false;
  if (requested && isCindyMakeWorktreePath(input.userData, requested)) {
    try {
      const git = await (deps.resolveGitEnvironment ?? resolveCindyMakeGitEnvironment)(
        input.userData,
        signal,
      );
      verified = git
        ? await (deps.verifyWorktree
            ? deps.verifyWorktree(input.userData, requested, signal, git)
            : verifyCindyMakeWorktree(input.userData, requested, signal, git).then(Boolean))
        : false;
    } catch {
      // Treat an unavailable or failing managed Git lookup as an untrusted
      // workspace rather than leaking an implementation error to the renderer.
      verified = false;
    }
  }
  if (!verified) {
    throwIpcError('INVALID_PARAMS', 'Cindy Make tasks can only use a managed task worktree');
  }
}
