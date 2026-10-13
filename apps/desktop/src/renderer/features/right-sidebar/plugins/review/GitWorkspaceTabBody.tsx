import { useTranslation } from 'react-i18next';
import { GitControl } from '../../lib/GitControl';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabKindBodyProps, TabKindHostContext } from '../../types';
import { hydrateGraphState } from '../git-graph/state';
import { GitGraphLoadingState } from '../git-graph/GitGraphLoadingState';
import { GitRepositoryContext, useGitRepositorySelection } from '../../lib/gitRepositorySelection';
import type { ReviewState } from './index';

const ReviewTabBody = lazy(() =>
  import('./ReviewTabBody').then((module) => ({ default: module.ReviewTabBody })),
);
const GitGraphTabBody = lazy(() =>
  import('../git-graph/GitGraphTabBody').then((module) => ({ default: module.GitGraphTabBody })),
);

type MountedViews = Record<ReviewState['activeView'], boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The persisted `review` kind is the canonical Git workspace tab. Keeping the
 * two bodies here gives Git a single tab while retaining each view's existing
 * state and capability guards.
 */
export function GitWorkspaceTabBody({
  state,
  ctx,
  active = true,
  shellVisible = true,
}: TabKindBodyProps<ReviewState>) {
  const { t } = useTranslation();
  const selection = useGitRepositorySelection(
    ctx.sessionId,
    ctx.deviceLinkDeviceId,
    JSON.stringify([ctx.workdir, ctx.remoteHostId]),
  );
  const graphStateRef = useRef(state.graph);
  graphStateRef.current = state.graph;
  const [mountedViews, setMountedViews] = useState<MountedViews>(() => ({
    graph: state.activeView === 'graph',
    review: state.activeView === 'review',
  }));

  // Resolve ownership before any Git request. Older controlled devices retain
  // Review until their host supports repository-aware Graph reads.
  const ownershipKnown = ctx.deviceLinkDeviceId !== undefined;
  const graphAllowed = ownershipKnown && !selection.legacy;
  const activeView = state.activeView === 'graph' && graphAllowed ? 'graph' : 'review';

  useEffect(() => {
    setMountedViews((previous) =>
      previous[activeView] ? previous : { ...previous, [activeView]: true },
    );
  }, [activeView]);

  const patchGraphState = useCallback(
    (patch: unknown) => {
      // Graph controls write shallow preference patches. Keep the most recent
      // local value synchronously so two rapid clicks cannot overwrite each
      // other while the outer tab-state write is still propagating.
      if (!isRecord(patch)) return;
      const nextGraph = hydrateGraphState({ ...graphStateRef.current, ...patch });
      graphStateRef.current = nextGraph;
      ctx.patchState({ graph: nextGraph });
    },
    [ctx],
  );

  const graphCtx = useMemo<TabKindHostContext>(
    () => ({ ...ctx, patchState: patchGraphState }),
    [ctx, patchGraphState],
  );
  const showGraph = graphAllowed && (mountedViews.graph || activeView === 'graph');
  const showReview = mountedViews.review || activeView === 'review';

  // Until Device Link ownership is known, neither Graph nor the
  // Review body may assume that a local worktree belongs to this renderer.
  // This is a normal cold-start state. The workspace opens in Graph mode, so
  // reuse its visible loading shell instead of exposing an inert blank tab
  // while the session origin resolves.
  if (selection.failed) {
    return (
      <div className="flex flex-col items-center gap-2 p-4" role="status">
        <p>{t('rightSidebar.workbench.loadFailed')}</p>
        <GitControl label={t('rightSidebar.workbench.refresh')} onClick={selection.refresh}>
          {t('rightSidebar.workbench.refresh')}
        </GitControl>
      </div>
    );
  }
  if (!ownershipKnown || !selection.ready) {
    return <GitGraphLoadingState />;
  }

  return (
    <GitRepositoryContext.Provider value={selection.repositoryId}>
      <div
        key={selection.repositoryId ?? 'default'}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {showGraph && (
          <div
            className={
              activeView === 'graph' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'
            }
          >
            <Suspense fallback={<GitGraphLoadingState />}>
              <GitGraphTabBody
                state={state.graph}
                ctx={graphCtx}
                active={active && activeView === 'graph'}
                shellVisible={shellVisible}
              />
            </Suspense>
          </div>
        )}
        {showReview && (
          <div
            className={
              activeView === 'review' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'
            }
          >
            <Suspense
              fallback={<GitGraphLoadingState messageKey="rightSidebar.workbench.gitLoading" />}
            >
              <ReviewTabBody
                state={
                  state.repositoryId && state.repositoryId !== selection.repositoryId
                    ? {
                        ...state,
                        historyCommitOid: null,
                        branchBaseRef: null,
                        descriptor: { kind: 'unstaged' },
                        jumpTarget: null,
                      }
                    : state
                }
                ctx={ctx}
              />
            </Suspense>
          </div>
        )}
      </div>
    </GitRepositoryContext.Provider>
  );
}
