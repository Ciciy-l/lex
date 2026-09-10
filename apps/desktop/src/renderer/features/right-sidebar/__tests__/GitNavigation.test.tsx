// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  navigation: vi.fn(),
  history: vi.fn(),
  commitFiles: vi.fn(),
  commitDiff: vi.fn(),
  navigate: vi.fn(),
  openGraph: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/gitReviewTransport', () => ({ gitReviewApiFor: () => api }));
vi.mock('../store', () => ({ getBucket: () => ({ tabs: [] }) }));
vi.mock('../lib/openGitReview', () => ({ openGitReview: api.navigate }));
vi.mock('../lib/openGitGraph', () => ({ openGitGraph: api.openGraph }));
import { GitNavigation } from '../GitNavigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const status = {
  scope: { repoRoot: '/project', branch: 'feature', disabledReason: null },
  status: { files: [] },
};
const history = (title: string) => ({
  commits: [{ oid: title, shortOid: '1234567', title }],
  truncated: false,
});
beforeEach(() => {
  vi.resetAllMocks();
  api.navigation.mockResolvedValue(status);
  api.history.mockResolvedValue(history('initial commit'));
  api.navigate.mockResolvedValue(undefined);
  api.openGraph.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { gitReview: api } });
});
afterEach(cleanup);

describe('Git tool loading', () => {
  it('shows only the recent commit subject while retaining its identity for navigation', async () => {
    api.history.mockResolvedValue({
      commits: [{ oid: 'a'.repeat(40), shortOid: 'abcdef0', title: 'Subject only' }],
      truncated: false,
    });
    api.commitFiles.mockResolvedValue({ paths: ['file.ts'] });
    const view = render(<GitNavigation sessionId="lead" deviceId={null} />);
    const summary = await screen.findByText('Subject only');
    expect(summary.textContent).toBe('Subject only');
    expect(summary.getAttribute('title')).toContain('a'.repeat(40));
    expect(view.container.textContent).not.toContain('abcdef0');
    fireEvent.click(summary);
    const file = await screen.findByText('file.ts');
    expect(api.commitFiles).toHaveBeenCalledWith({ sessionId: 'lead', oid: 'a'.repeat(40) });
    expect(api.commitDiff).not.toHaveBeenCalled();
    fireEvent.click(file);
    expect(api.navigate).toHaveBeenCalledWith(
      'lead',
      { kind: 'commit', commitOid: 'a'.repeat(40) },
      'file.ts',
    );
  });
  it('keeps native disclosure separate from the keyboard-focusable review action', async () => {
    const view = render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('initial commit');
    expect(view.container.querySelector('summary button')).toBeNull();
    const action = screen.getByRole('button', { name: 'rightSidebar.workbench.staged (0)' });
    const details = action.closest('section')!.querySelector('details')!;
    expect(action.textContent).toBe('');
    const summary = details.querySelector('summary')!;
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
    expect(action.closest('details')).toBeNull();
    expect(api.navigate).not.toHaveBeenCalled();
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    action.focus();
    expect(document.activeElement).toBe(action);
    fireEvent.click(action);
    expect(details.open).toBe(true);
    expect(api.navigate).toHaveBeenCalledWith('lead', { kind: 'staged' }, undefined);
  });
  it('keeps empty status sections and a collapsed disclosure stable during refresh', async () => {
    const view = render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('initial commit');
    expect(screen.getAllByText('rightSidebar.workbench.noChanges')).toHaveLength(2);
    const unstaged = view.container.querySelector<HTMLDetailsElement>(
      '[aria-label="rightSidebar.workbench.git"] > section > details',
    );
    if (!unstaged) throw new Error('missing unstaged disclosure');
    fireEvent.click(unstaged.querySelector('summary')!);
    expect(unstaged.open).toBe(false);

    const nextStatus = deferred<typeof status>();
    api.navigation.mockReturnValueOnce(nextStatus.promise);
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.navigation).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText('rightSidebar.workbench.noChanges')).toHaveLength(2);
    const refreshedUnstaged = view.container.querySelector<HTMLDetailsElement>(
      '[aria-label="rightSidebar.workbench.git"] > section > details',
    );
    if (!refreshedUnstaged) throw new Error('missing refreshed unstaged disclosure');
    expect(refreshedUnstaged).toBe(unstaged);
    expect(refreshedUnstaged.open).toBe(false);

    await act(async () => nextStatus.resolve(status));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'rightSidebar.workbench.refresh' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(screen.getAllByText('rightSidebar.workbench.noChanges')).toHaveLength(2);
    expect(refreshedUnstaged.open).toBe(false);
  });
  it('shows history immediately even while working-tree status is still loading', async () => {
    const slow = deferred<typeof status>();
    api.navigation.mockReturnValue(slow.promise);
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    expect(await screen.findByText('initial commit')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.workbench.historyLoading')).toBeNull();
    await act(async () => slow.resolve(status));
    expect(screen.getByText('feature')).toBeTruthy();
  });

  it('keeps history available when the status/diff read fails', async () => {
    api.navigation.mockRejectedValue(new Error('status failed'));
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    expect(await screen.findByText('initial commit')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('never carries the previous Lead history or late result into the next Lead', async () => {
    const old = deferred<ReturnType<typeof history>>();
    api.history.mockReturnValueOnce(old.promise).mockResolvedValueOnce(history('new lead'));
    const view = render(<GitNavigation sessionId="old" deviceId={null} />);
    await waitFor(() => expect(api.history).toHaveBeenCalledWith({ sessionId: 'old' }));
    view.rerender(<GitNavigation sessionId="new" deviceId={null} />);
    expect(await screen.findByText('new lead')).toBeTruthy();
    await act(async () => old.resolve(history('old lead')));
    expect(screen.queryByText('old lead')).toBeNull();
  });

  it('preserves the displayed history after a refresh failure', async () => {
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('initial commit');
    await act(async () => {});
    api.history.mockRejectedValue(new Error('history failed'));
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    expect(await screen.findByText('rightSidebar.workbench.historyUnavailable')).toBeTruthy();
    expect(screen.getByText('initial commit')).toBeTruthy();
  });

  it('explains branch comparison and opens the existing Review without including uncommitted files', async () => {
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('initial commit');
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.comparison' }));
    expect(api.navigate).toHaveBeenCalledWith('lead', { kind: 'branch', baseRef: null }, undefined);
    expect(screen.getByText('rightSidebar.workbench.comparisonHint')).toBeTruthy();
  });

  it.each([
    'remote-session',
    'no-session',
    'no-workdir',
    'non-git',
    'git-unavailable',
    'invalid-worktree',
    'unknown',
  ])('renders the %s title and description rather than a translation object', async (reason) => {
    api.navigation.mockResolvedValue({ scope: { disabledReason: reason }, status: null });
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    expect(
      await screen.findByText('rightSidebar.review.disabled.' + reason + '.title'),
    ).toBeTruthy();
    expect(screen.getByText('rightSidebar.review.disabled.' + reason + '.desc')).toBeTruthy();
  });
  it('uses status-only navigation and opens Graph or staged Review for the owning Lead', async () => {
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('initial commit');
    expect(api.navigation).toHaveBeenCalledWith({ sessionId: 'lead' });
    expect(api.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.gitGraph.title' }));
    expect(api.openGraph).toHaveBeenCalledWith('lead');
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.staged (0)' }));
    expect(api.navigate).toHaveBeenCalledWith('lead', { kind: 'staged' }, undefined);
  });
  it.each([
    { deviceId: 'controlled-device', remoteHostId: null },
    { deviceId: null, remoteHostId: 'ssh-host' },
  ])('does not offer a local Graph opener for a remote context %#', (props) => {
    render(<GitNavigation sessionId="lead" {...props} />);
    expect(screen.queryByRole('button', { name: 'rightSidebar.gitGraph.title' })).toBeNull();
    expect(api.openGraph).not.toHaveBeenCalled();
  });
  it('removes the Graph opener after a locally resolved SSH scope is reported', async () => {
    api.navigation.mockResolvedValue({
      scope: { ...status.scope, source: 'remote', disabledReason: 'remote-session' },
      status: null,
    });
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('rightSidebar.review.disabled.remote-session.title');
    expect(screen.queryByRole('button', { name: 'rightSidebar.gitGraph.title' })).toBeNull();
  });
});
