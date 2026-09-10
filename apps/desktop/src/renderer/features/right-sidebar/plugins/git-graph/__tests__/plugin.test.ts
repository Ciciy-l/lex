// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const openTab = vi.hoisted(() => vi.fn());
vi.mock('../../../store', () => ({ addOrFocusSingletonTab: openTab }));
let registry: typeof import('../../../registry');

beforeEach(async () => {
  vi.resetModules();
  openTab.mockReset();
  registry = await import('../../../registry');
  await import('../index');
});

afterEach(() => registry._resetTabKindRegistry());

it('excludes Graph from the add-tab menu while preserving contextual singleton opening', async () => {
  const plugin = registry.getTabKind('git-graph');
  expect(plugin?.menu).toMatchObject({ enabled: true, singleton: true, hiddenFromMenu: true });
  expect(registry.listTabKindMenuMetas()).not.toContainEqual(
    expect.objectContaining({ kind: 'git-graph' }),
  );
  const { openGitGraph } = await import('../../../lib/openGitGraph');
  const tab = { id: 'graph-tab', kind: 'git-graph' };
  openTab.mockResolvedValue(tab);
  await expect(openGitGraph('lead')).resolves.toBe(tab);
  expect(openTab).toHaveBeenCalledWith('lead', 'git-graph', null);
});
