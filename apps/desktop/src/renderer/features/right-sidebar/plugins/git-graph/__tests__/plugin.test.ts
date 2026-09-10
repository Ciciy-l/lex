// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ openTab: vi.fn(), patchTabState: vi.fn() }));
vi.mock('../../../store', () => ({
  addOrFocusSingletonTab: store.openTab,
  patchTabState: store.patchTabState,
}));
let registry: typeof import('../../../registry');

beforeEach(async () => {
  vi.resetModules();
  store.openTab.mockReset();
  store.patchTabState.mockReset();
  registry = await import('../../../registry');
  await import('../../../plugins');
});

afterEach(() => registry._resetTabKindRegistry());

it('does not register legacy Graph as a second top-level tab while opening the canonical Git tab', async () => {
  const plugin = registry.getTabKind('git-graph');
  expect(plugin).toBeNull();
  expect(registry.listTabKindMenuMetas()).not.toContainEqual(
    expect.objectContaining({ kind: 'git-graph' }),
  );
  const { openGitGraph } = await import('../../../lib/openGitGraph');
  const tab = { id: 'review-tab', kind: 'review', state: {} };
  store.openTab.mockResolvedValue(tab);
  store.patchTabState.mockImplementation(
    async (_sessionId: string, _tabId: string, patch: (current: unknown) => unknown) => patch({}),
  );
  await expect(openGitGraph('lead')).resolves.toBe(tab);
  expect(store.openTab).toHaveBeenCalledWith('lead', 'review', null);
  const update = store.patchTabState.mock.calls[0]?.[2] as (current: unknown) => unknown;
  expect(update({})).toMatchObject({ activeView: 'graph' });
});
