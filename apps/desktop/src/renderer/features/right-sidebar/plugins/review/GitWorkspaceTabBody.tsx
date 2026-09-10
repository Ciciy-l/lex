import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabKindBodyProps, TabKindHostContext } from '../../types';
import { hydrateGraphState } from '../git-graph/state';
import { GitGraphLoadingState } from '../git-graph/GitGraphLoadingState';
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
  const graphStateRef = useRef(state.graph);
  graphStateRef.current = state.graph;
  const [mountedViews, setMountedViews] = useState<MountedViews>(() => ({
    graph: state.activeView === 'graph',
    review: state.activeView === 'review',
  }));

  // Graph itself also repeats this check before it can issue local IPC. The
  // workspace chooses Review as the usable surface for remote/device contexts
  // so a newly-opened Git tab never lands on a known-unavailable graph view.
  const ownershipKnown = ctx.deviceLinkDeviceId !== undefined;
  const graphAllowed =
    ownershipKnown && ctx.remoteHostId === null && ctx.deviceLinkDeviceId === null;
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

  // Until Device Link ownership is known, neither local-only Graph nor the
  // Review body may assume that a local worktree belongs to this renderer.
  // This is a normal cold-start state. The workspace opens in Graph mode, so
  // reuse its visible loading shell instead of exposing an inert blank tab
  // while the session origin resolves.
  if (!ownershipKnown) {
    return <GitGraphLoadingState />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
            <ReviewTabBody state={state} ctx={ctx} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
