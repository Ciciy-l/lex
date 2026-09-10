import { beforeEach, describe, expect, it, vi } from 'vitest';

const runGitMock = vi.hoisted(() => vi.fn());

vi.mock('../gitRunner.js', async () => {
  const actual = await vi.importActual<typeof import('../gitRunner.js')>('../gitRunner.js');
  return {
    ...actual,
    runGit: runGitMock,
  };
});

import { listBranchBaseCandidates, readBranchDiff } from '../branchReader';
import {
  listBranchCommits,
  listCommitFiles,
  listRepositoryHistory,
  readCommitDiff,
} from '../commitReader';
import { GitRunError } from '../gitRunner';
import type { ReviewScope } from '../types';

const baseOid = 'a'.repeat(40);
const headOid = 'b'.repeat(40);
const mergeBaseOid = 'c'.repeat(40);
const commitOid = 'd'.repeat(40);
const parentOid = 'e'.repeat(40);

describe('bounded repository history', () => {
  it('uses a fixed HEAD with a 51-record bound and no comparison branch lookup', async () => {
    runGitMock.mockReset();
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: headOid + '\n' };
      if (args[0] === 'log')
        return {
          stdout: Array.from(
            { length: 51 },
            (_, i) =>
              i.toString(16).padStart(40, '0') + '\0' + '2026-09-07T12:00:00Z' + '\0commit ' + i,
          ).join('\n'),
        };
      throw new Error('unexpected git operation');
    });
    const result = await listRepositoryHistory(scope());
    expect(result.headOid).toBe(headOid);
    expect(result.commits).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(runGitMock).toHaveBeenCalledTimes(2);
    expect(runGitMock).toHaveBeenLastCalledWith(
      expect.arrayContaining(['--max-count=51', headOid, '--']),
      expect.objectContaining({ maxStdoutBytes: 1024 * 1024 }),
    );
  });
  it('returns an empty unborn/disabled history without invoking log', async () => {
    runGitMock.mockReset();
    runGitMock.mockRejectedValue(new Error('unborn'));
    expect((await listRepositoryHistory(scope())).commits).toEqual([]);
    expect(runGitMock).toHaveBeenCalledTimes(1);
    runGitMock.mockClear();
    expect(
      (await listRepositoryHistory({ ...scope(), disabledReason: 'non-git', repoRoot: null }))
        .commits,
    ).toEqual([]);
    expect(runGitMock).not.toHaveBeenCalled();
  });
});

function scope(): ReviewScope {
  return {
    sessionId: 's1',
    workdir: '/repo',
    worktreePath: '/repo',
    workingDir: '/repo',
    repoRoot: '/repo',
    branch: 'feature',
    headOid: null,
    isDetached: false,
    isUnborn: false,
    source: 'worktree',
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
}

function forEachRefRecord(fullRef: string, shortRef: string, oid: string): string {
  return `${fullRef}\x1f${shortRef}\x1f${oid}\0`;
}

beforeEach(() => {
  runGitMock.mockReset();
});

describe('git-review reader git stdout limits', () => {
  it('guards branch name-status reads with the summary stdout limit', async () => {
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'config') throw new Error('no config');
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('no upstream');
      if (args[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '', exitCode: 0 };
      if (args[0] === 'check-ref-format') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && String(args.at(-1)).startsWith('origin/main'))
        return { stdout: `${baseOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && String(args.at(-1)).startsWith('HEAD'))
        return { stdout: `${headOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'for-each-ref') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'merge-base' && args.length === 3)
        return { stdout: `${mergeBaseOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'diff' && args.includes('--name-status'))
        return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'diff' && (args.includes('--numstat') || args.includes('--patch-with-raw')))
        return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    await readBranchDiff(scope(), null);

    const nameStatusCall = runGitMock.mock.calls.find(
      ([args]) =>
        (args as readonly string[])[0] === 'diff' &&
        (args as readonly string[]).includes('--name-status'),
    );
    expect(nameStatusCall?.[1]).toMatchObject({
      cwd: '/repo',
      maxStdoutBytes: 32 * 1024 * 1024,
    });
  });

  it('guards branch commit log reads with the summary stdout limit', async () => {
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'config') throw new Error('no config');
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('no upstream');
      if (args[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '', exitCode: 0 };
      if (args[0] === 'check-ref-format') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && String(args.at(-1)).startsWith('origin/main'))
        return { stdout: `${baseOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && String(args.at(-1)).startsWith('HEAD'))
        return { stdout: `${headOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'for-each-ref') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'log') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    await listBranchCommits(scope(), null);

    const logCall = runGitMock.mock.calls.find(
      ([args]) => (args as readonly string[])[0] === 'log',
    );
    expect(logCall?.[1]).toMatchObject({
      cwd: '/repo',
      maxStdoutBytes: 32 * 1024 * 1024,
    });
  });

  it('guards commit name-status reads with the summary stdout limit', async () => {
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'rev-parse') return { stdout: `${commitOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'rev-list')
        return { stdout: `${commitOid} ${parentOid}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'diff-tree' && args.includes('--name-status'))
        return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'diff' && (args.includes('--numstat') || args.includes('--patch-with-raw')))
        return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    await readCommitDiff(scope(), commitOid);

    const nameStatusCall = runGitMock.mock.calls.find(
      ([args]) =>
        (args as readonly string[])[0] === 'diff-tree' &&
        (args as readonly string[]).includes('--name-status'),
    );
    expect(nameStatusCall?.[1]).toMatchObject({
      cwd: '/repo',
      maxStdoutBytes: 32 * 1024 * 1024,
    });
  });

  it('uses one small no-rename name-only read for recent-commit paths', async () => {
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'diff-tree' && args.includes('--name-only')) {
        return { stdout: 'new.ts\0a.ts\0', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    await expect(listCommitFiles(scope(), commitOid)).resolves.toEqual({
      commitOid,
      paths: ['a.ts', 'new.ts'],
    });
    expect(runGitMock).toHaveBeenCalledTimes(1);
    expect(runGitMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'diff-tree',
        '--name-only',
        '--no-renames',
        '--no-ext-diff',
        `${commitOid}^{commit}^1`,
        `${commitOid}^{commit}`,
      ]),
      expect.objectContaining({ cwd: '/repo', maxStdoutBytes: 4 * 1024 * 1024 }),
    );
    expect(runGitMock.mock.calls[0]?.[0]).not.toContain('--diff-merges=first-parent');
    expect(runGitMock.mock.calls[0]?.[0]).not.toContain('--first-parent');
    expect(runGitMock.mock.calls[0]?.[0]).not.toContain('-M');
  });

  it.each([
    new GitRunError({
      args: ['diff-tree', `${commitOid}^{commit}^1`, `${commitOid}^{commit}`],
      cwd: '/repo',
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'git diff-tree timed out',
    }),
    new GitRunError({
      args: ['diff-tree', `${commitOid}^{commit}^1`, `${commitOid}^{commit}`],
      cwd: '/repo',
      exitCode: 128,
      stdout: '',
      stderr: `error: ${commitOid}^{commit}: expected commit type, but the object dereferences to tree type`,
    }),
  ])('does not retry non-root commit-path failures as a root diff', async (failure) => {
    runGitMock.mockRejectedValue(failure);

    await expect(listCommitFiles(scope(), commitOid)).rejects.toBe(failure);
    expect(runGitMock).toHaveBeenCalledTimes(1);
  });
});

describe('git-review branch stale-risk checks', () => {
  it('limits stale-risk ancestor checks to the branch reader IO concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const records = Array.from({ length: 20 }, (_, index) => {
      const local = `topic-${index}`;
      return [
        forEachRefRecord(`refs/heads/${local}`, local, `${index.toString(16).padStart(39, '0')}1`),
        forEachRefRecord(
          `refs/remotes/origin/${local}`,
          `origin/${local}`,
          `${index.toString(16).padStart(39, '0')}2`,
        ),
      ].join('');
    }).join('');

    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'config') throw new Error('no config');
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('no upstream');
      if (args[0] === 'symbolic-ref') throw new Error('no remote default');
      if (args[0] === 'check-ref-format') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'for-each-ref') return { stdout: records, stderr: '', exitCode: 0 };
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const candidates = await listBranchBaseCandidates(scope());

    expect(candidates.filter((candidate) => candidate.isStaleRisk)).toHaveLength(20);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });
});
