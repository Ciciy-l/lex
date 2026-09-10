import type { ReviewBranchDiffData, ReviewScope } from './gitReviewWire';

export interface GitGraphCommit {
  oid: string;
  parents: string[];
  title: string;
  author: string;
  authorTime: number;
}

export interface GitGraphRef {
  name: string;
  oid: string;
  kind: 'local' | 'remote' | 'tag' | 'stash';
}

export interface GitGraphRequest {
  sessionId: string;
  limit: number;
  currentBranch: boolean;
  includeRemotes: boolean;
}

export interface GitGraphData {
  scope: ReviewScope;
  commits: GitGraphCommit[];
  refs: GitGraphRef[];
  hasMore: boolean;
}

export interface GitGraphCompareRequest {
  sessionId: string;
  fromRef: string;
  fromOid: string;
  toRef: string;
  toOid: string;
}

export interface GitGraphComparison extends GitGraphCompareRequest {
  diffs: ReviewBranchDiffData['diffs'];
  capped: ReviewBranchDiffData['capped'];
  warning: ReviewBranchDiffData['warning'];
}

export function parseGitGraphRequest(value: unknown): GitGraphRequest {
  const request = value as Partial<GitGraphRequest> | null;
  if (
    !request ||
    typeof request.sessionId !== 'string' ||
    !request.sessionId.trim() ||
    request.sessionId.length > 128 ||
    !Number.isInteger(request.limit) ||
    request.limit! < 1 ||
    request.limit! > 1000 ||
    typeof request.currentBranch !== 'boolean' ||
    typeof request.includeRemotes !== 'boolean'
  ) {
    throw new Error('Invalid Git Graph request');
  }
  return {
    sessionId: request.sessionId,
    limit: request.limit!,
    currentBranch: request.currentBranch,
    includeRemotes: request.includeRemotes,
  };
}

export function parseGitGraphCompareRequest(value: unknown): GitGraphCompareRequest {
  const request = value as Partial<GitGraphCompareRequest> | null;
  if (
    !request ||
    typeof request.sessionId !== 'string' ||
    !request.sessionId.trim() ||
    request.sessionId.length > 128 ||
    ![request.fromOid, request.toOid].every(
      (oid) => typeof oid === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid),
    ) ||
    ![request.fromRef, request.toRef].every(
      (ref) =>
        typeof ref === 'string' &&
        ref.length > 0 &&
        ref.length <= 1024 &&
        !Array.from(ref).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  ) {
    throw new Error('Invalid Git Graph comparison');
  }
  return {
    sessionId: request.sessionId,
    fromRef: request.fromRef!,
    fromOid: request.fromOid!,
    toRef: request.toRef!,
    toOid: request.toOid!,
  };
}
