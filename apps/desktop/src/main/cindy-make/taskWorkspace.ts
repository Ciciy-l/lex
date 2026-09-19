import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { MakeTaskWorkspace } from '../../shared/cindyMakeDoctor.js';
import { runSourceGit } from './sourceGit.js';
import { runSourcePnpm } from './sourcePnpm.js';
import {
  CINDY_MAKE_RUN_ID_PATTERN,
  CINDY_PERSONAL_BRANCH,
  CINDY_SOURCE_REPOSITORY,
  makeSourceCheckoutPath,
  makeSourceRoot,
  makeTaskBranch,
  makeTaskWorktreePath,
  makeWorktreesRoot,
} from './sourcePaths.js';

export type TaskWorkspacePhase = 'checking' | 'creating' | 'installing';

export interface TaskWorkspaceDeps {
  /** Toolchain PATH (system tools first, managed copies otherwise). */
  processEnvironment: NodeJS.ProcessEnv;
  /** Absolute Git executable selected by the Make toolchain. */
  gitExecutable: string;
  git?: typeof runSourceGit;
  pnpm?: typeof runSourcePnpm;
  /** Injectable only for the creation pipeline's synthetic unit tests. */
  verifyWorktree?: (
    userData: string,
    workingDir: string,
    signal: AbortSignal,
    deps: CindyMakeWorktreeVerificationDeps,
  ) => Promise<VerifiedCindyMakeWorktree | null>;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function isDescendantPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isPlainDirectory(directory: string): Promise<boolean> {
  try {
    const entry = await lstat(directory);
    // Windows junctions and POSIX links are not an acceptable authorization
    // boundary for a host-owned Git commit. Fail closed before resolving them.
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

interface WorktreeRegistration {
  path: string;
  branch?: string;
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const worktree = lines
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length);
      if (!worktree) return null;
      const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      return { path: worktree, ...(branch ? { branch } : {}) };
    })
    .filter((entry): entry is WorktreeRegistration => entry !== null);
}

/** Resolve Git's path output against the repository that produced it. */
async function resolveGitPath(
  git: typeof runSourceGit,
  gitExecutable: string,
  environment: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string | null> {
  const output = await git(gitExecutable, environment, args, cwd, signal);
  const reported = output.trim();
  if (!reported || /[\0\r\n]/.test(reported)) return null;
  try {
    return await realpath(path.resolve(cwd, reported));
  } catch {
    return null;
  }
}

export interface CindyMakeWorktreeVerificationDeps {
  /** Toolchain PATH selected by the host; never inherited from a renderer. */
  processEnvironment: NodeJS.ProcessEnv;
  /** Absolute Git executable selected by the host toolchain. */
  gitExecutable: string;
  git?: typeof runSourceGit;
}

export interface VerifiedCindyMakeWorktree {
  /** Canonical filesystem path checked immediately before returning. */
  path: string;
  branch: string;
}

/**
 * Prove a Cindy Make worktree is the registered direct child of the managed
 * Cindy checkout. The lexical run-id check alone is intentionally insufficient:
 * a directory link could otherwise redirect host-owned `git add --all`/commit.
 *
 * This is a fail-closed authorization check, not an OS sandbox against a
 * same-user attacker racing a later Git process. Callers re-run it immediately
 * before every host-owned Git operation.
 */
export async function verifyCindyMakeWorktree(
  userData: string,
  workingDir: string,
  signal: AbortSignal,
  deps: CindyMakeWorktreeVerificationDeps,
): Promise<VerifiedCindyMakeWorktree | null> {
  if (!isCindyMakeWorktreePath(userData, workingDir) || signal.aborted) return null;
  const requested = path.resolve(workingDir);
  const runId = path.basename(requested);
  const managedRoot = makeSourceRoot(userData);
  const sourcePath = makeSourceCheckoutPath(userData);
  const worktreesRoot = makeWorktreesRoot(userData);
  const branch = makeTaskBranch(runId);
  try {
    if (
      !(await isPlainDirectory(managedRoot)) ||
      !(await isPlainDirectory(sourcePath)) ||
      !(await isPlainDirectory(worktreesRoot)) ||
      !(await isPlainDirectory(requested))
    )
      return null;

    const [canonicalManagedRoot, canonicalSource, canonicalWorktreesRoot, canonicalWorktree] =
      await Promise.all([
        realpath(managedRoot),
        realpath(sourcePath),
        realpath(worktreesRoot),
        realpath(requested),
      ]);
    if (
      !samePath(canonicalSource, path.join(canonicalManagedRoot, 'source')) ||
      !samePath(canonicalWorktreesRoot, path.join(canonicalManagedRoot, 'worktrees')) ||
      !samePath(canonicalWorktree, path.join(canonicalWorktreesRoot, runId))
    )
      return null;

    const git = deps.git ?? runSourceGit;
    const remote = (
      await git(
        deps.gitExecutable,
        deps.processEnvironment,
        ['remote', 'get-url', 'origin'],
        canonicalSource,
        signal,
      )
    ).trim();
    if (remote !== CINDY_SOURCE_REPOSITORY) return null;
    const sourceBranch = (
      await git(
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        canonicalSource,
        signal,
      )
    ).trim();
    if (sourceBranch !== CINDY_PERSONAL_BRANCH) return null;

    // A worktree-list entry alone is not an authorization boundary: stale
    // metadata can still name a directory that was replaced by another Git
    // checkout. Prove the current directory is a direct worktree of this
    // source checkout's exact Git common directory before any host write.
    const sourceGitDirectory = path.join(canonicalSource, '.git');
    if (!(await isPlainDirectory(sourceGitDirectory))) return null;
    const [
      canonicalExpectedSourceCommon,
      canonicalSourceTopLevel,
      canonicalSourceCommon,
      canonicalWorktreeTopLevel,
      canonicalWorktreeCommon,
      canonicalWorktreeGitDirectory,
    ] = await Promise.all([
      realpath(sourceGitDirectory),
      resolveGitPath(
        git,
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--show-toplevel'],
        canonicalSource,
        signal,
      ),
      resolveGitPath(
        git,
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--git-common-dir'],
        canonicalSource,
        signal,
      ),
      resolveGitPath(
        git,
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--show-toplevel'],
        canonicalWorktree,
        signal,
      ),
      resolveGitPath(
        git,
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--git-common-dir'],
        canonicalWorktree,
        signal,
      ),
      resolveGitPath(
        git,
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--git-dir'],
        canonicalWorktree,
        signal,
      ),
    ]);
    if (
      !canonicalSourceTopLevel ||
      !canonicalSourceCommon ||
      !canonicalWorktreeTopLevel ||
      !canonicalWorktreeCommon ||
      !canonicalWorktreeGitDirectory ||
      !samePath(canonicalSourceTopLevel, canonicalSource) ||
      !samePath(canonicalSourceCommon, canonicalExpectedSourceCommon) ||
      !samePath(canonicalWorktreeTopLevel, canonicalWorktree) ||
      !samePath(canonicalWorktreeCommon, canonicalSourceCommon) ||
      !isDescendantPath(
        path.join(canonicalSourceCommon, 'worktrees'),
        canonicalWorktreeGitDirectory,
      )
    )
      return null;

    const registrations = parseWorktreeRegistrations(
      await git(
        deps.gitExecutable,
        deps.processEnvironment,
        ['worktree', 'list', '--porcelain'],
        canonicalSource,
        signal,
      ),
    );
    const registered = await Promise.all(
      registrations
        .filter((entry) => entry.branch === `refs/heads/${branch}`)
        .map(async (entry) => {
          try {
            return samePath(await realpath(entry.path), canonicalWorktree);
          } catch {
            return false;
          }
        }),
    );
    if (!registered.some(Boolean)) return null;
    const currentBranch = (
      await git(
        deps.gitExecutable,
        deps.processEnvironment,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        canonicalWorktree,
        signal,
      )
    ).trim();
    if (currentBranch !== branch) return null;

    // Detect ordinary substitutions that happened while Git was reading its
    // registration, then hand the canonical path back to the caller.
    if (
      !(await isPlainDirectory(requested)) ||
      !samePath(await realpath(requested), canonicalWorktree)
    )
      return null;
    return Object.freeze({ path: canonicalWorktree, branch });
  } catch {
    return null;
  }
}

/**
 * Create (or reuse) the per-task worktree: a fresh branch off the personal
 * baseline, checked out under `<root>/worktrees/<runId>`, with dependencies
 * installed so the agent can run the repository's checks immediately. Reuse
 * keeps a retry after a crash from creating a second branch for the same task.
 */
export async function prepareCindyMakeWorkspace(
  userData: string,
  runId: string,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
): Promise<MakeTaskWorkspace> {
  if (!CINDY_MAKE_RUN_ID_PATTERN.test(runId)) {
    throw Object.assign(new Error('invalid run id'), { code: 'gitFailed' });
  }
  const git = deps.git ?? runSourceGit;
  const pnpm = deps.pnpm ?? runSourcePnpm;
  const env = deps.processEnvironment;
  const gitExecutable = deps.gitExecutable;
  const sourcePath = makeSourceCheckoutPath(userData);
  const worktreePath = makeTaskWorktreePath(userData, runId);
  const branch = makeTaskBranch(runId);
  onPhase('checking');
  if (!(await exists(path.join(sourcePath, '.git')))) {
    throw Object.assign(new Error('source missing'), { code: 'environmentNotReady' });
  }
  const hasPersonal = await git(
    gitExecutable,
    env,
    ['branch', '--list', CINDY_PERSONAL_BRANCH],
    sourcePath,
    signal,
  );
  if (!hasPersonal.trim()) {
    throw Object.assign(new Error('personal branch missing'), { code: 'environmentNotReady' });
  }
  const baseCommit = await git(
    gitExecutable,
    env,
    ['rev-parse', `${CINDY_PERSONAL_BRANCH}^{commit}`],
    sourcePath,
    signal,
  );
  const hasBranch = (
    await git(gitExecutable, env, ['branch', '--list', branch], sourcePath, signal)
  ).trim();
  const worktreeGitFile = path.join(worktreePath, '.git');
  if (await exists(worktreePath)) {
    // A reused worktree must be the real one Git registered for this branch,
    // not an unrelated directory or a symlink placed at the expected path.
    if ((await lstat(worktreePath)).isSymbolicLink() || !(await exists(worktreeGitFile))) {
      throw Object.assign(new Error('worktree path occupied'), { code: 'gitFailed' });
    }
    const current = (
      await git(gitExecutable, env, ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, signal)
    ).trim();
    if (current !== branch) {
      throw Object.assign(new Error('worktree on unexpected branch'), { code: 'gitFailed' });
    }
  } else {
    onPhase('creating');
    await mkdir(makeWorktreesRoot(userData), { recursive: true });
    if (hasBranch) {
      // Branch survived a removed directory (e.g. a manual clean-up). Prune the
      // stale registration and re-attach the branch rather than failing.
      await git(gitExecutable, env, ['worktree', 'prune'], sourcePath, signal);
      await git(gitExecutable, env, ['worktree', 'add', worktreePath, branch], sourcePath, signal);
    } else {
      await git(
        gitExecutable,
        env,
        ['worktree', 'add', '-b', branch, worktreePath, CINDY_PERSONAL_BRANCH],
        sourcePath,
        signal,
      );
    }
  }
  const verify = deps.verifyWorktree ?? verifyCindyMakeWorktree;
  const verified = await verify(userData, worktreePath, signal, {
    processEnvironment: env,
    gitExecutable,
    git,
  });
  if (!verified) {
    throw Object.assign(new Error('worktree is not registered to Cindy Make'), {
      code: 'gitFailed',
    });
  }
  onPhase('installing');
  await pnpm(env, ['install', '--prefer-offline'], verified.path, signal);
  return { path: verified.path, branch, baseCommit: baseCommit.trim() };
}

/** Lexical prefilter only; host-owned operations must call verifyCindyMakeWorktree. */
export function isCindyMakeWorktreePath(userData: string, workingDir: string): boolean {
  const root = makeWorktreesRoot(userData);
  const relative = path.relative(root, path.resolve(workingDir));
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    CINDY_MAKE_RUN_ID_PATTERN.test(relative)
  );
}
