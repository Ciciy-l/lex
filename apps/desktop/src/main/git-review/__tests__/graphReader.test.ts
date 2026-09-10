import { describe, expect, it, vi } from 'vitest';
import { parseGitGraphRequest, parseGitGraphCompareRequest } from '../../../shared/gitGraph';
import {
  parseGraphLog,
  readGitGraph,
  withLocalGraphScope,
  readGitGraphComparison,
} from '../graphReader';
import type { ReviewScope } from '../types';

const git = vi.hoisted(() => vi.fn());
vi.mock('../gitRunner.js', async () => ({
  ...(await vi.importActual('../gitRunner.js')),
  runGit: git,
}));
const head = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const remote = 'c'.repeat(40);
const scope: ReviewScope = {
  sessionId: 'lead',
  repoRoot: '/repo',
  workdir: '/repo',
  workingDir: '/repo',
  worktreePath: null,
  branch: 'main',
  headOid: head,
  isDetached: false,
  isUnborn: false,
  source: 'workingDir',
  aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
  disabledReason: null,
  disabledMessage: null,
  resolutionChain: [],
};
const request = { sessionId: 'lead', limit: 100, currentBranch: false, includeRemotes: true };
const record = (oid: string, parents: string[] = []) =>
  [oid, parents.join(' '), '123', 'A 名', 'subject\tvalue', '\n'].join('\0');

describe('Git Graph input boundary', () => {
  it.each([0, -1, 1001, 1.2, '100', Infinity])('rejects invalid limit %s', (limit) => {
    expect(() => parseGitGraphRequest({ ...request, limit })).toThrow();
  });
  it('requires explicit boolean filters and a bounded session', () => {
    expect(() => parseGitGraphRequest({ ...request, currentBranch: 'true' })).toThrow();
    expect(() => parseGitGraphRequest({ ...request, sessionId: 'x'.repeat(129) })).toThrow();
    expect(parseGitGraphRequest({ ...request, cwd: '/evil' })).toEqual(request);
  });
  it('accepts only full fixed commit IDs, never revision expressions', () => {
    const input = {
      sessionId: 'lead',
      fromRef: 'main',
      fromOid: head,
      toRef: 'feature',
      toOid: parent,
    };
    expect(parseGitGraphCompareRequest(input)).toEqual(input);
    for (const fromOid of ['HEAD', '--help', head + '..' + parent, 'a'.repeat(41)])
      expect(() => parseGitGraphCompareRequest({ ...input, fromOid })).toThrow();
    expect(() => parseGitGraphCompareRequest({ ...input, fromRef: 'bad\0ref' })).toThrow();
  });
  it.each([null, { id: 'lead', remoteHostId: 'ssh', workingDir: '/remote', worktreePath: null }])(
    'rejects missing/SSH sessions before scope resolution',
    async (row) => {
      const resolveScope = vi.fn();
      const task = vi.fn();
      await expect(
        withLocalGraphScope('lead', task, {
          getSessionRow: vi.fn().mockResolvedValue(row),
          resolveScope,
        }),
      ).rejects.toThrow('local');
      expect(resolveScope).not.toHaveBeenCalled();
      expect(task).not.toHaveBeenCalled();
    },
  );
  it('uses the authoritative local session scope', async () => {
    const task = vi.fn().mockResolvedValue('done');
    await expect(
      withLocalGraphScope('lead', task, {
        getSessionRow: vi.fn().mockResolvedValue({
          id: 'lead',
          remoteHostId: null,
          workingDir: '/repo',
          worktreePath: null,
        }),
        resolveScope: vi.fn().mockResolvedValue(scope),
      }),
    ).resolves.toBe('done');
    expect(task).toHaveBeenCalledWith(scope);
  });
});

describe('bounded graph reads', () => {
  it('parses roots, merge parents, unicode and tabs without decoration delimiters', () => {
    const result = parseGraphLog(record(head, [parent, remote]) + record(parent));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      oid: head,
      parents: [parent, remote],
      author: 'A 名',
      title: 'subject\tvalue',
    });
    expect(result[1].parents).toEqual([]);
  });
  it('pins roots, peels annotated tags, bounds output and excludes remote-only roots', async () => {
    git.mockReset();
    git.mockImplementation(async (args: string[]) => ({
      stdout:
        args[0] === 'for-each-ref'
          ? [
              'refs/heads/main\0' + head + '\0\0commit\0',
              'refs/tags/v1\0' + remote + '\0' + parent + '\0tag\0commit',
              'refs/remotes/origin/topic\0' + remote + '\0\0commit\0',
            ].join('\n')
          : record(head, [parent]) + record(parent),
    }));
    const data = await readGitGraph(scope, { ...request, limit: 1, includeRemotes: false });
    expect(data.commits).toHaveLength(1);
    expect(data.hasMore).toBe(true);
    expect(data.refs).toContainEqual({ name: 'refs/tags/v1', kind: 'tag', oid: parent });
    expect(git.mock.calls[1][0]).toEqual(
      expect.arrayContaining(['--date-order', '--max-count=2', head, parent, '--']),
    );
    expect(git.mock.calls[1][0]).not.toContain(remote);
    expect(git.mock.calls[1][1]).toMatchObject({
      maxStdoutBytes: 4 * 1024 * 1024,
      timeoutMs: 15000,
    });
    await readGitGraph(scope, { ...request, currentBranch: true });
    expect(git.mock.calls[3][0]).not.toContain(parent);
  });
  it('returns an empty unborn repository without invoking log', async () => {
    git.mockReset().mockResolvedValue({ stdout: '' });
    expect(
      (await readGitGraph({ ...scope, headOid: null, isUnborn: true }, request)).commits,
    ).toEqual([]);
    expect(git).toHaveBeenCalledTimes(1);
  });
  it('rejects excessive refs instead of silently hiding history', async () => {
    git
      .mockReset()
      .mockResolvedValue({ stdout: Array.from({ length: 257 }, () => 'ref').join('\n') });
    await expect(readGitGraph(scope, request)).rejects.toThrow('limit');
  });
  it('compares exact commit trees without a merge-base or mutable ref lookup', async () => {
    git.mockReset().mockImplementation(async (args: string[]) => ({
      stdout: args[0] === 'cat-file' ? 'commit\n' : '',
    }));
    const result = await readGitGraphComparison(scope, {
      sessionId: 'lead',
      fromRef: 'main',
      fromOid: head,
      toRef: 'topic',
      toOid: parent,
    });
    expect(result).toMatchObject({
      fromRef: 'main',
      fromOid: head,
      toRef: 'topic',
      toOid: parent,
      diffs: [],
    });
    expect(
      git.mock.calls.some(([args]) => args.includes('merge-base') || args.includes('rev-parse')),
    ).toBe(false);
    const patchCall = git.mock.calls.find(([args]) => args.includes('--patch-with-raw'));
    expect(patchCall?.[0]).toEqual(
      expect.arrayContaining(['--no-ext-diff', '--no-textconv', head, parent]),
    );
  });
});
