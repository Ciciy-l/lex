import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Crosshair, GitBranch, RefreshCw, X } from 'lucide-react';
import { GitControl } from '../../lib/GitControl';
import { GraphCommitList } from './GraphCommitList';
import './graph.css';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import type { GitGraphData, GitGraphComparison } from '../../../../../shared/gitGraph';
import type { ReviewDisableReason } from '../../../../../shared/gitReviewWire';
import type { TabKindBodyProps } from '../../types';
import { openGitReview } from '../../lib/openGitReview';
import { Spinner } from '@/components/ui/spinner';
import { GitGraphLoadingState } from './GitGraphLoadingState';
import { createGraphRefreshQueue, type GitGraphState } from './state';

// The rich diff renderer pulls virtualisation, highlighting and image-preview
// code. A graph does not need any of that until the user has actually asked
// to inspect a comparison, so keep the initial Graph chunk focused on history.
const PlainUnifiedDiff = lazy(() =>
  import('../review/DiffViewer/PlainUnifiedDiff').then((module) => ({
    default: module.PlainUnifiedDiff,
  })),
);

type Endpoint = { ref: string; oid: string };
type GraphRefreshSettings = { limit: number; state: GitGraphState };
type GraphGrowthRequest = { generation: number; settings: GraphRefreshSettings };

function sameGraphRefreshSettings(
  left: GraphRefreshSettings,
  right: GraphRefreshSettings,
): boolean {
  return (
    left.limit === right.limit &&
    left.state.currentBranch === right.state.currentBranch &&
    left.state.includeRemotes === right.state.includeRemotes
  );
}

const disabledReasonKeys = {
  'remote-session': 'rightSidebar.review.disabled.remote-session.desc',
  'no-session': 'rightSidebar.review.disabled.no-session.desc',
  'no-workdir': 'rightSidebar.review.disabled.no-workdir.desc',
  'non-git': 'rightSidebar.review.disabled.non-git.desc',
  'git-unavailable': 'rightSidebar.review.disabled.git-unavailable.desc',
  'invalid-worktree': 'rightSidebar.review.disabled.invalid-worktree.desc',
  unknown: 'rightSidebar.review.disabled.unknown.desc',
} satisfies Record<ReviewDisableReason, string>;

export function GitGraphTabBody(props: TabKindBodyProps<GitGraphState>) {
  const { t } = useTranslation();
  if (props.ctx.remoteHostId || props.ctx.deviceLinkDeviceId !== null) {
    return (
      <p className="p-4 text-[var(--text-secondary)]">{t('rightSidebar.gitGraph.localOnly')}</p>
    );
  }
  return <GraphContent key={JSON.stringify([props.ctx.sessionId, props.ctx.workdir])} {...props} />;
}

function GraphContent({
  state,
  ctx,
  active = true,
  shellVisible = true,
}: TabKindBodyProps<GitGraphState>) {
  const { t } = useTranslation();
  const [data, setData] = useState<GitGraphData | null>(null);
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState<Endpoint | null>(null);
  const [to, setTo] = useState<Endpoint | null>(null);
  const [comparison, setComparison] = useState<GitGraphComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const comparisonPanel = useRef<HTMLDetailsElement>(null);
  const comparisonEpoch = useRef(0);
  const comparisonRunning = useRef(false);
  const visible = useRef(active && shellVisible);
  visible.current = active && shellVisible;
  const list = useRef<HTMLDivElement>(null);
  const growthPending = useRef<GraphGrowthRequest | null>(null);
  const growthGeneration = useRef(0);
  // The immediate request is staged before React commits the new limit. The
  // matching effect consumes this once so it does not schedule a duplicate
  // debounced refresh for the same prefix.
  const growthRefresh = useRef<GraphGrowthRequest | null>(null);
  // The visible prefix is only safe to extend when it belongs to the active
  // filter. Otherwise a filter change while scrolled at the bottom could grow
  // an old 100-row result again before the replacement query arrives.
  const loadedSettings = useRef<GraphRefreshSettings | null>(null);
  const scrollAnchor = useRef<{ oid: string; offset: number } | null>(null);
  const locateOnRefresh = useRef(false);
  const refresh = useRef<ReturnType<typeof createGraphRefreshQueue> | null>(null);
  // The first visible graph is user-initiated and has no burst to collapse.
  // Subsequent refreshes still use the queue's debounce so file-save/focus
  // events cannot create a stream of Git reads.
  const hasStartedInitialRead = useRef(false);
  const { currentBranch, includeRemotes } = state;
  const currentSettings = useMemo<GraphRefreshSettings>(
    () => ({ limit, state: { currentBranch, includeRemotes } }),
    [limit, currentBranch, includeRemotes],
  );
  const settings = useRef(currentSettings);
  settings.current = currentSettings;

  useEffect(() => {
    let alive = true;
    const queue = createGraphRefreshQueue(async () => {
      const snapshot = settings.current;
      const growth = growthPending.current;
      const ownsGrowth =
        growth && sameGraphRefreshSettings(growth.settings, snapshot) ? growth : null;
      let attemptedRead = false;
      try {
        if (!visible.current || document.visibilityState === 'hidden') return;
        attemptedRead = true;
        setBusy(true);
        const result = await window.electronAPI.gitReview.graph({
          sessionId: ctx.sessionId,
          limit: snapshot.limit,
          ...snapshot.state,
        });
        if (alive && sameGraphRefreshSettings(snapshot, settings.current)) {
          const viewport = list.current;
          if (viewport && viewport.scrollTop > 0) {
            const top = viewport.getBoundingClientRect().top;
            const anchor = [...viewport.querySelectorAll<HTMLElement>('[data-commit-oid]')].find(
              (row) => row.getBoundingClientRect().bottom > top + 28,
            );
            if (anchor)
              scrollAnchor.current = {
                oid: anchor.dataset.commitOid!,
                offset: anchor.getBoundingClientRect().top - top,
              };
          }
          setData(result);
          loadedSettings.current = snapshot;
          setFailed(false);
        }
      } catch {
        // A stale background request must not turn the newer scroll prefix
        // into a paused error state after that prefix has already been staged.
        if (alive && sameGraphRefreshSettings(snapshot, settings.current)) setFailed(true);
      } finally {
        if (alive) {
          // A background/manual request may settle after a scroll expansion
          // has been queued. Only the request that owns this target prefix may
          // release its lock; otherwise another scroll can jump from 100 to
          // 300 before the 200-prefix read has completed.
          if (ownsGrowth && growthPending.current?.generation === ownsGrowth.generation) {
            growthPending.current = null;
            if (!attemptedRead && growthRefresh.current?.generation === ownsGrowth.generation) {
              growthRefresh.current = null;
            }
          }
          if (attemptedRead) setBusy(false);
        }
      }
    });
    refresh.current = queue;
    return () => {
      alive = false;
      queue.dispose();
      comparisonEpoch.current++;
    };
  }, [ctx.sessionId]);

  useEffect(() => {
    if (!active || !shellVisible) return;
    const update = () => {
      if (document.visibilityState === 'hidden') return;
      // A filter/locate change can happen after a near-bottom expansion was
      // staged but before its single-flight read starts. That expansion no
      // longer belongs to the new query, so it must not keep the next scroll
      // prefix permanently locked.
      const pendingGrowth = growthPending.current;
      if (pendingGrowth && !sameGraphRefreshSettings(pendingGrowth.settings, currentSettings)) {
        growthPending.current = null;
      }
      const stagedGrowth = growthRefresh.current;
      if (stagedGrowth) {
        growthRefresh.current = null;
        if (sameGraphRefreshSettings(stagedGrowth.settings, currentSettings)) return;
      }
      if (!hasStartedInitialRead.current) {
        hasStartedInitialRead.current = true;
        refresh.current?.requestImmediate();
      } else {
        refresh.current?.request();
      }
    };
    update();
    const timer = window.setInterval(update, 15000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('lex:git-changed', update);
    window.addEventListener('lex:workspace-file-saved', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('lex:git-changed', update);
      window.removeEventListener('lex:workspace-file-saved', update);
    };
  }, [active, shellVisible, currentSettings]);

  useLayoutEffect(() => {
    const viewport = list.current;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (!viewport || !anchor) return;
    const row = [...viewport.querySelectorAll<HTMLElement>('[data-commit-oid]')].find(
      (item) => item.dataset.commitOid === anchor.oid,
    );
    if (row)
      viewport.scrollTop +=
        row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  }, [data]);

  const loadNearBottom = useCallback(() => {
    const viewport = list.current;
    if (
      !viewport ||
      viewport.clientHeight <= 0 ||
      !active ||
      !shellVisible ||
      document.visibilityState === 'hidden' ||
      !data?.hasMore ||
      !loadedSettings.current ||
      !sameGraphRefreshSettings(loadedSettings.current, settings.current) ||
      failed ||
      growthPending.current ||
      settings.current.limit >= 1000
    )
      return;
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 180) return;
    const nextSettings: GraphRefreshSettings = {
      limit: Math.min(1000, settings.current.limit + 100),
      state: { currentBranch, includeRemotes },
    };
    const growth: GraphGrowthRequest = {
      generation: ++growthGeneration.current,
      settings: nextSettings,
    };
    growthPending.current = growth;
    growthRefresh.current = growth;
    // React has not committed `setLimit` yet. Stage the exact semantic
    // snapshot first so the urgent queue reads 200 rather than the old 100.
    settings.current = nextSettings;
    setLimit(nextSettings.limit);
    refresh.current?.requestImmediate();
  }, [active, shellVisible, data, failed, currentBranch, includeRemotes]);

  useEffect(() => {
    loadNearBottom();
  }, [loadNearBottom]);

  useEffect(() => {
    if (!locateOnRefresh.current) return;
    const row = list.current?.querySelector<HTMLElement>('[data-head="true"]');
    if (row) {
      locateOnRefresh.current = false;
      row.scrollIntoView({ block: 'center' });
    }
  }, [data]);
  const commit = data?.commits.find((item) => item.oid === selected);
  // Keep the first open explicitly communicative. Once a graph exists, refresh
  // it in place instead: replacing readable history with a loader on every
  // focus/file-save refresh is both visually noisy and less useful.
  const initialLoading = data === null && !failed;
  const choices: Endpoint[] = [
    ...(data?.refs
      .filter((ref) => state.includeRemotes || ref.kind !== 'remote')
      .map((ref) => ({ ref: ref.name, oid: ref.oid })) ?? []),
    ...(data?.commits.map((item) => ({ ref: item.oid, oid: item.oid })) ?? []),
  ];
  const endpointChanged = (side: 'from' | 'to', endpoint: Endpoint | null) => {
    comparisonEpoch.current++;
    if (comparisonPanel.current) comparisonPanel.current.open = true;
    setComparison(null);
    (side === 'from' ? setFrom : setTo)(endpoint);
  };
  const compare = async () => {
    if (!from || !to || comparisonRunning.current) return;
    comparisonRunning.current = true;
    const epoch = ++comparisonEpoch.current;
    setComparing(true);
    setComparison(null);
    try {
      const result = await window.electronAPI.gitReview.graphCompare({
        sessionId: ctx.sessionId,
        fromRef: from.ref,
        fromOid: from.oid,
        toRef: to.ref,
        toOid: to.oid,
      });
      if (epoch === comparisonEpoch.current) setComparison(result);
    } catch {
      if (epoch === comparisonEpoch.current) toast.error(t('rightSidebar.workbench.loadFailed'));
    } finally {
      comparisonRunning.current = false;
      setComparing(false);
    }
  };
  const locateHead = () => {
    setQuery('');
    setSelected(data?.scope.headOid ?? null);
    const row = list.current?.querySelector<HTMLElement>('[data-head="true"]');
    if (row) row.scrollIntoView({ block: 'center' });
    else {
      locateOnRefresh.current = true;
      setLimit(100);
      ctx.patchState({ currentBranch: true });
      refresh.current?.request();
    }
  };
  return (
    <section
      className="lex-git-graph flex h-full min-h-0 min-w-0 flex-col overflow-auto text-12"
      aria-label={t('rightSidebar.gitGraph.title')}
      aria-busy={busy || initialLoading || undefined}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-default)] px-2 py-1.5">
        <GitBranch size={14} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <span className="max-w-40 truncate font-medium" title={data?.scope.branch ?? 'HEAD'}>
          {data?.scope.branch ?? 'HEAD'}
        </span>
        <GitControl
          label={t('rightSidebar.workbench.refresh')}
          iconOnly
          disabled={busy}
          onClick={() => refresh.current?.request()}
        >
          <RefreshCw size={14} />
        </GitControl>
        <GitControl
          label={t('rightSidebar.gitGraph.locateHead')}
          iconOnly
          disabled={!data?.scope.headOid}
          onClick={locateHead}
        >
          <Crosshair size={14} />
        </GitControl>
        <GitControl
          label={t('rightSidebar.gitGraph.compare')}
          iconOnly
          onClick={() => {
            if (comparisonPanel.current)
              comparisonPanel.current.open = !comparisonPanel.current.open;
          }}
        >
          <ArrowLeftRight size={14} />
        </GitControl>
        <Input
          className="min-w-32 flex-1"
          size="sm"
          ariaLabel={t('rightSidebar.gitGraph.search')}
          placeholder={t('rightSidebar.gitGraph.search')}
          value={query}
          onChange={setQuery}
        />
        <div className="flex w-full flex-wrap gap-3 px-1 pt-0.5 text-11 text-[var(--text-secondary)]">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.currentBranch}
              onChange={(event) => ctx.patchState({ currentBranch: event.target.checked })}
            />
            {t('rightSidebar.gitGraph.currentBranch')}
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.includeRemotes}
              onChange={(event) => ctx.patchState({ includeRemotes: event.target.checked })}
            />
            {t('rightSidebar.gitGraph.remotes')}
          </label>
        </div>
      </div>
      {failed && (
        <p role="alert" className="p-3">
          {t('rightSidebar.workbench.loadFailed')}
        </p>
      )}
      {data?.scope.disabledReason && (
        <p className="p-3">{t(disabledReasonKeys[data.scope.disabledReason])}</p>
      )}
      <div
        ref={list}
        onScroll={loadNearBottom}
        className="min-h-40 flex-1 overflow-auto"
        aria-label={t('rightSidebar.gitGraph.history')}
        aria-busy={initialLoading || undefined}
      >
        {initialLoading ? (
          <GitGraphLoadingState />
        ) : data ? (
          <GraphCommitList
            data={data}
            query={query}
            selected={selected}
            includeRemotes={state.includeRemotes}
            onSelect={setSelected}
          />
        ) : null}
      </div>
      {!busy && data && !data.commits.length && (
        <p className="p-3">{t('rightSidebar.workbench.noCommits')}</p>
      )}
      {data?.hasMore && limit >= 1000 && (
        <p className="shrink-0 px-3 py-1 text-11 text-[var(--text-secondary)]">
          {t('rightSidebar.gitGraph.limit')}
        </p>
      )}
      {commit && (
        <div className="shrink-0 space-y-1 border-t border-[var(--border-default)] px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium" title={commit.title}>
              {commit.title}
            </span>
            <GitControl
              label={t('rightSidebar.gitGraph.closeDetails')}
              iconOnly
              onClick={() => setSelected(null)}
            >
              <X size={13} />
            </GitControl>
          </div>
          <p className="truncate text-11 text-[var(--text-secondary)]" title={commit.oid}>
            {commit.author} · {new Date(commit.authorTime * 1000).toLocaleString()} ·{' '}
            <code>{commit.oid.slice(0, 8)}</code>
          </p>
          <p
            className="truncate text-11 text-[var(--text-secondary)]"
            title={commit.parents.join(', ')}
          >
            {t('rightSidebar.gitGraph.parents')}:{' '}
            {commit.parents.map((parent) => parent.slice(0, 8)).join(', ') || '—'}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <GitControl
              label={t('rightSidebar.gitGraph.setFrom')}
              onClick={() => endpointChanged('from', { ref: commit.oid, oid: commit.oid })}
            >
              {t('rightSidebar.gitGraph.setFrom')}
            </GitControl>
            <GitControl
              label={t('rightSidebar.gitGraph.setTo')}
              onClick={() => endpointChanged('to', { ref: commit.oid, oid: commit.oid })}
            >
              {t('rightSidebar.gitGraph.setTo')}
            </GitControl>
            <GitControl
              label={t('rightSidebar.gitGraph.commitChanges')}
              onClick={() =>
                void openGitReview(ctx.sessionId, { kind: 'commit', commitOid: commit.oid }).catch(
                  () => toast.error(t('rightSidebar.workbench.loadFailed')),
                )
              }
            >
              {t('rightSidebar.gitGraph.commitChanges')}
            </GitControl>
          </div>
        </div>
      )}
      <details
        ref={comparisonPanel}
        className="max-h-[45%] shrink-0 overflow-auto border-t border-[var(--border-default)] px-3 py-2"
      >
        <summary className="cursor-pointer text-12 font-medium">
          {t('rightSidebar.gitGraph.compare')}
          {from && to ? ': ' + from.oid.slice(0, 8) + ' → ' + to.oid.slice(0, 8) : ''}
        </summary>
        <div className="space-y-2 pt-2">
          <p className="text-11 text-[var(--text-secondary)]">
            {t('rightSidebar.gitGraph.exactComparison')}
          </p>
          {(['from', 'to'] as const).map((side) => {
            const endpoint = side === 'from' ? from : to;
            const options =
              endpoint &&
              !choices.some((choice) => JSON.stringify(choice) === JSON.stringify(endpoint))
                ? [endpoint, ...choices]
                : choices;
            return (
              <label key={side} className="block min-w-0 text-11">
                {t(side === 'from' ? 'rightSidebar.gitGraph.from' : 'rightSidebar.gitGraph.to')}
                <select
                  className="mt-1 h-8 w-full max-w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                  aria-label={t(
                    side === 'from' ? 'rightSidebar.gitGraph.from' : 'rightSidebar.gitGraph.to',
                  )}
                  value={endpoint ? JSON.stringify(endpoint) : ''}
                  onChange={(event) =>
                    endpointChanged(
                      side,
                      event.target.value ? (JSON.parse(event.target.value) as Endpoint) : null,
                    )
                  }
                >
                  <option value="">{t('rightSidebar.gitGraph.selectRef')}</option>
                  {options.map((choice) => (
                    <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                      {choice.ref} ({choice.oid.slice(0, 8)})
                    </option>
                  ))}
                </select>
                {endpoint && (
                  <code className="block break-all text-10 text-[var(--text-secondary)]">
                    {endpoint.oid}
                  </code>
                )}
              </label>
            );
          })}
          <GitControl
            label={t('rightSidebar.gitGraph.compare')}
            disabled={!from || !to || comparing}
            onClick={() => void compare()}
          >
            <ArrowLeftRight size={13} />
            {t('rightSidebar.gitGraph.compare')}
          </GitControl>
          {comparison && (
            <div>
              <p className="break-all">
                {comparison.fromRef} ({comparison.fromOid}) → {comparison.toRef} ({comparison.toOid}
                )
              </p>
              {(comparison.capped || comparison.warning) && (
                <p role="status">{t('rightSidebar.gitGraph.capped')}</p>
              )}
              {comparison.capped?.files.map((file) => (
                <p key={file.path}>{file.path}</p>
              ))}
              {!comparison.diffs.length && !comparison.capped && !comparison.warning && (
                <p>{t('rightSidebar.workbench.noChanges')}</p>
              )}
              {comparison.diffs.length > 0 && (
                <Suspense
                  fallback={
                    <div className="flex min-h-12 items-center justify-center" aria-busy="true">
                      <Spinner size={14} />
                    </div>
                  }
                >
                  {comparison.diffs.map((diff) => (
                    <details key={diff.id} className="border-t border-[var(--border-default)] py-2">
                      <summary className="cursor-pointer">
                        {diff.path} (+{diff.additions} −{diff.deletions})
                      </summary>
                      <PlainUnifiedDiff diff={diff} />
                    </details>
                  ))}
                </Suspense>
              )}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
