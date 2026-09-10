import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, FileDiff, GitBranch, GitFork, RefreshCw } from 'lucide-react';
import { GitControl } from './lib/GitControl';
import { toast } from '@/lib/toast';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import type {
  ReviewCommit,
  ReviewData,
  ReviewHistoryData,
  ReviewDisableReason,
} from '../../../shared/gitReviewWire';
import { openGitReview } from './lib/openGitReview';
import { openGitGraph } from './lib/openGitGraph';
import { createGraphRefreshQueue } from './plugins/git-graph/state';
import { getBucket } from './store';
import type { ReviewState } from './plugins/review';

const disabledReasonKeys = {
  'remote-session': {
    title: 'rightSidebar.review.disabled.remote-session.title',
    desc: 'rightSidebar.review.disabled.remote-session.desc',
  },
  'no-session': {
    title: 'rightSidebar.review.disabled.no-session.title',
    desc: 'rightSidebar.review.disabled.no-session.desc',
  },
  'no-workdir': {
    title: 'rightSidebar.review.disabled.no-workdir.title',
    desc: 'rightSidebar.review.disabled.no-workdir.desc',
  },
  'non-git': {
    title: 'rightSidebar.review.disabled.non-git.title',
    desc: 'rightSidebar.review.disabled.non-git.desc',
  },
  'git-unavailable': {
    title: 'rightSidebar.review.disabled.git-unavailable.title',
    desc: 'rightSidebar.review.disabled.git-unavailable.desc',
  },
  'invalid-worktree': {
    title: 'rightSidebar.review.disabled.invalid-worktree.title',
    desc: 'rightSidebar.review.disabled.invalid-worktree.desc',
  },
  unknown: {
    title: 'rightSidebar.review.disabled.unknown.title',
    desc: 'rightSidebar.review.disabled.unknown.desc',
  },
} satisfies Record<ReviewDisableReason, { title: string; desc: string }>;

export function GitNavigation({
  sessionId,
  deviceId,
}: {
  sessionId: string;
  deviceId: string | null;
}) {
  return (
    <GitNavigationContent
      key={JSON.stringify([sessionId, deviceId])}
      sessionId={sessionId}
      deviceId={deviceId}
    />
  );
}

function GitNavigationContent({
  sessionId,
  deviceId,
}: {
  sessionId: string;
  deviceId: string | null;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<Pick<ReviewData, 'scope' | 'status'> | null>(null);
  const [history, setHistory] = useState<ReviewHistoryData | null>(null);
  const [failed, setFailed] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const queueRef = useRef<ReturnType<typeof createGraphRefreshQueue> | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setHistoryBusy(true);
    const request = ++revision.current;
    await Promise.allSettled([
      (deviceId
        ? gitReviewApiFor(deviceId).get({ sessionId })
        : window.electronAPI.gitReview.navigation({ sessionId })
      )
        .then((result) => {
          if (request === revision.current) {
            setData(result);
            setFailed(false);
          }
        })
        .catch(() => {
          if (request === revision.current) setFailed(true);
        }),
      (deviceId
        ? Promise.reject(new Error('HISTORY_UNAVAILABLE'))
        : window.electronAPI.gitReview.history({ sessionId })
      )
        .then((result) => {
          if (request === revision.current) {
            setHistory(result);
            setHistoryFailed(false);
          }
        })
        .catch(() => {
          if (request === revision.current) setHistoryFailed(true);
        })
        .finally(() => {
          if (request === revision.current) setHistoryBusy(false);
        }),
    ]);
    if (request !== revision.current) return;
    inFlight.current = false;
    setBusy(false);
  }, [sessionId, deviceId]);
  useEffect(() => {
    const queue = createGraphRefreshQueue(refresh);
    queueRef.current = queue;
    queue.request();
    const update = () => {
      if (document.visibilityState !== 'hidden') queue.request();
    };
    const interval = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    window.addEventListener('lex:workspace-file-saved', update);
    window.addEventListener('lex:git-changed', update);
    return () => {
      queue.dispose();
      revision.current++;
      inFlight.current = false;
      clearInterval(interval);
      window.removeEventListener('focus', update);
      window.removeEventListener('lex:workspace-file-saved', update);
      window.removeEventListener('lex:git-changed', update);
    };
  }, [refresh]);
  const navigate = (descriptor: Parameters<typeof openGitReview>[1], path?: string) => {
    void openGitReview(sessionId, descriptor, path).catch(() =>
      toast.error(t('rightSidebar.workbench.loadFailed')),
    );
  };
  const review = getBucket(sessionId).tabs.find((tab) => tab.kind === 'review')?.state as
    ReviewState | undefined;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto text-12"
      aria-label={t('rightSidebar.workbench.git')}
    >
      <div className="border-b border-[var(--border-default)] px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-medium" title={data?.scope.repoRoot || ''}>
            {data?.scope.repoRoot?.split(/[\\/]/).pop() || t('rightSidebar.workbench.git')}
          </span>
          <GitControl
            label={t('rightSidebar.workbench.refresh')}
            iconOnly
            disabled={busy}
            onClick={() => queueRef.current?.request()}
          >
            <RefreshCw size={13} />
          </GitControl>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-11 text-[var(--text-secondary)]">
          <GitBranch size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {data?.scope.branch || (data?.scope.isDetached ? data.scope.headOid?.slice(0, 7) : '')}
          </span>
          {data?.scope.aheadBehind?.upstream && (
            <span className="ml-auto shrink-0" title={data.scope.aheadBehind.upstream}>
              ↑{data.scope.aheadBehind.ahead} ↓{data.scope.aheadBehind.behind}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <GitControl
            label={t('rightSidebar.gitGraph.title')}
            onClick={() =>
              void openGitGraph(sessionId).catch(() =>
                toast.error(t('rightSidebar.workbench.loadFailed')),
              )
            }
          >
            <GitFork size={13} />
            {t('rightSidebar.gitGraph.title')}
          </GitControl>
          <GitControl
            label={t('rightSidebar.tabs.kinds.review')}
            onClick={() => navigate({ kind: 'unstaged' })}
          >
            <FileDiff size={13} />
            {t('rightSidebar.tabs.kinds.review')}
          </GitControl>
        </div>
      </div>
      {failed && (
        <p role="alert" className="px-2">
          {t('rightSidebar.workbench.loadFailed')}
        </p>
      )}
      {data?.scope.disabledReason ? (
        <div className="p-2 text-[var(--text-secondary)]">
          <p>{t(disabledReasonKeys[data.scope.disabledReason].title)}</p>
          <p className="text-11">{t(disabledReasonKeys[data.scope.disabledReason].desc)}</p>
        </div>
      ) : (
        <>
          {(['unstaged', 'staged'] as const).map((source) => {
            const files = data?.status?.files.filter((file) => file.sources.includes(source)) ?? [];
            return (
              <section
                key={source}
                className="relative border-b border-[var(--border-default)] p-2"
              >
                <GitControl
                  className="absolute right-1 top-1"
                  iconOnly
                  label={
                    t(
                      source === 'staged'
                        ? 'rightSidebar.workbench.staged'
                        : 'rightSidebar.workbench.unstaged',
                    ) +
                    ' (' +
                    files.length +
                    ')'
                  }
                  onClick={() => navigate({ kind: source })}
                >
                  <FileDiff size={13} />
                </GitControl>
                <details open>
                  <summary className="cursor-pointer select-none pr-7 font-medium">
                    {t(
                      source === 'staged'
                        ? 'rightSidebar.workbench.staged'
                        : 'rightSidebar.workbench.unstaged',
                    )}{' '}
                    ({files.length})
                  </summary>
                  {files.map((file) => (
                    <button
                      key={file.path}
                      className="block w-full truncate rounded-full px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
                      data-native-title="truncated-text"
                      title={file.path}
                      onClick={() => navigate({ kind: source }, file.path)}
                    >
                      {file.isUntracked ? '? ' : ''}
                      {file.path}
                    </button>
                  ))}
                  {!files.length && !busy && (
                    <p className="px-2 text-11 text-[var(--text-tertiary)]">
                      {t('rightSidebar.workbench.noChanges')}
                    </p>
                  )}
                </details>
              </section>
            );
          })}
          <div
            className="border-b border-[var(--border-default)] px-1 py-1"
            title={t('rightSidebar.workbench.comparisonHint')}
          >
            <GitControl
              label={t('rightSidebar.workbench.comparison')}
              onClick={() => navigate({ kind: 'branch', baseRef: review?.branchBaseRef || null })}
            >
              <ArrowLeftRight size={13} />
              {t('rightSidebar.workbench.comparison')}
              {review?.branchBaseRef ? ': ' + review.branchBaseRef : ''}
            </GitControl>
            <span className="sr-only">{t('rightSidebar.workbench.comparisonHint')}</span>
          </div>
          <details open className="p-2">
            <summary className="cursor-pointer select-none font-medium">
              {t('rightSidebar.workbench.recentHistory')}
            </summary>
            {historyBusy && !history && (
              <p role="status" className="text-11 text-[var(--text-secondary)]">
                {t('rightSidebar.workbench.historyLoading')}
              </p>
            )}
            {historyFailed && (
              <p className="text-11 text-[var(--text-secondary)]">
                {t('rightSidebar.workbench.historyUnavailable')}
              </p>
            )}
            {history?.commits.map((commit) => (
              <CommitFiles
                key={commit.oid}
                commit={commit}
                sessionId={sessionId}
                deviceId={deviceId}
              />
            ))}
            {history && !history.commits.length && (
              <p className="text-11">{t('rightSidebar.workbench.noCommits')}</p>
            )}
            {history?.truncated && (
              <p className="text-11 text-[var(--text-tertiary)]">
                {t('rightSidebar.workbench.historyLimit')}
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}

function CommitFiles({
  commit,
  sessionId,
  deviceId,
}: {
  commit: ReviewCommit;
  sessionId: string;
  deviceId: string | null;
}) {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || paths) return;
    let alive = true;
    void gitReviewApiFor(deviceId)
      .commitDiff({ sessionId, oid: commit.oid })
      .then((result) => {
        if (alive) {
          setPaths([
            ...new Set([
              ...result.diffs.map((diff) => diff.path),
              ...(result.capped?.files.map((entry) => entry.path) ?? []),
            ]),
          ]);
          setError(false);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [open, paths, sessionId, deviceId, commit.oid]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        className="cursor-pointer select-none truncate py-1"
        title={commit.title + '\n' + commit.oid}
      >
        {commit.title}
      </summary>
      {error && <span className="text-11">{t('rightSidebar.workbench.loadFailed')}</span>}
      {paths?.map((path) => (
        <button
          className="block w-full truncate rounded-full py-1 pl-3 text-left hover:bg-[var(--surface-hover)]"
          key={path}
          data-native-title="truncated-text"
          title={path}
          onClick={() =>
            void openGitReview(sessionId, { kind: 'commit', commitOid: commit.oid }, path).catch(
              () => toast.error(t('rightSidebar.workbench.loadFailed')),
            )
          }
        >
          {path}
        </button>
      ))}
    </details>
  );
}
