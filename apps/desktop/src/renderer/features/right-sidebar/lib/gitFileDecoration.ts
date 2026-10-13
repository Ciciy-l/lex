import type { FileStatus } from '../../../../shared/gitReviewWire';

export interface GitFileDecoration {
  letter: string;
  color: string;
  deleted: boolean;
  labelKey: string;
}
export function gitFileDecoration(status: string | null | undefined): GitFileDecoration {
  const code =
    status?.length === 1
      ? status
      : (
          {
            added: 'A',
            untracked: '?',
            modified: 'M',
            typechange: 'M',
            deleted: 'D',
            renamed: 'R',
            copied: 'A',
            unmerged: 'U',
          } as Record<string, string>
        )[status ?? ''];
  const kind =
    code === 'A' || code === '?'
      ? 'added'
      : code === 'D'
        ? 'deleted'
        : code === 'U'
          ? 'conflict'
          : code === 'R'
            ? 'renamed'
            : code === 'M'
              ? 'modified'
              : 'clean';
  const color =
    kind === 'added'
      ? 'var(--diff-add-fg)'
      : kind === 'deleted'
        ? 'var(--diff-del-fg)'
        : kind === 'modified'
          ? 'var(--warning-accent)'
          : kind === 'conflict'
            ? 'var(--error-fg)'
            : 'var(--text-secondary)';
  return {
    letter: code ?? '',
    color,
    deleted: code === 'D',
    labelKey: `rightSidebar.gitFiles.${kind}`,
  };
}
export function worktreeFileDecoration(
  file: FileStatus,
  source?: 'staged' | 'unstaged',
): GitFileDecoration {
  return gitFileDecoration(
    file.isUnmerged
      ? 'U'
      : source === 'staged'
        ? file.indexStatus
        : (file.worktreeStatus ?? file.indexStatus),
  );
}
