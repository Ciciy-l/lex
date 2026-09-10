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
  patchTabState: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/openGitReview', () => ({ openGitReview: api.review }));
vi.mock('../../../store', () => ({
  addOrFocusSingletonTab: api.openTab,
  patchTabState: api.patchTabState,
}));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
  it('shows a labelled initial loader until the first graph snapshot arrives', async () => {
    const initial = deferred<typeof data>();
    api.graph.mockReturnValueOnce(initial.promise);
    render(<Harness />);

    const loading = screen.getByRole('status', { name: 'rightSidebar.gitGraph.loading' });
    expect(loading.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByLabelText('rightSidebar.gitGraph.title').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(screen.getByLabelText('rightSidebar.gitGraph.history').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(screen.queryByText('Newest')).toBeNull();

    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(1));
    await act(async () => initial.resolve(data));

    expect(await screen.findByText('Newest')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'rightSidebar.gitGraph.loading' })).toBeNull();
  });

  it('keeps loaded history visible rather than replacing it with the initial loader on refresh', async () => {
    render(<Harness />);
    expect(await screen.findByText('Newest')).toBeTruthy();
    const next = deferred<typeof data>();
    api.graph.mockReturnValueOnce(next.promise);

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Newest')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'rightSidebar.gitGraph.loading' })).toBeNull();
    await act(async () => next.resolve(data));
  });

  it('starts the first graph read immediately instead of waiting for the refresh debounce', async () => {
    let finish!: (value: typeof data) => void;
    api.graph.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);

    expect(api.graph).toHaveBeenCalledWith({
      sessionId: 'lead',
      limit: 100,
      currentBranch: false,
      includeRemotes: true,
    });
    await act(async () => finish(data));
  });
  it('starts the first graph read when a hidden document becomes visible', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    const visibilityState = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility);
    try {
      render(<Harness />);
      expect(api.graph).not.toHaveBeenCalled();

      visibility = 'visible';
      fireEvent(document, new Event('visibilitychange'));

      await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(1));
    } finally {
      visibilityState.mockRestore();
    }
  });
  it('does not let a superseded normal-read error pause growth for the new filter', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    let reject!: (reason: Error) => void;
    let finishNew!: (value: typeof data) => void;
    api.graph
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
    fireEvent.scroll(viewport);
    viewport.scrollTop = 0;
    fireEvent.click(screen.getByLabelText('rightSidebar.gitGraph.currentBranch'));
    await act(async () => reject(new Error('old query failed')));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => finishNew(data));
    api.graph.mockResolvedValue({ ...data, hasMore: false });
    viewport.scrollTop = 1450;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 300, currentBranch: true }),
      ),
    );
  });
  it('releases queued growth skipped while hidden and resumes after a hidden filter change', async () => {
    const view = render(<Harness />);
    await screen.findByText('Newest');
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    let finish!: (value: typeof data) => void;
    api.graph.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
    fireEvent.scroll(viewport);
    view.rerender(<Harness active={false} />);
    viewport.scrollTop = 0;
    fireEvent.click(screen.getByLabelText('rightSidebar.gitGraph.remotes'));
    await act(async () => finish(data));
    expect(api.graph).toHaveBeenCalledTimes(2);
    view.rerender(<Harness />);
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(3));
    expect(api.graph).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 200, includeRemotes: false }),
    );
    api.graph.mockResolvedValue({ ...data, hasMore: false });
    viewport.scrollTop = 1450;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 300, includeRemotes: false }),
      ),
    );
  });
  it.each(['currentBranch', 'remotes'])(
    'releases superseded queued growth after changing %s during a normal read',
    async (filter) => {
      render(<Harness />);
      await screen.findByText('Newest');
      const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 2000 },
        scrollTop: { configurable: true, writable: true, value: 1450 },
      });
      let finish!: (value: typeof data) => void;
      api.graph.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
      await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
      fireEvent.scroll(viewport);
      viewport.scrollTop = 0;
      fireEvent.click(screen.getByLabelText('rightSidebar.gitGraph.' + filter));
      await act(async () => finish(data));
      await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(3));
      expect(api.graph).toHaveBeenLastCalledWith(
        expect.objectContaining({
          limit: 200,
          currentBranch: filter === 'currentBranch',
          includeRemotes: filter !== 'remotes',
        }),
      );
      api.graph.mockResolvedValue({ ...data, hasMore: false });
      viewport.scrollTop = 1450;
      fireEvent.scroll(viewport);
      await waitFor(() =>
        expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 300 })),
      );
    },
  );
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
  it('opens the canonical Git tab in Graph view for the supplied Lead', async () => {
    api.openTab.mockResolvedValue({ id: 'review-tab', kind: 'review' });
    api.patchTabState.mockImplementation(
      async (_sessionId: string, _tabId: string, patch: (current: unknown) => unknown) => patch({}),
    );
    await openGitGraph('lead');
    expect(api.openTab).toHaveBeenCalledWith('lead', 'review', null);
    const update = api.patchTabState.mock.calls[0]?.[2] as (current: unknown) => unknown;
    expect(update({})).toMatchObject({ activeView: 'graph' });
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
  it('renders a comparison diff through the deferred rich diff module', async () => {
    api.graphCompare.mockResolvedValueOnce({
      fromRef: parent,
      fromOid: parent,
      toRef: head,
      toOid: head,
      diffs: [
        {
          id: 'comparison:src/a.ts',
          path: 'src/a.ts',
          additions: 1,
          deletions: 0,
        },
      ],
      capped: null,
      warning: null,
    });
    render(<Harness />);
    fireEvent.click(await screen.findByText('Root'));
    fireEvent.click(screen.getByText('rightSidebar.gitGraph.setFrom'));
    fireEvent.click(screen.getByText('Newest'));
    fireEvent.click(screen.getByText('rightSidebar.gitGraph.setTo'));
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'rightSidebar.gitGraph.compare' })
        .find((button) => button.closest('details'))!,
    );

    expect(await screen.findByText('existing diff renderer')).toBeTruthy();
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
  it('keeps the target prefix locked until its own immediate growth read settles', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    const background = (() => {
      let resolve!: (value: typeof data) => void;
      const promise = new Promise<typeof data>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const growth = (() => {
      let resolve!: (value: typeof data) => void;
      const promise = new Promise<typeof data>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    api.graph
      .mockImplementationOnce(() => background.promise)
      .mockImplementationOnce(() => growth.promise);

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
    fireEvent.scroll(viewport);
    for (let index = 0; index < 6; index++) fireEvent.scroll(viewport);
    expect(api.graph).toHaveBeenCalledTimes(2);

    await act(async () => background.resolve(data));
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 })),
    );
    for (let index = 0; index < 6; index++) fireEvent.scroll(viewport);
    expect(api.graph).toHaveBeenCalledTimes(3);

    await act(async () => growth.resolve({ ...data, hasMore: false }));
  });
  it('releases a staged growth lock when a filter changes before its read starts', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    const background = (() => {
      let resolve!: (value: typeof data) => void;
      const promise = new Promise<typeof data>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const filtered = (() => {
      let resolve!: (value: typeof data) => void;
      const promise = new Promise<typeof data>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    api.graph
      .mockImplementationOnce(() => background.promise)
      .mockImplementationOnce(() => filtered.promise);

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.workbench.refresh' }));
    await waitFor(() => expect(api.graph).toHaveBeenCalledTimes(2));
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByLabelText('rightSidebar.gitGraph.currentBranch'));
    viewport.scrollTop = 0;

    await act(async () => background.resolve(data));
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 200, currentBranch: true }),
      ),
    );
    await act(async () => filtered.resolve({ ...data, hasMore: true }));

    viewport.scrollTop = 1450;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 300, currentBranch: true }),
      ),
    );
  });
  it('continues extending while the viewport remains near the history bottom', async () => {
    render(<Harness />);
    await screen.findByText('Newest');
    const viewport = screen.getByLabelText('rightSidebar.gitGraph.history');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: { configurable: true, writable: true, value: 1450 },
    });
    const firstGrowth = (() => {
      let resolve!: (value: typeof data) => void;
      const promise = new Promise<typeof data>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const secondGrowth = (() => {
      let resolve!: (value: typeof data) => void;
      const promise = new Promise<typeof data>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    api.graph
      .mockImplementationOnce(() => firstGrowth.promise)
      .mockImplementationOnce(() => secondGrowth.promise);

    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 })),
    );
    await act(async () => firstGrowth.resolve({ ...data, hasMore: true }));
    await waitFor(() =>
      expect(api.graph).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 300 })),
    );
    await act(async () => secondGrowth.resolve({ ...data, hasMore: false }));
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
