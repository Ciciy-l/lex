import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isCindyMakeWorktreePath,
  prepareCindyMakeWorkspace,
  verifyCindyMakeWorktree,
} from '../taskWorkspace';
import { CINDY_SOURCE_REPOSITORY } from '../sourcePaths';

const trustedVerifier = async (_userData: string, workingDir: string) => ({
  path: workingDir,
  branch: `cindy-make/${path.basename(workingDir)}`,
});

function isSameTestPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

describe('prepareCindyMakeWorkspace', () => {
  let userData: string;
  beforeEach(async () => {
    userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-workspace-'));
    await mkdir(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it('branches a new worktree off the personal baseline and installs dependencies', async () => {
    const git = vi.fn(async (_gitExecutable: string, _env: NodeJS.ProcessEnv, args: string[]) => {
      if (args[0] === 'branch' && args[2] === 'cindy-personal') return '  cindy-personal\n';
      if (args[0] === 'branch') return '';
      if (args[0] === 'rev-parse') return 'abcdef1234567\n';
      if (args[0] === 'worktree') return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    const phases: string[] = [];
    const workspace = await prepareCindyMakeWorkspace(
      userData,
      'run-1',
      new AbortController().signal,
      {
        processEnvironment: { PATH: '' },
        gitExecutable: path.join(userData, 'managed-git'),
        git,
        pnpm,
        verifyWorktree: trustedVerifier,
      },
      (phase) => phases.push(phase),
    );
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
    expect(workspace).toEqual({
      path: worktreePath,
      branch: 'cindy-make/run-1',
      baseCommit: 'abcdef1234567',
    });
    expect(git).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      ['worktree', 'add', '-b', 'cindy-make/run-1', worktreePath, 'cindy-personal'],
      path.join(userData, 'cindy-make', 'source'),
      expect.anything(),
    );
    expect(pnpm).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--prefer-offline'],
      worktreePath,
      expect.anything(),
    );
    expect(phases).toEqual(['checking', 'creating', 'installing']);
  });

  it('reuses an existing worktree on the task branch and refuses a foreign directory', async () => {
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-2');
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, '.git'), 'gitdir: ../../source/.git/worktrees/run-2\n');
    const git = vi.fn(
      async (_gitExecutable: string, _env: NodeJS.ProcessEnv, args: string[], cwd: string) => {
        if (args[0] === 'branch')
          return args[2] === 'cindy-personal' ? 'cindy-personal' : 'cindy-make/run-2';
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          expect(cwd).toBe(worktreePath);
          return 'cindy-make/run-2';
        }
        if (args[0] === 'rev-parse') return 'abcdef1234567';
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    );
    const pnpm = vi.fn(async () => undefined);
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git,
        pnpm,
        verifyWorktree: trustedVerifier,
      }),
    ).resolves.toMatchObject({ path: worktreePath, branch: 'cindy-make/run-2' });
    expect(git.mock.calls.some(([, , args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(worktreePath, '.git'));
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git,
        pnpm,
        verifyWorktree: trustedVerifier,
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });

  it('fails before touching Git when the source or personal branch is missing', async () => {
    const git = vi.fn(
      async (_gitExecutable: string, _env: NodeJS.ProcessEnv, _args: string[]) => '',
    );
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    expect(git.mock.calls.some(([, , args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    await expect(
      prepareCindyMakeWorkspace(userData, '../escape', new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });
});

describe('verifyCindyMakeWorktree', () => {
  let userData: string;
  let source: string;
  let worktree: string;

  beforeEach(async () => {
    userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-verify-'));
    source = path.join(userData, 'cindy-make', 'source');
    worktree = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
    await Promise.all([
      mkdir(path.join(source, '.git', 'worktrees', 'run-1'), { recursive: true }),
      mkdir(worktree, { recursive: true }),
    ]);
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  function gitFor(
    registrationBranch = 'refs/heads/cindy-make/run-1',
    topology: {
      worktreeTopLevel?: string;
      worktreeCommon?: string;
      worktreeGitDirectory?: string;
    } = {},
  ) {
    const sourceCommon = path.join(source, '.git');
    const worktreeTopLevel = topology.worktreeTopLevel ?? worktree;
    const worktreeCommon = topology.worktreeCommon ?? sourceCommon;
    const worktreeGitDirectory =
      topology.worktreeGitDirectory ?? path.join(sourceCommon, 'worktrees', 'run-1');
    return vi.fn(async (_gitExecutable: string, _env: NodeJS.ProcessEnv, args: string[], cwd: string) => {
      if (args.join(' ') === 'remote get-url origin') {
        expect(isSameTestPath(cwd, source)).toBe(true);
        return CINDY_SOURCE_REPOSITORY;
      }
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
        return isSameTestPath(cwd, source) ? 'cindy-personal' : 'cindy-make/run-1';
      }
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        return isSameTestPath(cwd, source) ? source : worktreeTopLevel;
      }
      if (args.join(' ') === 'rev-parse --git-common-dir') {
        return isSameTestPath(cwd, source) ? sourceCommon : worktreeCommon;
      }
      if (args.join(' ') === 'rev-parse --git-dir') {
        return isSameTestPath(cwd, source) ? sourceCommon : worktreeGitDirectory;
      }
      if (args.join(' ') === 'worktree list --porcelain') {
        return `worktree ${source}\nbranch refs/heads/cindy-personal\n\nworktree ${worktree}\nbranch ${registrationBranch}\n`;
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
  }

  it('requires the expected registered Cindy worktree and branch', async () => {
    const git = gitFor();
    await expect(
      verifyCindyMakeWorktree(userData, worktree, new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git,
      }),
    ).resolves.toEqual({ path: await realpath(worktree), branch: 'cindy-make/run-1' });

    await expect(
      verifyCindyMakeWorktree(userData, worktree, new AbortController().signal, {
        processEnvironment: {},
        gitExecutable: path.join(userData, 'managed-git'),
        git: gitFor('refs/heads/cindy-make/other'),
      }),
    ).resolves.toBeNull();
  });

  it('rejects a task path replaced by a symlink or Windows junction before host Git runs', async () => {
    const foreign = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-foreign-'));
    try {
      await rm(worktree, { recursive: true, force: true });
      await symlink(foreign, worktree, process.platform === 'win32' ? 'junction' : 'dir');
      const git = gitFor();
      await expect(
        verifyCindyMakeWorktree(userData, worktree, new AbortController().signal, {
          processEnvironment: {},
          gitExecutable: path.join(userData, 'managed-git'),
          git,
        }),
      ).resolves.toBeNull();
      expect(git).not.toHaveBeenCalled();
    } finally {
      await rm(foreign, { recursive: true, force: true });
    }
  });

  it('rejects an ordinary foreign checkout despite a stale source worktree registration', async () => {
    const foreignRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-foreign-git-'));
    try {
      const foreignCommon = path.join(foreignRoot, '.git');
      await mkdir(path.join(foreignCommon, 'worktrees', 'run-1'), { recursive: true });
      const git = gitFor('refs/heads/cindy-make/run-1', {
        // The task directory remains a direct physical child of Cindy Make's
        // worktrees root, while Git reports that it belongs to another repo.
        worktreeCommon: foreignCommon,
        worktreeGitDirectory: path.join(foreignCommon, 'worktrees', 'run-1'),
      });
      await expect(
        verifyCindyMakeWorktree(userData, worktree, new AbortController().signal, {
          processEnvironment: {},
          gitExecutable: path.join(userData, 'managed-git'),
          git,
        }),
      ).resolves.toBeNull();
      expect(
        git.mock.calls.some(([, , args]) => args.join(' ') === 'worktree list --porcelain'),
      ).toBe(false);
    } finally {
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });
});

describe('isCindyMakeWorktreePath', () => {
  const userData = path.resolve(os.tmpdir(), 'cindy-userdata');
  const worktrees = path.join(userData, 'cindy-make', 'worktrees');
  it('accepts only a direct child of the worktrees root named like a run id', () => {
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1'))).toBe(true);
    expect(isCindyMakeWorktreePath(userData, worktrees)).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1', 'apps'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, '..', 'source'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(userData, 'cindy-make', 'source'))).toBe(
      false,
    );
  });
});
