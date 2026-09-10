import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';

/**
 * Stable first-load shell for Git surfaces.
 *
 * This deliberately contains no repository data or controls: it can be used
 * while a Git chunk is still loading and while its local-only graph read is
 * in flight, without exposing a stale or unverified worktree state.
 */
export function GitGraphLoadingState({
  messageKey = 'rightSidebar.gitGraph.loading',
}: {
  /** Allows the unified Git tab to reuse the same accessible loading shell. */
  messageKey?: string;
}) {
  const { t } = useTranslation();
  const message = t(messageKey);

  return (
    <div
      className="flex h-full min-h-40 w-full flex-1 flex-col items-center justify-center gap-2 px-3 text-12 text-[var(--text-secondary)]"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      aria-label={message}
    >
      <Spinner size={16} />
      <span>{message}</span>
    </div>
  );
}
