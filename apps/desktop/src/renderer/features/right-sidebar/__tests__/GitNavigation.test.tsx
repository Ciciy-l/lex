// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn(), commitDiff: vi.fn(), navigate: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/gitReviewTransport', () => ({ gitReviewApiFor: () => api }));
vi.mock('../store', () => ({ getBucket: () => ({ tabs: [] }) }));
vi.mock('../lib/openGitReview', () => ({ openGitReview: api.navigate }));
import { GitNavigation } from '../GitNavigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const status = { scope: { repoRoot: '/project', branch: 'feature', disabledReason: null }, status: { files: [] } };
const history = (title: string) => ({ commits: [{ oid: title, shortOid: '1234567', title }], truncated: false });
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue(status);
  api.history.mockResolvedValue(history('initial commit'));
  api.navigate.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { gitReview: api } });
});
afterEach(cleanup);

describe('Git tool loading', () => {
  it('shows history immediately even while full working-tree diff is still loading', async () => {
    const slow = deferred<typeof status>();
    api.get.mockReturnValue(slow.promise);
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    expect(await screen.findByText('1234567 initial commit')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.workbench.historyLoading')).toBeNull();
    await act(async () => slow.resolve(status));
    expect(screen.getByText('feature')).toBeTruthy();
  });

  it('keeps history available when the status/diff read fails', async () => {
    api.get.mockRejectedValue(new Error('diff failed'));
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    expect(await screen.findByText('1234567 initial commit')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('never carries the previous Lead history or late result into the next Lead', async () => {
    const old = deferred<ReturnType<typeof history>>();
    api.history.mockReturnValueOnce(old.promise).mockResolvedValueOnce(history('new lead'));
    const view = render(<GitNavigation sessionId="old" deviceId={null} />);
    view.rerender(<GitNavigation sessionId="new" deviceId={null} />);
    expect(await screen.findByText('1234567 new lead')).toBeTruthy();
    await act(async () => old.resolve(history('old lead')));
    expect(screen.queryByText('1234567 old lead')).toBeNull();
  });

  it('preserves the displayed history after a refresh failure', async () => {
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('1234567 initial commit');
    await act(async () => {});
    api.history.mockRejectedValue(new Error('history failed'));
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    expect(await screen.findByText('rightSidebar.workbench.historyUnavailable')).toBeTruthy();
    expect(screen.getByText('1234567 initial commit')).toBeTruthy();
  });

  it('explains branch comparison and opens the existing Review without including uncommitted files', async () => {
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    await screen.findByText('1234567 initial commit');
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.comparison' }));
    expect(api.navigate).toHaveBeenCalledWith('lead', { kind: 'branch', baseRef: null }, undefined);
    expect(screen.getByText('rightSidebar.workbench.comparisonHint')).toBeTruthy();
  });

  it('renders the non-repository title and description rather than a translation object', async () => {
    api.get.mockResolvedValue({ scope: { disabledReason: 'not-git' }, status: null });
    render(<GitNavigation sessionId="lead" deviceId={null} />);
    expect(await screen.findByText('rightSidebar.review.disabled.not-git.title')).toBeTruthy();
    expect(screen.getByText('rightSidebar.review.disabled.not-git.desc')).toBeTruthy();
  });
});
