// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  api: vi.fn(),
  patch: vi.fn(),
  bucket: { tabs: [] as Array<{ id: string; kind: string; state: unknown }> },
}));
vi.mock('@/lib/gitReviewTransport', () => ({ gitReviewApiFor: mocks.api }));
vi.mock('../../store', () => ({
  getBucket: () => mocks.bucket,
  subscribe: () => () => {},
  patchTabState: mocks.patch,
}));
import { useGitRepositorySelection } from '../gitRepositorySelection';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.bucket = { tabs: [] };
});
const catalog = {
  workspace: '/work',
  repositories: [
    { id: 'a', root: '/work/a' },
    { id: 'b', root: '/work/b' },
  ],
  defaultRepositoryId: 'a',
  partial: false,
};
it('does not query local Git until ownership resolves and discards late results from an old device', async () => {
  let finish!: (value: typeof catalog) => void;
  mocks.api.mockReturnValue({ repositories: mocks.list });
  mocks.list
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(catalog);
  const hook = renderHook(({ device }) => useGitRepositorySelection('ownership', device), {
    initialProps: { device: undefined as string | null | undefined },
  });
  expect(mocks.api).not.toHaveBeenCalled();
  hook.rerender({ device: 'old-device' });
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  hook.rerender({ device: 'new-device' });
  await waitFor(() => expect(hook.result.current.repositoryId).toBe('a'));
  await act(async () => finish({ ...catalog, defaultRepositoryId: 'b' }));
  expect(hook.result.current.repositoryId).toBe('a');
  expect(mocks.api.mock.calls.map((call) => call[0])).toEqual(['old-device', 'new-device']);
});
it('clears repository-specific review state while preserving view preferences before publishing a new selection', async () => {
  const previousState = {
    repositoryId: 'a',
    historyCommitOid: 'old',
    branchBaseRef: 'old-base',
    descriptor: { kind: 'commit', commitOid: 'old' },
    jumpTarget: { path: 'old.ts', diffId: null, nonce: 1 },
    activeView: 'graph',
    graph: { currentBranch: true, includeRemotes: false },
    diffViewMode: 'split',
  };
  mocks.bucket = {
    tabs: [{ id: 'review', kind: 'review', state: previousState }],
  };
  mocks.api.mockReturnValue({ repositories: mocks.list });
  mocks.list.mockResolvedValue(catalog);
  mocks.patch.mockImplementation(async (_session, _tab, patch: (current: unknown) => unknown) => {
    mocks.bucket.tabs[0].state = patch(mocks.bucket.tabs[0].state);
  });
  const hook = renderHook(() => useGitRepositorySelection('switch', null));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => hook.result.current.select('b'));
  expect(mocks.patch).toHaveBeenCalledWith('switch', 'review', expect.any(Function));
  expect(mocks.bucket.tabs[0].state).toEqual({
    ...previousState,
    repositoryId: 'b',
    historyCommitOid: null,
    branchBaseRef: null,
    descriptor: { kind: 'unstaged' },
    jumpTarget: null,
  });
  expect(previousState.repositoryId).toBe('a');
  expect(previousState.historyCommitOid).toBe('old');
  expect(hook.result.current.repositoryId).toBe('b');
});
it('keeps old controlled devices on their legacy default-repository view', async () => {
  mocks.api.mockReturnValue({ repositories: mocks.list });
  mocks.list.mockRejectedValue(new Error('unknown op: repositories'));
  const hook = renderHook(() => useGitRepositorySelection('legacy', 'device'));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.legacy).toBe(true);
  expect(hook.result.current.repositoryId).toBeUndefined();
});

it('refreshes both mounted surfaces before selecting a newly discovered repository', async () => {
  mocks.api.mockReturnValue({ repositories: mocks.list });
  mocks.list.mockResolvedValue(catalog);
  const navigator = renderHook(() =>
    useGitRepositorySelection('refresh-shared', null, 'workspace'),
  );
  const content = renderHook(() => useGitRepositorySelection('refresh-shared', null, 'workspace'));
  await waitFor(() =>
    expect(content.result.current.ready && navigator.result.current.ready).toBe(true),
  );
  mocks.list.mockResolvedValue({
    ...catalog,
    repositories: [...catalog.repositories, { id: 'new', root: '/work/new' }],
  });
  act(() => navigator.result.current.refresh());
  await waitFor(() => expect(content.result.current.catalog?.repositories).toHaveLength(3));
  await act(async () => navigator.result.current.select('new'));
  expect(content.result.current.repositoryId).toBe('new');
  expect(navigator.result.current.repositoryId).toBe('new');
});
