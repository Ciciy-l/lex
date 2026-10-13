import { useGitRepositorySelection } from './lib/gitRepositorySelection';
import { gitFileDecoration, worktreeFileDecoration } from './lib/gitFileDecoration';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
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
import { openGitGraph, openGitWorkspaceView } from './lib/openGitGraph';
import { resolveGitWorkspaceView } from './lib/gitWorkspaceView';
import { createGraphRefreshQueue } from './plugins/git-graph/state';
import { getBucket } from './store';
import type { ReviewState } from './plugins/review';
import './git-navigation.css';

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
  remoteHostId = null,
  workdir = '',
}: {
  sessionId: string;
  deviceId: string | null;
  remoteHostId?: string | null;
  workdir?: string;
}) {
  const selection = useGitRepositorySelection(
    sessionId,
    deviceId,
    JSON.stringify([workdir, remoteHostId]),
  );
  const { t } = useTranslation();
  if (!selection.ready)
    return (
      <div role="status" className="flex flex-col gap-2 p-2 text-12">
        <p>
          {t(
            selection.failed
              ? 'rightSidebar.workbench.loadFailed'
              : 'rightSidebar.workbench.gitLoading',
          )}
        </p>
        {selection.failed && (
          <GitControl label={t('rightSidebar.workbench.refresh')} onClick={selection.refresh}>
            {t('rightSidebar.workbench.refresh')}
          </GitControl>
        )}
      </div>
    );
  return (
    <GitNavigationContent
      key={JSON.stringify([sessionId, deviceId, remoteHostId, selection.repositoryId])}
      selection={selection}
      sessionId={sessionId}
      deviceId={deviceId}
      remoteHostId={remoteHostId}
    />
  );
}

function GitNavigationContent({
  selection,
  sessionId,
  deviceId,
  remoteHostId,
}: {
  sessionId: string;
  deviceId: string | null;
  remoteHostId: string | null;
  selection: ReturnType<typeof useGitRepositorySelection>;
}) {
  const { t } = useTranslation();
  const repositoryId = selection.repositoryId;
  const [directory, setDirectory] = useState('');
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
      (selection.legacy
        ? gitReviewApiFor(deviceId).get({ sessionId })
        : gitReviewApiFor(deviceId).navigation({ sessionId, repositoryId })
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
      (selection.legacy
        ? Promise.reject(new Error('HISTORY_UNAVAILABLE'))
        : gitReviewApiFor(deviceId).history({ sessionId, repositoryId })
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
  }, [sessionId, deviceId, repositoryId, selection.legacy]);
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
    void openGitReview(sessionId, descriptor, path, repositoryId).catch(() =>
      toast.error(t('rightSidebar.workbench.loadFailed')),
    );
  };
  const reviewTab = getBucket(sessionId).tabs.find((tab) => tab.kind === 'review');
  const review = reviewTab?.state as Partial<ReviewState> | undefined;
  // Legacy review state has no activeView and must remain a Review surface;
  // no tab yet means the next Git action will create a Graph-first workspace.
  const storedActiveView = resolveGitWorkspaceView(reviewTab?.state);
  // Older controlled devices retain Review until they support repository-aware Graph.
  const canOpenGraph = !selection.legacy;
  // The workspace body also falls back to Review for older hosts. Keep
  // the navigator's pressed state aligned with that effective visible view.
  const activeView = canOpenGraph && storedActiveView === 'graph' ? 'graph' : 'review';
  // Keep a known-empty snapshot visible while the next status read is in flight.
  // Removing it for `busy` collapses both status sections every auto-refresh.
  const hasStatusSnapshot = data?.status != null;
  return (
    <section
      className="lex-git-navigation flex min-h-0 flex-1 flex-col overflow-y-auto text-12"
      aria-label={t('rightSidebar.workbench.git')}
    >
      <div className="border-b border-[var(--border-default)] px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {selection.catalog?.repositories.length ? (
            <Select
              label={t('rightSidebar.repositories.title')}
              value={repositoryId ?? ''}
              className="h-8 flex-1 text-12"
              options={selection.catalog.repositories.map((repo) => ({
                value: repo.id,
                label: repo.name + ' · ' + repo.relativePath,
              }))}
              onValueChange={(id) => {
                void selection
                  .select(id)
                  .catch(() => toast.error(t('rightSidebar.workbench.loadFailed')));
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium">
              {t('rightSidebar.workbench.git')}
            </span>
          )}
          <GitControl
            label={t('rightSidebar.workbench.refresh')}
            iconOnly
            disabled={busy}
            onClick={() => {
              selection.refresh();
              queueRef.current?.request();
            }}
          >
            <RefreshCw size={13} />
          </GitControl>
        </div>
        <div className="flex min-w-0 items-center gap-0.5 text-11 text-[var(--text-secondary)]">
          <GitBranch size={12} className="shrink-0" aria-hidden="true" />
          <span className="lex-git-navigation-branch-name min-w-0 shrink truncate">
            {data?.scope.branch || (data?.scope.isDetached ? data.scope.headOid?.slice(0, 7) : '')}
          </span>
          <div
            className="flex shrink-0 items-center gap-px"
            role="group"
            aria-label={t('rightSidebar.workbench.git')}
          >
            {canOpenGraph && (
              <GitControl
                className={
                  'lex-git-navigation-mode-control ' +
                  (activeView === 'graph'
                    ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                    : '')
                }
                label={t('rightSidebar.gitGraph.title')}
                size="compact"
                aria-pressed={activeView === 'graph'}
                onClick={() =>
                  void openGitGraph(sessionId).catch(() =>
                    toast.error(t('rightSidebar.workbench.loadFailed')),
                  )
                }
              >
                <GitFork size={11} />
                <span className="lex-git-navigation-mode-label">
                  {t('rightSidebar.gitGraph.title')}
                </span>
              </GitControl>
            )}
            <GitControl
              className={
                'lex-git-navigation-mode-control ' +
                (activeView === 'review'
                  ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                  : '')
              }
              label={t('rightSidebar.tabs.kinds.review')}
              size="compact"
              aria-pressed={activeView === 'review'}
              onClick={() =>
                void openGitWorkspaceView(sessionId, 'review').catch(() =>
                  toast.error(t('rightSidebar.workbench.loadFailed')),
                )
              }
            >
              <FileDiff size={11} />
              <span className="lex-git-navigation-mode-label">
                {t('rightSidebar.tabs.kinds.review')}
              </span>
            </GitControl>
          </div>
          {data?.scope.aheadBehind?.upstream && (
            <span
              className="ml-auto shrink-0 whitespace-nowrap"
              title={data.scope.aheadBehind.upstream}
            >
              ↑{data.scope.aheadBehind.ahead} ↓{data.scope.aheadBehind.behind}
            </span>
          )}
        </div>
      </div>
      {selection.legacy && (
        <p className="px-2 text-11 text-[var(--text-secondary)]">
          {t('rightSidebar.repositories.legacy')}
        </p>
      )}
      {selection.catalog?.partial && (
        <p className="px-2 text-11 text-[var(--text-secondary)]">
          {t('rightSidebar.repositories.partial')}
        </p>
      )}
      {!selection.legacy && (
        <details className="px-2 py-1 text-11">
          <summary>{t('rightSidebar.repositories.add')}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void gitReviewApiFor(deviceId)
                .repositories({ sessionId, relativePath: directory })
                .then(() => {
                  setDirectory('');
                  selection.refresh();
                })
                .catch(() => toast.error(t('rightSidebar.workbench.loadFailed')));
            }}
            className="flex gap-1 py-1"
          >
            <Input
              aria-label={t('rightSidebar.repositories.relativePath')}
              placeholder={t('rightSidebar.repositories.relativePath')}
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
            <GitControl label={t('rightSidebar.repositories.add')} type="submit">
              +
            </GitControl>
          </form>
        </details>
      )}
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
                      title={file.path + ' · ' + t(worktreeFileDecoration(file, source).labelKey)}
                      style={{ color: worktreeFileDecoration(file, source).color }}
                      onClick={() => navigate({ kind: source }, file.path)}
                    >
                      {worktreeFileDecoration(file, source).letter} {file.path}
                    </button>
                  ))}
                  {!files.length && hasStatusSnapshot && (
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
                key={(repositoryId ?? 'default') + ':' + commit.oid}
                commit={commit}
                repositoryId={repositoryId}
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
  repositoryId,
  commit,
  sessionId,
  deviceId,
}: {
  repositoryId?: string;
  commit: ReviewCommit;
  sessionId: string;
  deviceId: string | null;
}) {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<string[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || paths) return;
    let alive = true;
    void gitReviewApiFor(deviceId)
      .commitFiles({ sessionId, repositoryId, oid: commit.oid })
      .then((result) => {
        if (alive) {
          setPaths(result.paths);
          setStatuses(
            Object.fromEntries((result.files ?? []).map((file) => [file.path, file.status])),
          );
          setError(false);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [open, paths, sessionId, deviceId, repositoryId, commit.oid]);
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
          title={path + ' · ' + t(gitFileDecoration(statuses[path]).labelKey)}
          style={{ color: gitFileDecoration(statuses[path]).color }}
          onClick={() =>
            void openGitReview(
              sessionId,
              { kind: 'commit', commitOid: commit.oid },
              path,
              repositoryId,
            ).catch(() => toast.error(t('rightSidebar.workbench.loadFailed')))
          }
        >
          {gitFileDecoration(statuses[path]).letter} {path}
        </button>
      ))}
    </details>
  );
}
