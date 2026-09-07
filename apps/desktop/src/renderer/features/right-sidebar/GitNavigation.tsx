import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import type { ReviewCommit, ReviewData, ReviewHistoryData } from '../../../shared/gitReviewWire';
import { openGitReview } from './lib/openGitReview';
import { getBucket } from './store';
import type { ReviewState } from './plugins/review';

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
  const [data, setData] = useState<ReviewData | null>(null);
  const [history, setHistory] = useState<ReviewHistoryData | null>(null);
  const [failed, setFailed] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setHistoryBusy(true);
    const request = ++revision.current;
    // Each section publishes as soon as it is ready. Full working-tree diffs
    // can take much longer than the bounded history read on large repositories.
    await Promise.allSettled([
      gitReviewApiFor(deviceId)
        .get({ sessionId })
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
    void refresh();
    const update = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const interval = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    window.addEventListener('lex:workspace-file-saved', update);
    window.addEventListener('lex:git-changed', update);
    return () => {
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
      <div className="flex items-center gap-1 border-b border-[var(--border-default)] p-2">
        <div className="min-w-0 flex-1">
          <div className="truncate" title={data?.scope.repoRoot || ''}>
            {data?.scope.repoRoot?.split(/[\\/]/).pop() || t('rightSidebar.workbench.git')}
          </div>
          <div className="truncate text-11 text-[var(--text-secondary)]">
            {data?.scope.branch || (data?.scope.isDetached ? data.scope.headOid?.slice(0, 7) : '')}
          </div>
        </div>
        <Tip text={t('rightSidebar.workbench.refresh')}>
          <Button
            size="md"
            variant="secondary"
            disabled={busy}
            aria-label={t('rightSidebar.workbench.refresh')}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
          </Button>
        </Tip>
      </div>
      {failed && (
        <p role="alert" className="px-2">
          {t('rightSidebar.workbench.loadFailed')}
        </p>
      )}
      {data?.scope.disabledReason ? (
        <div className="p-2 text-[var(--text-secondary)]">
          <p>{t(`rightSidebar.review.disabled.${data.scope.disabledReason}.title`)}</p>
          <p className="text-11">
            {t(`rightSidebar.review.disabled.${data.scope.disabledReason}.desc`)}
          </p>
        </div>
      ) : (
        <>
          {(['unstaged', 'staged'] as const).map((source) => {
            const files = data?.status?.files.filter((file) => file.sources.includes(source)) ?? [];
            return (
              <details key={source} open className="border-b border-[var(--border-default)] p-2">
                <summary className="cursor-pointer select-none font-medium">
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
                    className="block w-full truncate rounded-md px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
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
            );
          })}
          <div className="border-b border-[var(--border-default)] p-2">
            <Button
              variant="secondary"
              size="md"
              onClick={() => navigate({ kind: 'branch', baseRef: review?.branchBaseRef || null })}
            >
              {t('rightSidebar.workbench.comparison')}
              {review?.branchBaseRef ? ': ' + review.branchBaseRef : ''}
            </Button>
            <p className="mt-1 text-11 text-[var(--text-tertiary)]">
              {t('rightSidebar.workbench.comparisonHint')}
            </p>
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
      <summary className="cursor-pointer select-none truncate py-1" title={commit.title}>
        {commit.shortOid} {commit.title}
      </summary>
      {error && <span className="text-11">{t('rightSidebar.workbench.loadFailed')}</span>}
      {paths?.map((path) => (
        <button
          className="block w-full truncate rounded-md py-1 pl-3 text-left hover:bg-[var(--surface-hover)]"
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
