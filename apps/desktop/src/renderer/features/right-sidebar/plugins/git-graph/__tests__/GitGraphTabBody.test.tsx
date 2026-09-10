// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKindHostContext } from '../../../types';
import { GitGraphTabBody } from '../GitGraphTabBody';
import { hydrateGraphState } from '../state';
import { openGitGraph } from '../../../lib/openGitGraph';

const api = vi.hoisted(() => ({
  graph: vi.fn(),
  graphCompare: vi.fn(),
  review: vi.fn(),
  openTab: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/openGitReview', () => ({ openGitReview: api.review }));
vi.mock('../../../store', () => ({ addOrFocusSingletonTab: api.openTab }));
vi.mock('../../review/DiffViewer/PlainUnifiedDiff', () => ({
  PlainUnifiedDiff: () => <div>existing diff renderer</div>,
}));

const head = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const data = {
  scope: { branch: 'main', headOid: head, disabledReason: null },
  commits: [
    { oid: head, parents: [parent], title: 'Newest', author: 'Lex', authorTime: 123 },
    { oid: parent, parents: [], title: 'Root', author: 'Lex', authorTime: 120 },
  ],
  refs: [{ name: 'refs/heads/main', oid: head, kind: 'local' }],
  hasMore: true,
};

function Harness({
  sessionId = 'lead',
  deviceId = null,
  remoteHostId = null,
  active = true,
}: {
  sessionId?: string;
  deviceId?: string | null;
  remoteHostId?: string | null;
  active?: boolean;
}) {
  const [state, setState] = useState(hydrateGraphState(null));
  const ctx = {
    sessionId,
    workdir: '/repo',
    remoteHostId,
    deviceLinkDeviceId: deviceId,
    patchState: (patch: object) => setState((current) => ({ ...current, ...patch })),
  } as TabKindHostContext;
  return <GitGraphTabBody ctx={ctx} state={state} active={active} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  api.graph.mockResolvedValue(data);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.review.mockResolvedValue(undefined);
  api.graphCompare.mockImplementation(async (request) => ({
    ...request,
    diffs: [],
    capped: null,
    warning: null,
  }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { gitReview: api } });
});
afterEach(cleanup);

describe('Git Graph content routing', () => {
  it.each([
    'remote-session',
    'no-session',
    'no-workdir',
    'non-git',
    'git-unavailable',
    'invalid-worktree',
    'unknown',
  ])('renders the explicit disabled description for %s', async (reason) => {
    api.graph.mockResolvedValue({ ...data, scope: { ...data.scope, disabledReason: reason } });
    render(<Harness />);
    expect(
      await screen.findByText('rightSidebar.review.disabled.' + reason + '.desc'),
    ).toBeTruthy();
  });
  it('uses themed pill controls and medium-weight chrome', async () => {
    const view = render(<Harness />);
    await screen.findByText('Newest');
    expect(view.container.querySelector('strong, b, .font-bold')).toBeNull();
    expect(screen.getByLabelText('rightSidebar.gitGraph.search').className).toContain(
      'rounded-full',
    );
    const disclosure = screen.getByText('rightSidebar.gitGraph.compare', { selector: 'summary' });
    expect(disclosure.closest('details')?.open).toBe(false);
    fireEvent.click(disclosure);
    for (const side of ['from', 'to']) {
      const control = screen.getByLabelText('rightSidebar.gitGraph.' + side);
      expect(control.className).toContain('rounded-full');
      expect(control.className).toContain('var(--surface-elevated)');
      expect(control.className).toContain('var(--focus-ring)');
    }
  });
  it('opens the existing singleton content tab for the supplied Lead', async () => {
    await openGitGraph('lead');
    expect(api.openTab).toHaveBeenCalledWith('lead', 'git-graph', null);
  });
  it.each([{ deviceId: 'device' }, { remoteHostId: 'ssh' }])(
    'does not query local Git for a remote context %s',
    async (props) => {
      render(<Harness {...props} />);
      expect(screen.getByText('rightSidebar.gitGraph.localOnly')).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(api.graph).not.toHaveBeenCalled();
    },
  );
  it('fails closed while device ownership is unresolved', () => {
    render(
      <GitGraphTabBody
        ctx={{ sessionId: 'lead', remoteHostId: null } as TabKindHostContext}
        state={hydrateGraphState(null)}
      />,
    );
    expect(screen.getByText('rightSidebar.gitGraph.localOnly')).toBeTruthy();
    expect(api.graph).not.toHaveBeenCalled();
  });
  it('loads a bounded prefix, preserves the list during refresh and applies filters', async () => {
    render(<Harness />);
    expect(await screen.findByText('Newest')).toBeTruthy();
    expect(api.graph).toHaveBeenCalledWith({
      sessionId: 'lead',
      limit: 100,
      currentBranch: false,
      includeRemotes: true,
    });
    expect(screen.queryByText('rightSidebar.gitGraph.loadMore')).toBeNull();
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    api.graph.mockResolvedValue({ ...data, hasMore: false });
    fireEvent.scroll(viewport);
    expect(screen.getByText('Newest')).toBeTruthy();
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 })),
    );
    fireEvent.click(screen.getByLabelText('rightSidebar.gitGraph.currentBranch'));
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ currentBranch: true })),
    );
    fireEvent.change(screen.getByLabelText('rightSidebar.gitGraph.search'), {
      target: { value: 'Newest' },
    });
    expect(screen.getByText('Root').closest('button')?.className).toContain('opacity-30');
  });
  it('opens commit review and compares an explicit base to target without changing either ID', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByText('Root'));
    fireEvent.click(screen.getByText('rightSidebar.gitGraph.setFrom'));
    fireEvent.click(screen.getByText('Newest'));
    fireEvent.click(screen.getByText('rightSidebar.gitGraph.setTo'));
    fireEvent.click(screen.getByText('rightSidebar.gitGraph.commitChanges'));
    expect(api.review).toHaveBeenCalledWith('lead', { kind: 'commit', commitOid: head });
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'rightSidebar.gitGraph.compare' })
        .find((button) => button.closest('details'))!,
    );
    await waitFor(() =>
      expect(api.graphCompare).toHaveBeenCalledWith({
        sessionId: 'lead',
        fromRef: parent,
        fromOid: parent,
        toRef: head,
        toOid: head,
      }),
    );
    expect(await screen.findByText('rightSidebar.workbench.noChanges')).toBeTruthy();
    expect(screen.getByText('rightSidebar.gitGraph.exactComparison')).toBeTruthy();
  });
  it('serializes automatic loading during rapid near-bottom scrolls and stops at the end', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(viewport);
    expect(api.graph).toHaveBeenCalledTimes(1);
    let finish!: (value: typeof data) => void;
    api.graph.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    viewport.scrollTop = 1450;
    for (let index = 0; index < 8; index++) fireEvent.scroll(viewport);
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 8; index++) fireEvent.scroll(viewport);
    expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 }));
    await act(async () => finish({ ...data, hasMore: false }));
    fireEvent.scroll(viewport);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.graph).toHaveBeenCalledTimes(2);
  });
  it('preserves history and pauses automatic retries after a loading failure', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    api.graph.mockRejectedValueOnce(new Error('offline'));
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    fireEvent.scroll(viewport);
    await screen.findByRole('alert');
    expect(screen.getByText('Newest')).toBeTruthy();
    fireEvent.scroll(viewport);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.graph).toHaveBeenCalledTimes(2);
    api.graph.mockResolvedValue({ ...data, hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 }));
  });
  it('locates HEAD outside the loaded prefix by following the current branch', async () => {
    api.graph.mockResolvedValueOnce({ ...data, commits: [data.commits[1]] });
    render(<Harness />);
    await screen.findByText('Root');
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.gitGraph.locateHead' }));
    await screen.findAllByText('Newest');
    expect(api.graph).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentBranch: true, limit: 100 }),
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
  it('keeps selected reference IDs pinned after refresh moves that reference', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    fireEvent.click(screen.getByText('rightSidebar.gitGraph.compare', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('rightSidebar.gitGraph.from'), {
      target: { value: JSON.stringify({ ref: 'refs/heads/main', oid: head }) },
    });
    api.graph.mockResolvedValue({
      ...data,
      refs: [{ name: 'refs/heads/main', oid: parent, kind: 'local' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText('rightSidebar.gitGraph.from') as HTMLSelectElement).value).toBe(
      JSON.stringify({ ref: 'refs/heads/main', oid: head }),
    );
  });
  it('ignores old Lead data after the owning session changes', async () => {
    let finish!: (value: typeof data) => void;
    api.graph.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Harness sessionId="old" />);
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(1));
    view.rerender(<Harness sessionId="new" />);
    await screen.findByText('Newest');
    await act(async () =>
      finish({ ...data, commits: [{ ...data.commits[0], title: 'Old Lead' }] }),
    );
    expect(screen.queryByText('Old Lead')).toBeNull();
  });
  it('does not poll hidden content', async () => {
    render(<Harness active={false} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.graph).not.toHaveBeenCalled();
  });
});
