import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewScope } from '../types';
import type { runGit } from '../gitRunner';

const remote = vi.hoisted(() => vi.fn());
vi.mock('../../file-browser/remote-deps.js', () => ({
  getRemoteFileBrowser: () => ({ request: remote }),
}));
import { listReviewRepositories, resolveCatalogRepository } from '../repositoryCatalog';
import { currentReviewRepositoryId, withReviewRepository } from '../repositoryContext';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});
function scope(root: string): ReviewScope {
  return {
    sessionId: root,
    workingDir: root,
    workdir: null,
    worktreePath: null,
    repoRoot: null,
    branch: null,
    headOid: null,
    source: null,
    isDetached: false,
    isUnborn: false,
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    resolutionChain: [],
    disabledReason: 'non-git',
    disabledMessage: null,
  };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-repositories-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'one', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'two'), { recursive: true });
  await fs.writeFile(path.join(root, 'two', '.git'), 'gitdir: ../metadata');
  await fs.mkdir(path.join(root, 'node_modules', 'ignored', '.git'), { recursive: true });
  const git = vi.fn<typeof runGit>(async (_args, options) => ({
    stdout: options!.cwd! + '\n',
    stderr: '',
    exitCode: 0,
  }));
  return { root, git, context: scope(root) };
}
describe('workspace repository catalog', () => {
  it('finds sibling repositories and worktree .git files below a non-Git parent, skipping dependencies', async () => {
    const { root, git, context } = await fixture();
    const result = await listReviewRepositories(context, null, {}, git);
    expect(result.repositories.map((repo) => repo.relativePath)).toEqual(['one', 'two']);
    expect(result.repositories[0].root).toBe(path.join(root, 'one'));
    expect(result.repositories.every((repo) => /^[a-f0-9]{64}$/.test(repo.id))).toBe(true);
    expect(result.defaultRepositoryId).toBe(result.repositories[0].id);
    expect(await listReviewRepositories(context, null, {}, git)).toBe(result);
    expect(git).toHaveBeenCalledTimes(2);
    await expect(
      resolveCatalogRepository(context, null, result.repositories[1].id, git),
    ).resolves.toBe(path.join(root, 'two'));
  });
  it('keeps a parent repository and rejects unknown identities, traversal, and replaced roots', async () => {
    const { root, git, context } = await fixture();
    context.repoRoot = path.dirname(root);
    const result = await listReviewRepositories(context, null, {}, git);
    expect(result.defaultRepositoryId).toBe(
      result.repositories.find((repo) => repo.root === context.repoRoot)!.id,
    );
    await expect(
      listReviewRepositories(context, null, { relativePath: '../escape' }, git),
    ).rejects.toThrow('INVALID_PARAMS');
    await expect(resolveCatalogRepository(context, null, 'f'.repeat(64), git)).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    git.mockResolvedValue({ stdout: path.dirname(root), stderr: '', exitCode: 0 });
    await expect(
      resolveCatalogRepository(
        context,
        null,
        result.repositories.find((repo) => repo.relativePath === 'one')!.id,
        git,
      ),
    ).rejects.toThrow('Repository identity changed');
  });
  it('uses remote POSIX paths, ignoring stale local worktree paths and reporting connection failures', async () => {
    const context = {
      ...scope('/srv/work'),
      sessionId: 'remote-catalog',
      worktreePath: 'C:\\stale',
      source: 'remote' as const,
    };
    remote.mockImplementation(async (_host, _op, input) => ({
      entries:
        input.relPath === ''
          ? [{ name: 'repo', type: 'directory' }]
          : [{ name: '.git', type: 'file' }],
    }));
    const git = vi.fn<typeof runGit>(async () => ({
      stdout: '/srv/work/repo\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await listReviewRepositories(context, 'ssh', {}, git);
    expect(result.workspace).toBe('/srv/work');
    expect(result.repositories[0].root).toBe('/srv/work/repo');
    remote.mockRejectedValue(new Error('SSH disconnected'));
    await expect(listReviewRepositories(context, 'ssh', { refresh: true }, git)).rejects.toThrow(
      'SSH disconnected',
    );
  });
  it('isolates concurrent repository selections and restores the caller context', async () => {
    const ids = ['a'.repeat(64), 'b'.repeat(64)];
    const values = await Promise.all(
      ids.map((repositoryId) =>
        withReviewRepository({ repositoryId }, async () => {
          await Promise.resolve();
          return currentReviewRepositoryId();
        }),
      ),
    );
    expect(values).toEqual(ids);
    expect(currentReviewRepositoryId()).toBeUndefined();
    expect(() => withReviewRepository({ repositoryId: '../repo' }, async () => undefined)).toThrow(
      'INVALID_PARAMS',
    );
  });
});
