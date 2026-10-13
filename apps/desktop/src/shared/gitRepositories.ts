import type { FileStatus, ReviewScope } from './gitReviewWire';

export interface ReviewRepository {
  id: string;
  root: string;
  relativePath: string;
  name: string;
}
export interface ReviewRepositoryList {
  repositories: ReviewRepository[];
  defaultRepositoryId: string | null;
  workspace: string | null;
  partial: boolean;
}
export interface ReviewRepositoryRequest {
  sessionId: string;
  refresh?: boolean;
  /** Explicitly add a directory beneath the authoritative workspace. */
  relativePath?: string;
}
export interface ReviewWorkspaceStatus extends ReviewRepositoryList {
  statuses: Array<{ repositoryId: string; scope: ReviewScope; files: FileStatus[] }>;
  failedRepositoryIds: string[];
}
