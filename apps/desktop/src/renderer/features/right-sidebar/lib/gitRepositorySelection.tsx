import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import type { ReviewRepositoryList } from '../../../../shared/gitRepositories';
import { getBucket, patchTabState, subscribe } from '../store';

export const GitRepositoryContext = createContext<string | undefined>(undefined);
export const useGitRepositoryId = () => useContext(GitRepositoryContext);
const selected = new Map<string, string>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribeSelection = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function rememberGitRepositorySelection(
  sessionId: string,
  deviceId: string | null,
  repositoryId: string,
) {
  selected.set(JSON.stringify([deviceId, sessionId]), repositoryId);
  if (selected.size > 200) selected.delete(selected.keys().next().value!);
  emit();
}

export function useGitRepositorySelection(
  sessionId: string,
  deviceId: string | null | undefined,
  contextKey = '',
) {
  const key = JSON.stringify([deviceId, sessionId]);
  const bucket = useSyncExternalStore(subscribe, () => getBucket(sessionId));
  const review = bucket.tabs.find((tab) => tab.kind === 'review');
  const persisted = (review?.state as { repositoryId?: string } | undefined)?.repositoryId;
  const remembered = useSyncExternalStore(subscribeSelection, () => selected.get(key));
  const chosen = persisted ?? remembered;
  const [result, setResult] = useState<{ key: string; catalog: ReviewRepositoryList } | null>(null);
  const requestKey = JSON.stringify([key, contextKey]);
  const catalog = result?.key === requestKey ? result.catalog : null;
  const [failed, setFailed] = useState(false);
  const [legacy, setLegacy] = useState(false);
  // Navigation and content can be mounted separately, but refresh one catalog.
  const version = useSyncExternalStore(subscribeSelection, () => revisions.get(key) ?? 0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setLegacy(false);
    if (deviceId === undefined) return;
    void gitReviewApiFor(deviceId)
      .repositories({ sessionId, refresh: version > 0 })
      .then((value) => {
        if (alive) setResult({ key: requestKey, catalog: value });
      })
      .catch((error) => {
        if (!alive) return;
        const message = String(error);
        if (deviceId && /unknown op: repositories|DEVICE_LINK_CHANNEL_NOT_ALLOWED/.test(message))
          setLegacy(true);
        else setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, deviceId, version, requestKey]);
  const repositoryId = catalog?.repositories.some((repo) => repo.id === chosen)
    ? chosen
    : (catalog?.defaultRepositoryId ?? undefined);
  const select = async (id: string) => {
    if (!catalog?.repositories.some((repo) => repo.id === id)) return;
    const tab = getBucket(sessionId).tabs.find((item) => item.kind === 'review');
    if (tab)
      await patchTabState(sessionId, tab.id, {
        repositoryId: id,
        historyCommitOid: null,
        branchBaseRef: null,
        descriptor: { kind: 'unstaged' },
        jumpTarget: null,
      });
    rememberGitRepositorySelection(sessionId, deviceId ?? null, id);
  };
  return {
    catalog,
    repositoryId,
    select,
    ready: catalog !== null || legacy,
    legacy,
    failed,
    refresh: () => {
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      if (revisions.size > 200) revisions.delete(revisions.keys().next().value!);
      emit();
    },
  };
}
