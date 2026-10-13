import { useEffect, useMemo, useState } from 'react';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import type { ReviewWorkspaceStatus } from '../../../../../shared/gitRepositories';
import { toWorkdirRel } from '../../../../../shared/workdirPath';
import type {
  DirEntry,
  UseFileTreeReturn,
} from '@/features/cc-agent/workdir-browse/hooks/useFileTree';
import { worktreeFileDecoration, type GitFileDecoration } from '../../lib/gitFileDecoration';

export interface WorkspaceDecoration extends GitFileDecoration {
  repositoryId: string;
  gitPath: string;
  source: 'staged' | 'unstaged';
}

export function projectGitDecorations(workdir: string, status: ReviewWorkspaceStatus | null) {
  const result = new Map<string, WorkspaceDecoration>();
  const roots = [...(status?.repositories ?? [])].sort((a, b) => b.root.length - a.root.length);
  for (const snapshot of status?.statuses ?? []) {
    const root = snapshot.scope.repoRoot;
    if (!root) continue;
    for (const file of snapshot.files) {
      const absolute = root.replace(/[\\/]$/, '') + '/' + file.path;
      const rel = toWorkdirRel(workdir, absolute);
      const owner = roots.find((repo) => toWorkdirRel(repo.root, absolute) !== null);
      if (!rel || owner?.id !== snapshot.repositoryId) continue;
      result.set(rel, {
        ...worktreeFileDecoration(file),
        repositoryId: snapshot.repositoryId,
        gitPath: file.path,
        source: file.worktreeStatus ? 'unstaged' : 'staged',
      });
    }
  }
  // Directory state is an aggregate cue; conflicts take priority over ordinary changes.
  for (const [rel, value] of [...result]) {
    let parent = rel;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (!result.has(parent) || value.letter === 'U')
        result.set(parent, { ...value, deleted: false });
    }
  }
  return result;
}

export function useGitFileDecorations(
  sessionId: string,
  deviceId: string | null,
  workdir: string,
  tree: UseFileTreeReturn,
  visible = true,
) {
  const [status, setStatus] = useState<ReviewWorkspaceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let busy = false;
    setStatus(null);
    if (!visible) return;
    const refresh = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const next = await gitReviewApiFor(deviceId).workspaceStatus({ sessionId });
        if (alive) {
          setStatus(next);
          setFailed(next.failedRepositoryIds.length > 0);
        }
      } catch {
        if (alive) {
          setStatus(null);
          setFailed(true);
        }
      } finally {
        busy = false;
      }
    };
    void refresh();
    const onRefresh = () => {
      void refresh();
    };
    const interval = window.setInterval(onRefresh, 15000);
    window.addEventListener('focus', onRefresh);
    window.addEventListener('lex:git-changed', onRefresh);
    window.addEventListener('lex:workspace-file-saved', onRefresh);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener('lex:git-changed', onRefresh);
      window.removeEventListener('lex:workspace-file-saved', onRefresh);
    };
  }, [sessionId, deviceId, workdir, visible]);
  // Git is authoritative: a cached directory listing may still contain a file
  // deleted outside the app. Recreated paths appear as modified/untracked in Git.
  const decorations = useMemo(() => projectGitDecorations(workdir, status), [workdir, status]);
  const overlay = useMemo(
    () => overlayDeletedEntries(tree.entries, decorations),
    [tree.entries, decorations],
  );
  // Even a synthesized parent may still exist on disk; use the normal lazy loader
  // so expanding it also reveals unchanged siblings. Missing-directory reads are
  // harmless and the overlay preserves the deleted children.
  const decoratedTree: UseFileTreeReturn = { ...tree, entries: overlay.entries };
  return { decorations, decoratedTree, failed };
}

export function overlayDeletedEntries(
  base: UseFileTreeReturn['entries'],
  decorations: ReadonlyMap<string, WorkspaceDecoration>,
) {
  const entries = new Map<string, readonly DirEntry[]>(base);
  const virtualDirectories = new Set<string>();
  for (const [rel, value] of decorations) {
    if (!value.deleted || rel.endsWith('.meta')) continue;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const child = parts.slice(0, i + 1).join('/');
      const list = [...(entries.get(parent) ?? [])];
      if (list.some((entry) => entry.relPath === child)) continue;
      const directory = i < parts.length - 1;
      list.push({
        name: parts[i],
        relPath: child,
        type: directory ? 'directory' : 'file',
        size: 0,
        mtimeMs: 0,
      });
      list.sort(
        (a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') ||
          a.name.localeCompare(b.name),
      );
      entries.set(parent, list);
      if (directory) virtualDirectories.add(child);
    }
  }
  return { entries, virtualDirectories };
}
