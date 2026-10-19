import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LedgerDb } from '../../cindy-media/ledger.js';

const state = vi.hoisted(() => ({
  root: '', owner: { mode: 'cloud', dataOwnerId: 'fixture-owner', generation: 1 },
  current: true, pending: false, snapshot: null as null | { client: { drizzle: LedgerDb } },
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => state.owner, isAppSessionBoundaryPending: () => state.pending,
  activeOwnerScopeKey: () => `cloud:${state.owner.dataOwnerId}:${state.owner.generation}`,
  dataOwnerStorageKey: () => 'a'.repeat(20),
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.snapshot }));

import * as schema from '../../localDb/schema.js';
import * as ledger from '../../cindy-media/ledger.js';
import { resolveSafe } from '../../cindy-media/blobStore.js';
import { createCodexNativeMediaImporter } from '../codexNativeMedia.js';
import { createClaudeNativeMediaImporter } from '../claudeNativeMedia.js';
const { default: migration0071 } = await import('../../../../drizzle/scripts/0071_bright_ultron.js') as {
  default: { run(db: Database.Database): void };
};

// Valid 4x4 PNG also used by the isolated original Codex composer proof.
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMQaboERwzEcQA9chaBhlmVJAAAAABJRU5ErkJggg==';
const bytes = Buffer.from(data, 'base64');
const hash = createHash('sha256').update(bytes).digest('hex');
let raw: Database.Database;
let db: LedgerDb;
beforeEach(async () => {
  state.root = await mkdtemp(path.join(tmpdir(), 'lex-native-media-storage-'));
  state.owner = { mode: 'cloud', dataOwnerId: 'fixture-owner', generation: 1 };
  state.current = true; state.pending = false;
  raw = new Database(':memory:'); raw.pragma('foreign_keys = ON');
  const migration = await readFile(path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) raw.exec(statement);
  migration0071.run(raw);
  db = drizzle(raw, { schema }) as unknown as LedgerDb;
  state.snapshot = { client: { drizzle: db } };
});
afterEach(async () => {
  vi.restoreAllMocks(); raw?.close(); state.snapshot = null;
  const resolved = path.resolve(state.root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('lex-native-media-storage-')) {
    throw new Error('Unexpected native media fixture cleanup path');
  }
  await rm(resolved, { recursive: true, force: true });
});
function importer(engine: 'codex' | 'claude', task = 'task') {
  const factory = engine === 'codex' ? createCodexNativeMediaImporter : createClaudeNativeMediaImporter;
  return factory({ sessionId: task, nativeSessionId: 'native', isCurrent: () => state.current });
}
function input(engine: 'codex' | 'claude') {
  return { sessionId: 'native', messageId: 'message', index: 0, signal: new AbortController().signal,
    block: engine === 'codex' ? { type: 'image', url: 'data:image/png;base64,' + data }
      : { type: 'image', source: { type: 'base64', media_type: 'image/png', data } } };
}

describe('native images in the actual media store and SQLite ledger', () => {
  it('shares exact bytes across native composers while retaining task-owned references', async () => {
    const codex = importer('codex'), claude = importer('claude', 'other-task');
    const images = await Promise.all([codex(input('codex')), codex(input('codex')), claude(input('claude'))]);
    expect(images.every(image => image.type === 'image' && image.managedUrl === `cindy-media://blobs/${hash}.png`)).toBe(true);
    const stored = resolveSafe(`cindy-media://blobs/${hash}.png`);
    expect(await readFile(stored.absPath)).toEqual(bytes);
    expect(await db.select().from(schema.mediaBlobs)).toMatchObject([{ hash, bytes: bytes.length, isCache: false }]);
    const refs = await db.select().from(schema.mediaRefs);
    expect(refs).toHaveLength(2);
    expect(refs.map(ref => ref.refId).sort()).toEqual(['other-task', 'task']);
    expect(refs.every(ref => ref.refKind === 'session-attachment' && ref.originKind === 'user' && ref.originSessionId === ref.refId)).toBe(true);
  });

  it('compensates a committed reference if the account changes before its acknowledgement', async () => {
    const original = ledger.addRef;
    vi.spyOn(ledger, 'addRef').mockImplementationOnce(async (...args) => {
      const value = await original(...args); state.owner.generation++; return value;
    });
    await expect(importer('codex')(input('codex'))).rejects.toThrow(/task changed/);
    expect(await db.select().from(schema.mediaRefs)).toEqual([]);
    // Bytes may remain without a ref after rejected ingestion, as the shared store contract requires.
    expect(await readFile(resolveSafe(`cindy-media://blobs/${hash}.png`).absPath)).toEqual(bytes);
  });

  it('rejects revoked task ownership before publishing any bytes or ledger rows', async () => {
    const load = importer('codex'); state.current = false;
    await expect(load(input('codex'))).rejects.toThrow('task changed');
    expect(await db.select().from(schema.mediaBlobs)).toEqual([]);
    expect(await db.select().from(schema.mediaRefs)).toEqual([]);
    await expect(readFile(resolveSafe(`cindy-media://blobs/${hash}.png`).absPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
