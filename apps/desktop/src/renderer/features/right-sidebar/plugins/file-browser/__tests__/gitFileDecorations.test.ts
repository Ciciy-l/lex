import { expect, it } from 'vitest';
import { projectGitDecorations, overlayDeletedEntries } from '../useGitFileDecorations';
import { gitFileDecoration } from '../../../lib/gitFileDecoration';
import type { ReviewWorkspaceStatus } from '../../../../../../shared/gitRepositories';
import type { DirEntry } from '@/features/cc-agent/workdir-browse/hooks/useFileTree';

it('projects sibling repositories onto the workspace tree and lets the nearest nested repository own each file', () => {
  // These are POSIX paths from an SSH host, independent of the test runner OS.
  const status = {
    repositories: [
      { id: 'a', root: '/work/a' },
      { id: 'b', root: '/work/b' },
      { id: 'nested', root: '/work/a/nested' },
    ],
    statuses: [
      {
        repositoryId: 'a',
        scope: { repoRoot: '/work/a' },
        files: [
          { path: 'src/gone.ts', indexStatus: null, worktreeStatus: 'deleted' },
          { path: 'nested/change.ts', worktreeStatus: 'modified' },
        ],
      },
      {
        repositoryId: 'b',
        scope: { repoRoot: '/work/b' },
        files: [{ path: 'added.ts', worktreeStatus: 'untracked', indexStatus: null }],
      },
      {
        repositoryId: 'nested',
        scope: { repoRoot: '/work/a/nested' },
        files: [{ path: 'change.ts', isUnmerged: true, worktreeStatus: 'modified' }],
      },
    ],
  } as unknown as ReviewWorkspaceStatus;
  const values = projectGitDecorations('/work', status);
  expect(values.get('a/src/gone.ts')).toMatchObject({
    repositoryId: 'a',
    gitPath: 'src/gone.ts',
    deleted: true,
    source: 'unstaged',
    letter: 'D',
  });
  expect(values.get('b/added.ts')).toMatchObject({ letter: '?', deleted: false });
  expect(values.get('a/nested/change.ts')).toMatchObject({ repositoryId: 'nested', letter: 'U' });
  expect(values.get('a')).toMatchObject({ letter: 'U', deleted: false });
  expect(projectGitDecorations('/unrelated', status).size).toBe(0);
  const existing: DirEntry = {
    name: 'kept.ts',
    relPath: 'a/src/kept.ts',
    type: 'file',
    size: 4,
    mtimeMs: 0,
  };
  const base = new Map([['a/src', [existing]]]);
  const tree = overlayDeletedEntries(base, values);
  expect(tree.entries.get('')?.map((entry) => entry.relPath)).toEqual(['a']);
  expect(tree.entries.get('a/src')?.map((entry) => entry.relPath)).toEqual([
    'a/src/gone.ts',
    'a/src/kept.ts',
  ]);
  expect(base.get('a/src')).toEqual([existing]);
});
it('provides semantic colors and text markers so color is not the only status cue', () => {
  const added = gitFileDecoration('added');
  const modified = gitFileDecoration('M');
  const deleted = gitFileDecoration('deleted');
  expect(new Set([added.color, modified.color, deleted.color]).size).toBe(3);
  expect([added.letter, modified.letter, deleted.letter]).toEqual(['A', 'M', 'D']);
  expect(gitFileDecoration('renamed')).toMatchObject({ letter: 'R', deleted: false });
  expect(deleted.deleted).toBe(true);
});
