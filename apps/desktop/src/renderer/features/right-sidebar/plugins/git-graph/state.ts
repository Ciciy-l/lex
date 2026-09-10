import type { GitGraphCommit } from '../../../../../shared/gitGraph';

export interface GitGraphState {
  currentBranch: boolean;
  includeRemotes: boolean;
}

export function hydrateGraphState(raw: unknown): GitGraphState {
  const state = raw as Partial<GitGraphState> | null;
  return {
    currentBranch: state?.currentBranch === true,
    includeRemotes: state?.includeRemotes !== false,
  };
}

export function graphLanes(commits: GitGraphCommit[]) {
  const loaded = new Set(commits.map((commit) => commit.oid));
  const pending: Array<string | null> = [];
  const colors = new Map<string, number>();
  let nextColor = 0;
  const allocate = (oid: string) => {
    const vacant = pending.indexOf(null);
    const column = vacant < 0 ? pending.length : vacant;
    pending[column] = oid;
    return column;
  };
  return commits.map((commit) => {
    let lane = pending.indexOf(commit.oid);
    const incoming = lane >= 0;
    if (lane < 0) {
      lane = allocate(commit.oid);
      colors.set(commit.oid, nextColor++ % 6);
    }
    const color = colors.get(commit.oid)!;
    const before = [...pending];
    pending[lane] = null;
    commit.parents.forEach((parent, index) => {
      if (!colors.has(parent)) colors.set(parent, index === 0 ? color : nextColor++ % 6);
      if (!loaded.has(parent)) return;
      if (!pending.includes(parent)) {
        if (index === 0) pending[lane] = parent;
        else allocate(parent);
      }
    });
    const occupied = pending.filter((oid): oid is string => oid !== null);
    pending.splice(0, pending.length, ...occupied);
    const edges = before.flatMap((oid, column) =>
      oid === null
        ? []
        : oid === commit.oid
          ? commit.parents.map((parent, index) => ({
              from: column,
              to: loaded.has(parent) ? pending.indexOf(parent) : column,
              color: index === 0 ? color : colors.get(parent)!,
              ...(!loaded.has(parent) ? { boundary: true } : {}),
            }))
          : [{ from: column, to: pending.indexOf(oid), color: colors.get(oid)! }],
    );
    return {
      oid: commit.oid,
      lane,
      incoming,
      color,
      width: Math.max(before.length, pending.length),
      edges,
    };
  });
}

export const GRAPH_LANE_COLORS = [
  'var(--git-graph-lane-1)',
  'var(--git-graph-lane-2)',
  'var(--git-graph-lane-3)',
  'var(--git-graph-lane-4)',
  'var(--git-graph-lane-5)',
  'var(--git-graph-lane-6)',
] as const;

export function shortGraphRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '');
}

export function createGraphRefreshQueue(task: () => Promise<void>, delay = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;
  const run = async () => {
    timer = undefined;
    if (disposed || running) return;
    running = true;
    pending = false;
    try {
      await task();
    } finally {
      running = false;
      if (pending && !disposed) timer = setTimeout(() => void run(), delay);
    }
  };
  return {
    request() {
      if (disposed) return;
      pending = true;
      if (running) return;
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
