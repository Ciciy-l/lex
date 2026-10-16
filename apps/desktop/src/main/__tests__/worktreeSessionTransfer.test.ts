import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeMeta } from '../worktree/types';

const fixture = vi.hoisted(() => ({ db: null as Database.Database | null, unavailable: false }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({
  queryOne: async (sql: string, params: unknown[]) => {
    if (fixture.unavailable) throw new Error('fixture DB unavailable');
    return fixture.db!.prepare(sql).get(...params);
  },
  readLocalWorktreeReferences: async () => [],
}) }));
vi.mock('../localDb/ipc/sessions', () => ({ setWorktreePathInDb: async (id: string, value: string) => {
  if (fixture.unavailable) throw new Error('fixture DB unavailable');
  fixture.db!.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?').run(value, id);
} }));
vi.mock('../worktree/runtimeLeases', () => ({
  readWorktreeRuntimePaths: async () => new Set(),
  acquireWorktreeRuntimeLease: async () => {}, releaseWorktreeRuntimeLease: async () => {},
}));

let root: string;
let meta: WorktreeMeta;
let manager: typeof import('../worktree/WorktreeManager');
let store: typeof import('../worktree/worktreeStore');
const identity = { delegationId: 'delegation', requestingBotId: 'owner-bot' };
const intent = () => ({ ...meta, pendingSessionTransfer: { ...identity, sessionId: 'next' } });

async function reopenStorage() {
  fixture.db?.close();
  fixture.db = new Database(path.join(root, 'sessions.sqlite'));
  vi.resetModules();
  store = await import('../worktree/worktreeStore');
  // Real atomic disk snapshots, with no in-memory state surviving reopenStorage.
  const registry = path.join(root, 'worktrees.json');
  store._setStoreForTests({
    get: (key: string, fallback: unknown) => JSON.parse(readFileSync(registry, 'utf8'))[key] ?? fallback,
    set: (key: string, value: unknown) => {
      const data = JSON.parse(readFileSync(registry, 'utf8'));
      data[key] = value;
      writeFileSync(`${registry}.tmp`, JSON.stringify(data));
      renameSync(`${registry}.tmp`, registry);
    },
  } as never);
  manager = await import('../worktree/WorktreeManager');
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-transfer-'));
  fixture.unavailable = false;
  writeFileSync(path.join(root, 'worktrees.json'), '{}');
  await reopenStorage();
  fixture.db!.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, worktree_path TEXT); CREATE TABLE bot_delegations (id TEXT PRIMARY KEY, child_session_id TEXT, requesting_bot_id TEXT)');
  meta = { sessionId: 'previous', name: 'task', path: path.join(root, '.cindy-worktrees', 'task'),
    baseRepo: root, branch: 'cindy/task', sourceBranch: 'main', createdAt: '2026-09-12T00:00:00.000Z', generation: 'generation-1' };
  mkdirSync(meta.path, { recursive: true });
  writeFileSync(path.join(meta.path, 'user-work.txt'), 'keep my changes');
  fixture.db!.prepare('INSERT INTO sessions VALUES (?, ?)').run(meta.sessionId, meta.path);
  fixture.db!.prepare('INSERT INTO bot_delegations VALUES (?, ?, ?)').run(identity.delegationId, meta.sessionId, identity.requestingBotId);
  await store.set(meta.sessionId, meta);
});
afterEach(() => {
  fixture.db?.close(); fixture.db = null;
  rmSync(root, { recursive: true, force: true });
});

it.each([true, false])('preserves a retained transfer intent and its files (preserveDirty=%s)', async (preserveDirty) => {
  const pending = intent();
  await store.set(meta.sessionId, pending);
  const bytes = readFileSync(path.join(root, 'worktrees.json'));
  await manager.removeWorktreeForSession(meta.sessionId, { preserveDirty, canRemove: async () => true });
  expect(readFileSync(path.join(root, 'worktrees.json'))).toEqual(bytes);
  expect(readFileSync(path.join(meta.path, 'user-work.txt'), 'utf8')).toBe('keep my changes');
  expect(store.get(meta.sessionId)).toEqual(pending);
  expect(fixture.db!.prepare('SELECT child_session_id FROM bot_delegations WHERE id = ?').get(identity.delegationId)).toEqual({ child_session_id: 'previous' });
});
