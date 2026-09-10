import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  addOrFocusSingletonTab: vi.fn(),
  patchTabState: vi.fn(),
}));

vi.mock('../../store', () => store);

import { openGitReview } from '../openGitReview';
import { openGitWorkspaceView } from '../openGitGraph';

describe('openGitReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.addOrFocusSingletonTab.mockResolvedValue({ id: 'git-tab', kind: 'review' });
    store.patchTabState.mockImplementation(
      async (_sessionId: string, _tabId: string, patch: (current: unknown) => unknown) => patch({}),
    );
  });

  it('focuses the canonical Git tab and switches it into Review in the same state patch', async () => {
    await openGitReview('lead', { kind: 'commit', commitOid: 'a'.repeat(40) }, 'src/a.ts');

    expect(store.addOrFocusSingletonTab).toHaveBeenCalledWith('lead', 'review', null);
    const update = store.patchTabState.mock.calls[0]?.[2] as (
      current: unknown,
    ) => Record<string, unknown>;
    expect(update({ graph: { currentBranch: true, includeRemotes: false } })).toMatchObject({
      activeView: 'review',
      descriptor: { kind: 'commit', commitOid: 'a'.repeat(40) },
      historyCommitOid: 'a'.repeat(40),
      jumpTarget: { path: 'src/a.ts', diffId: null },
      graph: { currentBranch: true, includeRemotes: false },
    });
  });

  it('switches a Git workspace view without replacing its selected Review source', async () => {
    await openGitWorkspaceView('lead', 'review');

    expect(store.addOrFocusSingletonTab).toHaveBeenCalledWith('lead', 'review', null);
    const update = store.patchTabState.mock.calls[0]?.[2] as (
      current: unknown,
    ) => Record<string, unknown>;
    const descriptor = { kind: 'commit', commitOid: 'b'.repeat(40) };
    expect(
      update({
        activeView: 'graph',
        graph: { currentBranch: false },
        descriptor,
        historyCommitOid: descriptor.commitOid,
        jumpTarget: { path: 'src/b.ts', diffId: null, nonce: 1 },
      }),
    ).toEqual({
      activeView: 'review',
      graph: { currentBranch: false },
      descriptor,
      historyCommitOid: descriptor.commitOid,
      jumpTarget: { path: 'src/b.ts', diffId: null, nonce: 1 },
    });
  });
});
