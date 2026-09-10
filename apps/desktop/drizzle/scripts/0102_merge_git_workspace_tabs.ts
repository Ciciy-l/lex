import type Database from 'better-sqlite3';

const MAX_STATE_JSON_BYTES = 16 * 1024;
const GIT_TAB_KINDS = new Set(['review', 'git-graph']);
const REVIEW_STATE_KEYS = [
  'historyCommitOid',
  'descriptor',
  'messageSnapshot',
  'jumpTarget',
  'turnTarget',
  'diffsExpanded',
  'diffViewMode',
  'fileTreeVisible',
  'wordWrap',
  'wordDiff',
  'hideWhitespace',
  'richMarkdownPreview',
  'branchBaseRef',
] as const;

interface TabRow {
  id: string;
  session_id: string;
  kind: string;
  position: number;
  is_active: number;
  state: string;
  created_at: number;
  updated_at: number;
}

type JsonObject = Record<string, unknown>;
type GitView = 'graph' | 'review';

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseState(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compareRows(left: TabRow, right: TabRow): number {
  return (
    left.position - right.position ||
    left.created_at - right.created_at ||
    left.id.localeCompare(right.id)
  );
}

function isActive(row: TabRow): boolean {
  return row.is_active === 1;
}

function viewFromState(state: JsonObject): GitView | null {
  if (state.activeView === 'graph' || state.activeView === 'review') return state.activeView;
  return state.view === 'graph' || state.view === 'review' ? state.view : null;
}

function pickReviewState(state: JsonObject): JsonObject {
  const picked: JsonObject = {};
  for (const key of REVIEW_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(state, key)) picked[key] = state[key];
  }
  return picked;
}

function graphStateFrom(state: JsonObject): { currentBranch: boolean; includeRemotes: boolean } {
  return {
    currentBranch: state.currentBranch === true,
    includeRemotes: state.includeRemotes !== false,
  };
}

function nestedGraphState(state: JsonObject): JsonObject | null {
  return isJsonObject(state.graph) ? state.graph : null;
}

function serializeMergedState(activeView: GitView, review: JsonObject, graph: JsonObject): string {
  const merged = { ...review, activeView, graph };
  const json = JSON.stringify(merged);
  if (Buffer.byteLength(json, 'utf8') <= MAX_STATE_JSON_BYTES) return json;

  return JSON.stringify({ activeView, graph });
}

function mergeSessionRows(rows: TabRow[]): { canonical: TabRow; state: string; active: number } {
  const ordered = [...rows].sort(compareRows);
  const reviewRows = ordered.filter((row) => row.kind === 'review');
  const graphRows = ordered.filter((row) => row.kind === 'git-graph');
  const activeGraph = graphRows.find(isActive);
  const activeReview = reviewRows.find(isActive);

  const canonical = activeGraph ?? activeReview ?? reviewRows[0] ?? graphRows[0];
  if (!canonical) throw new Error('Git tab migration called without a candidate row');

  const reviewRow = canonical.kind === 'review' ? canonical : reviewRows[0];
  const graphRow = canonical.kind === 'git-graph' ? canonical : graphRows[0];
  const canonicalState = parseState(canonical.state);
  const reviewState = reviewRow ? parseState(reviewRow.state) : canonicalState;
  const graphSource = graphRow
    ? parseState(graphRow.state)
    : (nestedGraphState(reviewState) ?? nestedGraphState(canonicalState) ?? {});

  const activeView = activeGraph
    ? 'graph'
    : activeReview
      ? (viewFromState(reviewState) ?? 'review')
      : (viewFromState(reviewState) ??
        viewFromState(canonicalState) ??
        (reviewRows.length > 0 ? 'review' : 'graph'));
  const graph = graphStateFrom(graphSource);

  return {
    canonical,
    state: serializeMergedState(activeView, pickReviewState(reviewState), graph),
    active: rows.some(isActive) ? 1 : canonical.is_active,
  };
}

function reindexSession(db: Database.Database, sessionId: string, updatedAt: number): void {
  const rows = db
    .prepare(
      `SELECT id, session_id, kind, position, is_active, state, created_at, updated_at
       FROM right_sidebar_tabs
       WHERE session_id = ?
       ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .all(sessionId) as TabRow[];
  const update = db.prepare(
    'UPDATE right_sidebar_tabs SET position = ?, updated_at = ? WHERE id = ?',
  );
  rows.forEach((row, position) => {
    if (row.position !== position) update.run(position, updatedAt, row.id);
  });
}

function coalesceGitWorkspaceTabs(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, session_id, kind, position, is_active, state, created_at, updated_at
       FROM right_sidebar_tabs
       WHERE kind IN ('review', 'git-graph')
       ORDER BY session_id ASC, position ASC, created_at ASC, id ASC`,
    )
    .all() as TabRow[];
  const bySession = new Map<string, TabRow[]>();
  for (const row of rows) {
    if (!GIT_TAB_KINDS.has(row.kind)) continue;
    const sessionRows = bySession.get(row.session_id) ?? [];
    sessionRows.push(row);
    bySession.set(row.session_id, sessionRows);
  }

  const updateCanonical = db.prepare(
    `UPDATE right_sidebar_tabs
     SET kind = 'review', state = ?, is_active = ?, updated_at = ?
     WHERE id = ?`,
  );
  const remove = db.prepare('DELETE FROM right_sidebar_tabs WHERE id = ?');
  const now = Date.now();

  for (const [sessionId, legacyRows] of bySession) {
    const merged = mergeSessionRows(legacyRows);
    updateCanonical.run(merged.state, merged.active, now, merged.canonical.id);
    for (const row of legacyRows) {
      if (row.id !== merged.canonical.id) remove.run(row.id);
    }
    reindexSession(db, sessionId, now);
  }
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'right_sidebar_tabs')) return;
  db.transaction(() => {
    coalesceGitWorkspaceTabs(db);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS right_sidebar_tabs_review_singleton_idx
         ON right_sidebar_tabs (session_id)
         WHERE kind = 'review'`,
    );
  })();
}

module.exports = { run };
