import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const { default: migration0102 } =
  (await import('../../../../drizzle/scripts/0102_merge_git_workspace_tabs')) as {
    default: { run(db: Database.Database): void };
  };

interface InsertTab {
  id: string;
  sessionId?: string;
  kind: 'review' | 'git-graph' | 'file-browser';
  position: number;
  active?: boolean;
  state?: string;
  createdAt?: number;
}

interface StoredTab {
  id: string;
  session_id: string;
  kind: string;
  position: number;
  is_active: number;
  state: string;
  created_at: number;
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE right_sidebar_tabs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertTab(db: Database.Database, tab: InsertTab): void {
  const createdAt = tab.createdAt ?? 100;
  db.prepare(
    `INSERT INTO right_sidebar_tabs
      (id, session_id, kind, position, is_active, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tab.id,
    tab.sessionId ?? 's1',
    tab.kind,
    tab.position,
    tab.active ? 1 : 0,
    tab.state ?? '{}',
    createdAt,
    createdAt,
  );
}

function tabs(db: Database.Database, sessionId = 's1'): StoredTab[] {
  return db
    .prepare(
      `SELECT id, session_id, kind, position, is_active, state, created_at
       FROM right_sidebar_tabs
       WHERE session_id = ?
       ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .all(sessionId) as StoredTab[];
}

function state(row: StoredTab): Record<string, unknown> {
  return JSON.parse(row.state) as Record<string, unknown>;
}

describe('0102 unified Git workspace tab migration', () => {
  it('keeps the active legacy Graph id and writes the real activeView graph contract', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'review-old',
        kind: 'review',
        position: 3,
        state: JSON.stringify({ descriptor: { kind: 'unstaged' }, diffsExpanded: false }),
      });
      insertTab(db, {
        id: 'graph-active',
        kind: 'git-graph',
        position: 4,
        active: true,
        state: JSON.stringify({ currentBranch: true, includeRemotes: false }),
      });

      migration0102.run(db);

      const [row] = tabs(db);
      expect(row).toMatchObject({ id: 'graph-active', kind: 'review', position: 0, is_active: 1 });
      expect(state(row)).toEqual({
        activeView: 'graph',
        graph: { currentBranch: true, includeRemotes: false },
        descriptor: { kind: 'unstaged' },
        diffsExpanded: false,
      });
      expect(state(row)).not.toHaveProperty('view');
    } finally {
      db.close();
    }
  });

  it('keeps the active Review id and respects its explicit Graph view while retaining Graph preferences', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'graph-old',
        kind: 'git-graph',
        position: 1,
        state: JSON.stringify({ currentBranch: true, includeRemotes: false }),
      });
      insertTab(db, {
        id: 'review-active',
        kind: 'review',
        position: 2,
        active: true,
        state: JSON.stringify({
          descriptor: { kind: 'branch', baseRef: 'main' },
          branchBaseRef: 'main',
          activeView: 'graph',
        }),
      });

      migration0102.run(db);

      const [row] = tabs(db);
      expect(row).toMatchObject({ id: 'review-active', kind: 'review', is_active: 1 });
      expect(state(row)).toEqual({
        activeView: 'graph',
        graph: { currentBranch: true, includeRemotes: false },
        descriptor: { kind: 'branch', baseRef: 'main' },
        branchBaseRef: 'main',
      });
    } finally {
      db.close();
    }
  });

  it('preserves a legacy turn target for Review hydration while coalescing Graph', () => {
    const db = createDb();
    try {
      const turnTarget = {
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        messageId: 'message-1',
        path: 'src/example.ts',
      };
      insertTab(db, {
        id: 'review-turn',
        kind: 'review',
        position: 0,
        active: true,
        state: JSON.stringify({ turnTarget }),
      });
      insertTab(db, {
        id: 'graph-old',
        kind: 'git-graph',
        position: 1,
        state: JSON.stringify({ currentBranch: true }),
      });

      migration0102.run(db);

      const [row] = tabs(db);
      expect(row).toMatchObject({ id: 'review-turn', kind: 'review', is_active: 1 });
      expect(state(row)).toEqual({
        activeView: 'review',
        graph: { currentBranch: true, includeRemotes: true },
        turnTarget,
      });
    } finally {
      db.close();
    }
  });

  it('converts an inactive Graph-only legacy tab to a Graph-first Review workspace', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'graph-only',
        kind: 'git-graph',
        position: 7,
        state: JSON.stringify({ currentBranch: true }),
      });

      migration0102.run(db);

      const [row] = tabs(db);
      expect(row).toMatchObject({ id: 'graph-only', kind: 'review', position: 0, is_active: 0 });
      expect(state(row)).toEqual({
        activeView: 'graph',
        graph: { currentBranch: true, includeRemotes: true },
      });

      migration0102.run(db);
      expect(tabs(db)).toEqual([row]);
    } finally {
      db.close();
    }
  });

  it('keeps an inactive legacy Review in Review when another content tab is active', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'review-inactive',
        kind: 'review',
        position: 0,
        state: JSON.stringify({ descriptor: { kind: 'branch', baseRef: 'main' } }),
      });
      insertTab(db, {
        id: 'files-active',
        kind: 'file-browser',
        position: 1,
        active: true,
        state: JSON.stringify({ selectedFilePath: 'README.md' }),
      });

      migration0102.run(db);

      const review = tabs(db).find((row) => row.id === 'review-inactive');
      expect(review).toBeDefined();
      expect(state(review!)).toEqual({
        activeView: 'review',
        graph: { currentBranch: false, includeRemotes: true },
        descriptor: { kind: 'branch', baseRef: 'main' },
      });
    } finally {
      db.close();
    }
  });

  it('preserves an explicit Graph view on an active pre-release unified workspace', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'unified-graph',
        kind: 'review',
        position: 0,
        active: true,
        state: JSON.stringify({
          activeView: 'graph',
          graph: { currentBranch: true, includeRemotes: false },
          descriptor: { kind: 'unstaged' },
        }),
      });

      migration0102.run(db);

      const [row] = tabs(db);
      expect(state(row)).toEqual({
        activeView: 'graph',
        graph: { currentBranch: true, includeRemotes: false },
        descriptor: { kind: 'unstaged' },
      });
    } finally {
      db.close();
    }
  });

  it('runs safely inside the migration runner outer transaction', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'review-old',
        kind: 'review',
        position: 0,
        state: JSON.stringify({ descriptor: { kind: 'unstaged' } }),
      });
      insertTab(db, {
        id: 'graph-active',
        kind: 'git-graph',
        position: 1,
        active: true,
        state: JSON.stringify({ includeRemotes: false }),
      });

      db.transaction(() => migration0102.run(db))();

      const [row] = tabs(db);
      expect(row).toMatchObject({ id: 'graph-active', kind: 'review', is_active: 1 });
      expect(state(row)).toMatchObject({
        activeView: 'graph',
        graph: { currentBranch: false, includeRemotes: false },
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'right_sidebar_tabs_review_singleton_idx'",
          )
          .pluck()
          .get(),
      ).toBe('right_sidebar_tabs_review_singleton_idx');
    } finally {
      db.close();
    }
  });

  it('handles corrupt duplicates, accepts the temporary view fallback, compacts positions, and is idempotent', () => {
    const db = createDb();
    try {
      insertTab(db, {
        id: 'unrelated',
        kind: 'file-browser',
        position: 4,
        active: true,
        state: JSON.stringify({ selectedFilePath: 'README.md' }),
        createdAt: 10,
      });
      insertTab(db, {
        id: 'review-earliest',
        kind: 'review',
        position: 8,
        state: JSON.stringify({ view: 'review', wordWrap: true }),
        createdAt: 20,
      });
      insertTab(db, {
        id: 'review-corrupt',
        kind: 'review',
        position: 9,
        state: 'not-json',
        createdAt: 30,
      });
      insertTab(db, {
        id: 'graph-corrupt',
        kind: 'git-graph',
        position: 10,
        state: '[',
        createdAt: 40,
      });

      migration0102.run(db);
      const once = tabs(db);
      expect(once.map((row) => [row.id, row.kind, row.position])).toEqual([
        ['unrelated', 'file-browser', 0],
        ['review-earliest', 'review', 1],
      ]);
      expect(state(once[1])).toEqual({
        activeView: 'review',
        graph: { currentBranch: false, includeRemotes: true },
        wordWrap: true,
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'right_sidebar_tabs_review_singleton_idx'",
          )
          .pluck()
          .get(),
      ).toBe('right_sidebar_tabs_review_singleton_idx');
      expect(() =>
        insertTab(db, { id: 'duplicate-review', kind: 'review', position: 2 }),
      ).toThrow();

      migration0102.run(db);
      expect(tabs(db)).toEqual(once);
    } finally {
      db.close();
    }
  });
});
