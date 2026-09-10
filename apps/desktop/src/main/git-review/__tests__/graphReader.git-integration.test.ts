import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { runGit } from '../gitRunner';
import { readGitGraph, readGitGraphComparison } from '../graphReader';
import { readBranchDiff } from '../branchReader';
import type { ReviewScope } from '../types';
import { graphLanes } from '../../../renderer/features/right-sidebar/plugins/git-graph/state';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });
const copies: string[] = [];
const template = new TestDirectoryTemplate('lex-git-graph-', async (cwd) => {
  await runGit(['init', '-b', 'main'], { cwd });
  await runGit(['config', 'user.name', 'Graph Test'], { cwd });
  await runGit(['config', 'user.email', 'graph@example.test'], { cwd });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd });
  await fs.writeFile(path.join(cwd, 'root.txt'), 'root\n');
  await runGit(['add', '.'], { cwd });
  await runGit(['commit', '-m', 'Root 名'], { cwd });
  await runGit(['branch', 'feature'], { cwd });
  await fs.writeFile(path.join(cwd, 'main.txt'), 'main\n');
  await runGit(['add', '.'], { cwd });
  await runGit(['commit', '-m', 'Main'], { cwd });
  await runGit(['tag', '-a', 'v1', '-m', 'tag'], { cwd });
  await runGit(['checkout', 'feature'], { cwd });
  await fs.writeFile(path.join(cwd, 'feature.txt'), 'feature\n');
  await runGit(['add', '.'], { cwd });
  await runGit(['commit', '-m', 'Feature'], { cwd });
});
afterEach(async () => {
  for (const cwd of copies.splice(0))
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
afterAll(() => template.dispose());
async function fixture() {
  const cwd = await template.createCopy();
  copies.push(cwd);
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const base = (await runGit(['rev-parse', 'main'], { cwd })).stdout.trim();
  const scope: ReviewScope = {
    sessionId: 'lead',
    repoRoot: cwd,
    workdir: cwd,
    workingDir: cwd,
    worktreePath: null,
    branch: 'feature',
    headOid: head,
    isDetached: false,
    isUnborn: false,
    source: 'workingDir',
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
  return { cwd, head, base, scope };
}

it('reads a stable topological prefix and annotated refs using real Git', async () => {
  const { scope, head, base } = await fixture();
  const request = { sessionId: 'lead', limit: 1, currentBranch: false, includeRemotes: true };
  const first = await readGitGraph(scope, request);
  const more = await readGitGraph(scope, { ...request, limit: 100 });
  expect(first.hasMore).toBe(true);
  expect(more.commits.slice(0, 1)).toEqual(first.commits);
  expect(more.commits).toHaveLength(3);
  expect(more.refs).toContainEqual({ name: 'refs/tags/v1', oid: base, kind: 'tag' });
  const current = await readGitGraph(scope, { ...request, limit: 100, currentBranch: true });
  expect(current.commits.map((commit) => commit.oid)).toContain(head);
  expect(current.commits.map((commit) => commit.oid)).not.toContain(base);
  expect(current.commits[1].title).toBe('Root 名');
});

it('keeps exact two-tree comparison distinct from existing merge-base comparison', async () => {
  const { scope, head, base } = await fixture();
  const exact = await readGitGraphComparison(scope, {
    sessionId: 'lead',
    fromRef: 'main',
    fromOid: base,
    toRef: 'feature',
    toOid: head,
  });
  expect(exact.diffs.map((diff) => [diff.path, diff.status])).toEqual([
    ['feature.txt', 'added'],
    ['main.txt', 'deleted'],
  ]);
  const branch = await readBranchDiff(scope, 'main');
  expect(branch.mergeBaseOid).not.toBe(base);
  expect(branch.diffs.map((diff) => diff.path)).toEqual(['feature.txt']);
  const reverse = await readGitGraphComparison(scope, {
    sessionId: 'lead',
    fromRef: 'feature',
    fromOid: head,
    toRef: 'main',
    toOid: base,
  });
  expect(reverse.diffs.map((diff) => [diff.path, diff.status])).toEqual([
    ['feature.txt', 'deleted'],
    ['main.txt', 'added'],
  ]);
});

it('interleaves repeated branch merges without accumulating delayed parent lanes', async () => {
  const { cwd, scope } = await fixture();
  const tree = (await runGit(['rev-parse', 'HEAD^{tree}'], { cwd })).stdout.trim();
  let clock = 0;
  const createCommit = async (parents: string[], title: string) => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, ++clock)).toISOString();
    return (
      await runGit(
        ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', title],
        { cwd, extraEnv: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
      )
    ).stdout.trim();
  };
  let main = await createCommit([], 'base');
  let feature = main;
  const expected = new Set([main]);
  for (let index = 0; index < 10; index++) {
    feature = await createCommit([feature], 'feature ' + index);
    main = await createCommit([main, feature], 'merge ' + index);
    expected.add(feature);
    expected.add(main);
  }
  const request = { sessionId: 'lead', limit: 100, currentBranch: true, includeRemotes: false };
  const data = await readGitGraph({ ...scope, headOid: main }, request);
  expect(new Set(data.commits.map((commit) => commit.oid))).toEqual(expected);
  expect(Math.max(...graphLanes(data.commits).map((row) => row.width))).toBe(2);
  expect(data.commits.filter((commit) => commit.parents.length === 2)).toHaveLength(10);
  const indices = new Map(data.commits.map((commit, index) => [commit.oid, index]));
  for (const commit of data.commits)
    for (const parent of commit.parents)
      expect(indices.get(parent)).toBeGreaterThan(indices.get(commit.oid)!);
  const prefix = await readGitGraph({ ...scope, headOid: main }, { ...request, limit: 7 });
  expect(prefix.commits).toEqual(data.commits.slice(0, 7));
  expect(data.commits.map((commit) => commit.title)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => [
      'merge ' + (9 - index),
      'feature ' + (9 - index),
    ]).flat(),
    'base',
  ]);
});
