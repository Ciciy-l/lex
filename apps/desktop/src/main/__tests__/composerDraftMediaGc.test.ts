/** Real shared blob bytes and an owner-B ledger; all account files are synthetic. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDraftContent } from '../../shared/composerDraft';
import type { LedgerDb } from '../cindy-media/ledger';

const host = vi.hoisted(() => ({ root: '', owner: 'owner-a', generation: 1 }));
vi.mock('electron', () => ({ app: { getPath: () => host.root }, ipcMain: { on: vi.fn(), handle: vi.fn() } }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => host.owner + ':' + host.generation,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: host.owner, ownerGeneration: host.generation }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(host.root, 'owners',
    createHash('sha256').update(host.owner).digest('hex').slice(0, 20), ...parts),
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));

const schema = await import('../localDb/schema');
const ledger = await import('../cindy-media/ledger');
const blobs = await import('../cindy-media/blobStore');
const { createStorageIpcHandlers } = await import('../cindy-media/storageIpc');
const migration0071: unknown = await import('../../../drizzle/scripts/0071_bright_ultron');
const OLD = 100 * 60 * 60 * 1000;
let rawDb: Database.Database;
let db: LedgerDb;
let drafts: typeof import('../composerDraftStore');

const stamp = () => ({ dataOwnerId: host.owner, ownerGeneration: host.generation });
const switchOwner = (owner: string) => { host.owner = owner; host.generation++; };
const draftFile = () => path.join(host.root, 'owners',
  createHash('sha256').update(host.owner).digest('hex').slice(0, 20), 'composer-drafts.json');
const content = (url: string): ComposerDraftContent => ({ text: null, attachments: [{
  id: 'synthetic', name: 'synthetic.png', path: '/synthetic/image.png', ext: '.png', size: 12,
  category: 'image', mimeType: 'image/png', url,
}] });
const save = (value: ComposerDraftContent | null) => drafts.saveComposerDraft({ ...stamp(), key: 'same-task', content: value });
const handlers = () => createStorageIpcHandlers({
  db, legacyRootDir: path.join(host.root, 'empty-legacy'),
  getQueueScanTexts: () => [], loadSnapshotPayloads: async () => [],
  getRegisteredDraftUrls: () => drafts.getPersistedComposerDraftUrls(),
});
const cleanup = (hash: string) => handlers().cleanup({
  draftUrls: [], zeroRefHashes: [hash], evictCacheHashes: [], deadDirNames: [], cleanTmpFiles: false,
});

beforeEach(async () => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-composer-media-gc-'));
  host.owner = 'owner-a'; host.generation = 1;
  rawDb = new Database(':memory:'); rawDb.pragma('foreign_keys = ON');
  const migration = fs.readFileSync(path.resolve(__dirname, '../../../drizzle/0070_woozy_harpoon.sql'), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) rawDb.exec(statement);
  const companion = migration0071 && typeof migration0071 === 'object' && 'default' in migration0071
    ? migration0071.default : null;
  if (!companion || typeof companion !== 'object' || !('run' in companion) || typeof companion.run !== 'function') {
    throw new Error('media migration companion is unavailable');
  }
  companion.run(rawDb);
  db = drizzle(rawDb, { schema });
  vi.resetModules(); drafts = await import('../composerDraftStore');
});
afterEach(async () => {
  await drafts.flushComposerDraftWrites();
  vi.restoreAllMocks(); rawDb.close();
  fs.rmSync(host.root, { recursive: true, force: true });
});

async function sharedBlob() {
  const first = await blobs.writeBlob({ buffer: Buffer.from('same synthetic image bytes'), mimeType: 'image/png' });
  await save(content(first.url));
  switchOwner('owner-b');
  const second = await blobs.writeBlob({ buffer: Buffer.from('same synthetic image bytes'), mimeType: 'image/png' });
  expect(second.hash).toBe(first.hash); expect(second.deduplicated).toBe(true);
  // Only owner B's zero-ref ledger is supplied to the ordinary cleanup handler.
  await ledger.recordBlob({ ...second, isCache: false }, db);
  const past = Date.now() - OLD;
  await db.update(schema.mediaBlobs).set({ createdAt: past, lastAccessAt: past })
    .where(eq(schema.mediaBlobs.hash, second.hash)).run();
  await save(content(second.url)); await save(null);
  vi.resetModules(); drafts = await import('../composerDraftStore');
  return second;
}

describe('shared media retained by all durable owner drafts', () => {
  it('keeps A bytes after B clears the same hash and Host restarts; reclaims only after A also clears', async () => {
    const blob = await sharedBlob();
    expect(drafts.loadComposerDraftSnapshot(stamp())?.entries).toEqual([]);
    const scan = await handlers().scan({ draftUrls: [] });
    expect(scan).toMatchObject({ success: true, zeroRef: { count: 0, protectedCount: 1 } });
    expect((await cleanup(blob.hash)).zeroRef).toEqual({ deleted: 0, skipped: 1, freedBytes: 0 });
    expect((await blobs.readFile(blob.url)).buffer.toString()).toBe('same synthetic image bytes');
    switchOwner('owner-a'); await save(null); switchOwner('owner-b');
    vi.resetModules(); drafts = await import('../composerDraftStore');
    expect((await cleanup(blob.hash)).zeroRef).toEqual({ deleted: 1, skipped: 0, freedBytes: blob.bytes });
    await expect(blobs.readFile(blob.url)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['corrupt', 'unreadable-file', 'unreadable-directory', 'incomplete-listing'])(
    'does not unlink shared bytes when the all-owner census is %s', async failure => {
      const blob = await sharedBlob();
      switchOwner('owner-a'); const inactiveFile = draftFile(); switchOwner('owner-b');
      if (failure === 'corrupt') fs.writeFileSync(inactiveFile, '{ private synthetic draft');
      if (failure === 'unreadable-file') vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' });
      });
      if (failure === 'unreadable-directory') vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' });
      });
      if (failure === 'incomplete-listing') vi.spyOn(fs, 'readdirSync').mockReturnValueOnce([]);
      await expect(cleanup(blob.hash)).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(await ledger.getBlobInfo(blob.hash, db)).not.toBeNull();
      expect((await blobs.readFile(blob.url)).buffer.toString()).toBe('same synthetic image bytes');
      if (failure === 'corrupt') expect(fs.readFileSync(inactiveFile, 'utf8')).toBe('{ private synthetic draft');
    },
  );

  it.each([
    { line: 'zero-ref', query: 1 }, { line: 'cache', query: 1 },
    { line: 'zero-ref', query: 2 }, { line: 'cache', query: 2 },
  ])('rechecks a new inactive-owner reference after async $line ledger query $query', async ({ line, query }) => {
    const blob = await sharedBlob();
    switchOwner('owner-a'); await save(null); switchOwner('owner-b');
    if (line === 'cache') await db.update(schema.mediaBlobs).set({ isCache: true }).run();
    const getInfo = ledger.getBlobInfo;
    let queries = 0;
    vi.spyOn(ledger, 'getBlobInfo').mockImplementation(async (hash, database) => {
      const info = await getInfo(hash, database);
      if (++queries === query) {
        switchOwner('owner-a'); await save(content(blob.url)); switchOwner('owner-b');
      }
      return info;
    });
    const result = line === 'zero-ref' ? (await cleanup(blob.hash)).zeroRef :
      (await handlers().cleanup({ draftUrls: [], zeroRefHashes: [], evictCacheHashes: [blob.hash],
        deadDirNames: [], cleanTmpFiles: false })).cacheEvicted;
    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect((await blobs.readFile(blob.url)).buffer.toString()).toBe('same synthetic image bytes');
  });

  it('fails closed when the inactive file becomes unreadable after cleanup collected its snapshot', async () => {
    const blob = await sharedBlob();
    switchOwner('owner-a'); await save(null); const inactiveFile = draftFile(); switchOwner('owner-b');
    const getInfo = ledger.getBlobInfo;
    vi.spyOn(ledger, 'getBlobInfo').mockImplementationOnce(async (hash, database) => {
      const info = await getInfo(hash, database);
      fs.writeFileSync(inactiveFile, '{ truncated synthetic draft');
      return info;
    });
    expect((await cleanup(blob.hash)).zeroRef).toMatchObject({ deleted: 0, skipped: 1 });
    expect(await ledger.getBlobInfo(blob.hash, db)).not.toBeNull();
    expect((await blobs.readFile(blob.url)).buffer.toString()).toBe('same synthetic image bytes');
  });
});
