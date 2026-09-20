import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { assertRendererSessionSourceAllowed } from '../sessionSourceGuard';

const userData = path.resolve('C:\\Users\\me\\AppData\\Roaming\\Cindy');
const worktree = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
const storedWorktree = worktree.replace(/\\/g, '/');
const checkout = path.join(userData, 'cindy-make', 'source');
const managedGitEnvironment = { PATH: path.join('C:', 'managed-git') };
const managedGitExecution = {
  processEnvironment: managedGitEnvironment,
  gitExecutable: path.resolve('C:\\managed-git\\git.exe'),
};

describe('assertRendererSessionSourceAllowed', () => {
  it('lets ordinary creates through without a source', async () => {
    await expect(
      assertRendererSessionSourceAllowed({
        source: undefined,
        workingDir: 'C:\\repo',
        remoteHostId: null,
        userData,
      }),
    ).resolves.toBeUndefined();
  });

  it('uses the Git environment selected by the Make toolchain to verify a managed task', async () => {
    const resolveGitEnvironment = vi.fn(async () => managedGitExecution);
    const verifyWorktree = vi.fn(async (_userData, requested, _signal, git) => {
      return requested === storedWorktree && git === managedGitExecution;
    });
    await expect(
      assertRendererSessionSourceAllowed(
        {
          source: 'cindy-make',
          workingDir: worktree,
          remoteHostId: null,
          userData,
        },
        { resolveGitEnvironment, verifyWorktree },
      ),
    ).resolves.toBeUndefined();
    expect(resolveGitEnvironment).toHaveBeenCalledWith(userData, expect.any(AbortSignal));
    expect(verifyWorktree).toHaveBeenCalledWith(
      userData,
      storedWorktree,
      expect.any(AbortSignal),
      managedGitExecution,
    );
  });

  it('rejects non-managed paths before probing Git and rejects unavailable Git', async () => {
    const resolveGitEnvironment = vi.fn(async () => managedGitExecution);
    const verifyWorktree = vi.fn(async () => true);
    for (const workingDir of [
      checkout,
      'C:\\repo',
      undefined,
      path.join(userData, 'cindy-make', 'worktrees'),
      path.join(worktree, 'apps'),
      path.join(userData, 'cindy-make', 'worktrees', '..', 'source'),
    ]) {
      await expect(
        assertRendererSessionSourceAllowed(
          { source: 'cindy-make', workingDir, remoteHostId: null, userData },
          { resolveGitEnvironment, verifyWorktree },
        ),
      ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    }
    expect(resolveGitEnvironment).not.toHaveBeenCalled();
    expect(verifyWorktree).not.toHaveBeenCalled();

    await expect(
      assertRendererSessionSourceAllowed(
        { source: 'cindy-make', workingDir: worktree, remoteHostId: null, userData },
        { resolveGitEnvironment: async () => null, verifyWorktree },
      ),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(verifyWorktree).not.toHaveBeenCalled();
  });

  it('rejects remote hosts and every other renderer-requested source', async () => {
    await expect(
      assertRendererSessionSourceAllowed({
        source: 'cindy-make',
        workingDir: worktree,
        remoteHostId: 'build-box',
        userData,
      }),
    ).rejects.toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    for (const source of ['bot', 'review', 'desktop']) {
      await expect(
        assertRendererSessionSourceAllowed({
          source,
          workingDir: worktree,
          remoteHostId: null,
          userData,
        }),
      ).rejects.toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    }
  });
});
