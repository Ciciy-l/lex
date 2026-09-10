import { afterEach, describe, expect, it, vi } from 'vitest';
import topology from './real-history-topology.json';
import { createGraphRefreshQueue, graphLanes, hydrateGraphState } from '../state';

afterEach(() => vi.useRealTimers());
describe('Git Graph state', () => {
  it.each([240, 242, 243])(
    'keeps actual root %i parentless without an unloaded-parent boundary',
    (index) => {
      expect(topology.parents[index]).toEqual([]);
      const commits = topology.parents.map((parents, position) => ({
        oid: String(position),
        parents: parents.map(String),
        title: '',
        author: '',
        authorTime: 0,
      }));
      const row = graphLanes(commits)[index];
      expect(row.edges.some((edge) => 'boundary' in edge)).toBe(false);
      expect(row.edges.every((edge) => edge.from !== row.lane)).toBe(true);
    },
  );
  it.each([100, 200, 1000])(
    'preserves the real repository order and compacts merge lanes for a %i-commit prefix',
    (limit) => {
      const commits = topology.parents.slice(0, limit).map((parents, index) => ({
        oid: String(index),
        parents: parents.map(String),
        title: '',
        author: '',
        authorTime: 0,
      }));
      const rows = graphLanes(commits);
      expect(rows.map((row) => row.oid)).toEqual(commits.map((commit) => commit.oid));
      expect(Math.max(...rows.map((row) => row.width))).toBeLessThanOrEqual(3);
      expect(
        Math.max(
          ...rows.slice(topology.focus + 2, Math.min(rows.length, 106)).map((row) => row.width),
        ),
      ).toBe(limit === 100 ? 2 : 3);
    },
  );
  it('hydrates only safe filter state', () => {
    expect(hydrateGraphState(null)).toEqual({ currentBranch: false, includeRemotes: true });
    expect(hydrateGraphState({ currentBranch: true, includeRemotes: false, oid: 'bad' })).toEqual({
      currentBranch: true,
      includeRemotes: false,
    });
  });
  it('draws diverging and converging ancestry, including parents beyond the loaded boundary', () => {
    const rows = graphLanes(
      [
        { oid: 'merge', parents: ['left', 'right'] },
        { oid: 'left', parents: ['base'] },
        { oid: 'right', parents: ['base'] },
        { oid: 'base', parents: ['older'] },
      ].map((commit) => ({ ...commit, author: '', authorTime: 0, title: '' })),
    );
    expect(rows[0]).toMatchObject({
      lane: 0,
      incoming: false,
      edges: [
        { from: 0, to: 0, color: 0 },
        { from: 0, to: 1, color: 1 },
      ],
    });
    expect(rows[2]).toMatchObject({ lane: 1, incoming: true });
    expect(rows[2].edges).toContainEqual({ from: 1, to: 0, color: 1 });
    expect(rows[3].edges).toEqual([{ from: 0, to: 0, color: 0, boundary: true }]);
    expect(rows.map((row) => row.color)).toEqual([0, 0, 1, 0]);
  });
  it('debounces bursts and serializes exactly one trailing refresh', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const task = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = createGraphRefreshQueue(task);
    queue.request();
    queue.request();
    queue.request();
    await vi.advanceTimersByTimeAsync(250);
    expect(task).toHaveBeenCalledTimes(1);
    queue.request();
    queue.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(250);
    expect(task).toHaveBeenCalledTimes(2);
    queue.request();
    queue.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });
  it('compacts closed columns while preserving the remaining paths and colors', () => {
    const commits = [
      { oid: 'merge', parents: ['left', 'right'] },
      { oid: 'left', parents: [] },
      { oid: 'new-tip', parents: ['new-parent'] },
      { oid: 'right', parents: ['right-parent'] },
      { oid: 'new-parent', parents: [] },
      { oid: 'right-parent', parents: [] },
    ].map((commit) => ({ ...commit, title: '', author: '', authorTime: 0 }));
    const rows = graphLanes(commits);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0, 1, 0]);
    expect(Math.max(...rows.map((row) => row.width))).toBe(2);
    expect(rows[1].edges).toContainEqual({ from: 1, to: 0, color: 1 });
    expect(rows[2].edges).toContainEqual({ from: 0, to: 0, color: 1 });
  });
  it('does not reserve long-lived lanes for unloaded merge parents', () => {
    const commits = Array.from({ length: 12 }, (_, index) => ({
      oid: 'merge-' + index,
      parents: ['merge-' + (index + 1), 'outside-' + index],
      title: '',
      author: '',
      authorTime: 0,
    }));
    const rows = graphLanes(commits);
    expect(Math.max(...rows.map((row) => row.width))).toBe(1);
    expect(rows.every((row) => row.edges.some((edge) => 'boundary' in edge))).toBe(true);
    expect(rows.flatMap((row) => row.edges).filter((edge) => 'boundary' in edge)).toHaveLength(13);
    const expanded = graphLanes([
      ...commits,
      { oid: 'outside-0', parents: [], title: '', author: '', authorTime: 0 },
    ]);
    expect(expanded[0].edges).toContainEqual({ from: 0, to: 1, color: 1 });
    expect(expanded[1].edges).toContainEqual({ from: 1, to: 1, color: 1 });
  });
});
