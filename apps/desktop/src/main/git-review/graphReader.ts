import type {
  GitGraphCommit,
  GitGraphData,
  GitGraphRef,
  GitGraphRequest,
  GitGraphCompareRequest,
  GitGraphComparison,
} from '../../shared/gitGraph.js';
import { runGit } from './gitRunner.js';
import {
  defaultScopeResolverDeps,
  resolveReviewScope,
  withSessionReviewRowSnapshot,
} from './scopeResolver.js';
import { readExplicitTreeDiff } from './branchReader.js';
import type { ReviewScope } from './types.js';

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function withLocalGraphScope<T>(
  sessionId: string,
  task: (scope: ReviewScope) => Promise<T>,
  deps = {
    getSessionRow: defaultScopeResolverDeps().getSessionRow,
    resolveScope: resolveReviewScope,
  },
): Promise<T> {
  const row = await deps.getSessionRow(sessionId);
  if (!row || row.remoteHostId) throw new Error('Git Graph is available for local sessions only');
  return withSessionReviewRowSnapshot(row, async () => {
    const scope = await deps.resolveScope(sessionId);
    if (scope.source === 'remote')
      throw new Error('Git Graph is available for local sessions only');
    return task(scope);
  });
}

export function parseGraphLog(stdout: string): GitGraphCommit[] {
  const fields = stdout.split('\0');
  if (fields.length % 5 !== 1 || fields.at(-1)?.trim())
    throw new Error('Incomplete Git graph output');
  const commits: GitGraphCommit[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const oid = fields[index].trim();
    const parents = fields[index + 1].split(' ').filter(Boolean);
    const authorTime = Number(fields[index + 2]);
    if (
      !oidPattern.test(oid) ||
      parents.some((parent) => !oidPattern.test(parent)) ||
      !Number.isFinite(authorTime)
    )
      throw new Error('Invalid Git graph output');
    commits.push({ oid, parents, authorTime, author: fields[index + 3], title: fields[index + 4] });
  }
  return commits;
}

export async function readGitGraph(
  scope: ReviewScope,
  request: GitGraphRequest,
  git = runGit,
): Promise<GitGraphData> {
  if (scope.disabledReason || !scope.repoRoot)
    return { scope, commits: [], refs: [], hasMore: false };
  const options = { cwd: scope.repoRoot, maxStdoutBytes: 4 * 1024 * 1024, timeoutMs: 15000 };
  const refResult = await git(
    [
      'for-each-ref',
      '--count=257',
      '--sort=refname',
      '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
      'refs/stash',
    ],
    options,
  );
  const lines = refResult.stdout.trim().split('\n').filter(Boolean);
  if (lines.length > 256) throw new Error('Git Graph reference limit exceeded (256)');
  const refs: GitGraphRef[] = lines.flatMap((line) => {
    const [name, objectOid, peeledOid, objectType, peeledType] = line.trim().split('\0');
    const oid = objectType === 'commit' ? objectOid : peeledType === 'commit' ? peeledOid : null;
    if (!oid || !oidPattern.test(oid)) return [];
    const kind = name.startsWith('refs/heads/')
      ? 'local'
      : name.startsWith('refs/remotes/')
        ? 'remote'
        : name.startsWith('refs/tags/')
          ? 'tag'
          : 'stash';
    return [{ name, oid, kind }];
  });
  const roots = [
    ...new Set([
      ...(scope.headOid ? [scope.headOid] : []),
      ...(request.currentBranch
        ? []
        : refs
            .filter((ref) => request.includeRemotes || ref.kind !== 'remote')
            .map((ref) => ref.oid)),
    ]),
  ];
  if (roots.some((oid) => !oidPattern.test(oid))) throw new Error('Invalid HEAD');
  if (!roots.length) return { scope, commits: [], refs, hasMore: false };
  const result = await git(
    [
      'log',
      '--date-order',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%H%x00%P%x00%at%x00%an%x00%s%x00',
      '--max-count=' + (request.limit + 1),
      ...roots,
      '--',
    ],
    options,
  );
  const commits = parseGraphLog(result.stdout);
  return {
    scope,
    refs,
    commits: commits.slice(0, request.limit),
    hasMore: commits.length > request.limit,
  };
}

export async function readGitGraphComparison(
  scope: ReviewScope,
  request: GitGraphCompareRequest,
): Promise<GitGraphComparison> {
  if (!scope.repoRoot || scope.disabledReason) throw new Error('Repository unavailable');
  for (const oid of [request.fromOid, request.toOid]) {
    const result = await runGit(['cat-file', '-t', oid], {
      cwd: scope.repoRoot,
      maxStdoutBytes: 1024,
    });
    if (result.stdout.trim() !== 'commit') throw new Error('Comparison requires commits');
  }
  const result = await readExplicitTreeDiff(scope, request.fromOid, request.toOid);
  return { ...request, diffs: result.diffs, capped: result.capped, warning: result.warning };
}
