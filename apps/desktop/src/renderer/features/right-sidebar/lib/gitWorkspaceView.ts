/** The durable view-selection contract for the unified Git workspace. */
export type GitWorkspaceView = 'graph' | 'review';

/**
 * Match the Review plugin's hydration behavior before a tab has been
 * hydrated. A null/non-object state is a newly-created Git workspace and
 * defaults to Graph; an object without a view is a legacy Review record.
 */
export function resolveGitWorkspaceView(raw: unknown): GitWorkspaceView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'graph';
  const state = raw as Record<string, unknown>;
  const requested = state.activeView ?? state.view;
  return requested === 'graph' || requested === 'review' ? requested : 'review';
}
