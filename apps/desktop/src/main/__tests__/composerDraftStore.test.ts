import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDraftContent, ComposerDraftWrite } from '../../shared/composerDraft';

const harness = vi.hoisted(() => ({
  root: '', owner: 'account-a' as string | null, generation: 1, boundary: false, trusted: true,
  gate: null as Promise<void> | null, releaseGate: null as (() => void) | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  warn: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => harness.root }, ipcMain: {
  handle: (name: string, callback: (...args: unknown[]) => unknown) => harness.handlers.set(name, callback),
  on: (name: string, callback: (...args: unknown[]) => unknown) => harness.listeners.set(name, callback),
} }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${harness.owner}:${harness.generation}`,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: harness.owner, ownerGeneration: harness.generation }),
  isAppSessionBoundaryPending: () => harness.boundary,
  ownerScopedUserDataPath: (...parts: string[]) => harness.owner
    ? path.join(harness.root, 'owners', createHash('sha256').update(harness.owner).digest('hex').slice(0, 20), ...parts)
    : path.join(harness.root, 'signed-out', ...parts),
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: harness.warn }) }));
vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => { if (!harness.trusted) throw new Error('untrusted renderer'); },
}));
// The existing override-file tests exercise the cross-process lock. Here the
// seam lets an account transition happen precisely during lock acquisition.
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_file: string, _options: unknown, callback: (status: { held: true }) => unknown) => {
    if (harness.gate) await harness.gate;
    return callback({ held: true });
  },
}));

const content = (value: string): ComposerDraftContent => ({
  text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] },
  attachments: [],
});
const stamp = () => ({ dataOwnerId: harness.owner, ownerGeneration: harness.generation });
const write = (key: string, value: ComposerDraftContent | null): ComposerDraftWrite => ({ ...stamp(), key, content: value });
const ownerRoot = (owner = harness.owner ?? 'signed-out') => path.join(harness.root, 'owners',
  createHash('sha256').update(owner).digest('hex').slice(0, 20));
const file = () => path.join(ownerRoot(), 'composer-drafts.json');
type MainStore = typeof import('../composerDraftStore');
let store: MainStore;
beforeEach(async () => {
  vi.resetModules();
  harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-composer-drafts-'));
  harness.owner = 'account-a'; harness.generation = 1; harness.boundary = false; harness.trusted = true;
  harness.gate = null; harness.releaseGate = null; harness.warn.mockClear(); harness.handlers.clear(); harness.listeners.clear();
  store = await import('../composerDraftStore');
});
afterEach(async () => {
  harness.releaseGate?.();
  await store.flushComposerDraftWrites();
  vi.restoreAllMocks();
  fs.rmSync(harness.root, { recursive: true, force: true });
});

describe('Main-owned durable composer drafts', () => {
  it('restores two original task drafts after the process-local store is recreated', async () => {
    await store.saveComposerDraft(write('original-task', content('unsent input')));
    await store.saveComposerDraft(write('__new_maker_draft__', content('new task input')));
    vi.resetModules();
    store = await import('../composerDraftStore');
    expect(store.loadComposerDraftSnapshot(stamp())?.entries).toEqual([
      { key: 'original-task', content: content('unsent input') },
      { key: '__new_maker_draft__', content: content('new task input') },
    ]);
  });

  it('isolates the same task key by verified account and rejects stale/signed-out/boundary access', async () => {
    const accountA = stamp();
    await store.saveComposerDraft(write('same-task', content('account A')));
    harness.owner = 'account-b'; harness.generation++;
    expect(store.loadComposerDraftSnapshot(accountA)).toBeNull();
    expect(() => store.saveComposerDraft({ ...accountA, key: 'same-task', content: null })).toThrow();
    expect(store.loadComposerDraftSnapshot(stamp())?.entries).toEqual([]);
    await store.saveComposerDraft(write('same-task', content('account B')));
    harness.owner = 'account-a'; harness.generation++;
    expect(store.loadComposerDraftSnapshot(stamp())?.entries[0].content).toEqual(content('account A'));
    harness.boundary = true;
    expect(store.loadComposerDraftSnapshot(stamp())).toBeNull();
    expect(() => store.saveComposerDraft(write('same-task', null))).toThrow();
    harness.boundary = false; harness.owner = null; harness.generation++;
    expect(store.loadComposerDraftSnapshot(stamp())).toBeNull();
    expect(() => store.saveComposerDraft(write('same-task', content('signed out')))).toThrow();
    expect(fs.existsSync(path.join(harness.root, 'signed-out'))).toBe(false);
  });

  it('orders save then clear without resurrecting sent input or clearing another task', async () => {
    await store.saveComposerDraft(write('other-task', content('keep')));
    const saving = store.saveComposerDraft(write('sent-task', content('already sent')));
    const clearing = store.saveComposerDraft(write('sent-task', null));
    expect(store.loadComposerDraftSnapshot(stamp())?.entries.map(entry => entry.key)).toEqual(['other-task']);
    await Promise.all([saving, clearing]);
    vi.resetModules(); store = await import('../composerDraftStore');
    expect(store.loadComposerDraftSnapshot(stamp())?.entries).toEqual([{ key: 'other-task', content: content('keep') }]);
  });

  it('shows an accepted pending edit to a reloading renderer before the disk write settles', async () => {
    let release!: () => void;
    harness.gate = new Promise<void>(resolve => { release = resolve; harness.releaseGate = resolve; });
    const saving = store.saveComposerDraft(write('task', content('latest edit')));
    expect(store.loadComposerDraftSnapshot(stamp())?.entries[0].content).toEqual(content('latest edit'));
    release(); await saving;
  });

  it('does not write either account after the owner changes while acquiring the file lock', async () => {
    let release!: () => void;
    harness.gate = new Promise<void>(resolve => { release = resolve; harness.releaseGate = resolve; });
    const saving = store.saveComposerDraft(write('task', content('old owner edit')));
    const rejected = expect(saving).rejects.toMatchObject({ code: 'INTERNAL' });
    await Promise.resolve(); await Promise.resolve();
    harness.owner = 'account-b'; harness.generation++;
    release(); await rejected;
    expect(fs.existsSync(path.join(ownerRoot('account-a'), 'composer-drafts.json'))).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('preserves corrupt storage and refuses writes and media cleanup without logging the contents', async () => {
    const raw = '{ private unsent message and attachment path';
    fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), raw);
    expect(store.loadComposerDraftSnapshot(stamp())).toBeNull();
    await expect(store.saveComposerDraft(write('task', content('new edit')))).rejects.toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe(raw);
    expect(() => store.getPersistedComposerDraftUrls()).toThrow();
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain('private unsent');
  });

  it('protects durable attachments and annotations until an atomic clear actually finishes', async () => {
    const draft: ComposerDraftContent = { ...content('with image'), attachments: [{
      id: 'image', name: 'image.png', path: '/staged/image.png', ext: '.png', size: 10,
      category: 'image', mimeType: 'image/png', url: 'cindy-media://blob/hash',
      annotationSourceUrl: 'cindy-media://blob/original', annotationStrokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
    }] };
    await store.saveComposerDraft(write('task', draft));
    vi.resetModules(); store = await import('../composerDraftStore');
    expect(store.getPersistedComposerDraftUrls()).toEqual(['cindy-media://blob/hash', 'cindy-media://blob/original']);
    let release!: () => void;
    harness.gate = new Promise<void>(resolve => { release = resolve; harness.releaseGate = resolve; });
    const clearing = store.saveComposerDraft(write('task', null));
    expect(store.getPersistedComposerDraftUrls()).toHaveLength(2);
    release(); await clearing;
    expect(store.getPersistedComposerDraftUrls()).toEqual([]);
  });

  it('strips one-shot handoff/focus intents and rejects malformed or cyclic draft input', async () => {
    await store.saveComposerDraft({ ...write('task', content('keep')), content: {
      ...content('keep'), focusAtEnd: true, pendingGhostId: 'do-not-replay',
    } });
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('do-not-replay');
    expect(() => store.saveComposerDraft({ ...write('task', null), content: { text: {}, attachments: [{}] } })).toThrow();
    const cyclic: { type: string; content?: unknown[] } = { type: 'doc' }; cyclic.content = [cyclic];
    expect(() => store.saveComposerDraft({ ...write('task', null), content: { text: cyclic, attachments: [] } })).toThrow();
    expect(() => store.saveComposerDraft(write('task', content('x'.repeat(8 * 1024 * 1024 + 1))))).toThrow();
    expect(store.loadComposerDraftSnapshot(stamp())?.entries[0].content).toEqual(content('keep'));
  });

  it('retains browser comment screenshots through disk validation and the existing live-reference collector', async () => {
    const draft: ComposerDraftContent = { ...content('page feedback'), browserComments: [{
      id: 'comment', markerNumber: 1, pageUrl: 'https://example.com', comment: 'use blue',
      screenshot: { id: 'screenshot', name: 'page.png', path: '/staged/page.png', ext: '.png', size: 12,
        category: 'image', mimeType: 'image/png', url: 'cindy-media://blob/page' },
      target: { kind: 'element', point: { x: 1, y: 2 }, viewport: { width: 100, height: 100 },
        region: null, selectedText: null, immediate: false, targetTag: 'button', targetLabel: 'OK',
        targetRole: 'button', targetSelector: '#ok', targetPath: 'body > button', nearbyText: null,
        themeVariant: 'light', designBaseline: null, markerNumber: 1 },
      styleChanges: [{ property: 'color', previousValue: 'red', value: 'blue' }],
    }] };
    await store.saveComposerDraft(write('task', draft));
    vi.resetModules(); store = await import('../composerDraftStore');
    expect(store.loadComposerDraftSnapshot(stamp())?.entries[0].content).toEqual(draft);
    expect(store.getPersistedComposerDraftUrls()).toEqual(['cindy-media://blob/page']);
  });

  it('guards both IPC routes with the trusted top-level app renderer check', async () => {
    store.registerComposerDraftIpc();
    const event: { returnValue?: unknown } = {};
    harness.listeners.get('composer-drafts:load-sync')?.(event, stamp());
    expect(event.returnValue).toMatchObject({ ...stamp(), entries: [] });
    harness.trusted = false;
    expect(() => harness.listeners.get('composer-drafts:load-sync')?.({}, stamp())).toThrow('untrusted');
    expect(() => harness.handlers.get('composer-drafts:save')?.({}, write('task', content('denied')))).toThrow('untrusted');
    expect(fs.existsSync(file())).toBe(false);
  });

  it('retains inactive-owner media after a fresh Host while keeping its draft private', async () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const draft: ComposerDraftContent = { ...content('private A'), attachments: [{
      id: 'image', name: 'image.png', path: '/synthetic/image.png', ext: '.png', size: 10,
      category: 'image', mimeType: 'image/png', url,
    }] };
    await store.saveComposerDraft(write('same-task', draft));
    harness.owner = 'account-b'; harness.generation++;
    await store.saveComposerDraft(write('same-task', draft));
    await store.saveComposerDraft(write('same-task', null));
    vi.resetModules(); store = await import('../composerDraftStore');
    expect(store.loadComposerDraftSnapshot(stamp())?.entries).toEqual([]);
    expect(store.getPersistedComposerDraftUrls()).toContain(url);
    harness.owner = 'account-a'; harness.generation++;
    await store.saveComposerDraft(write('same-task', null));
    expect(store.getPersistedComposerDraftUrls()).toEqual([]);
  });

  it('protects every pending addition across owner changes, including superseded saves before a clear', async () => {
    const image = (marker: string): ComposerDraftContent => ({ ...content(marker), attachments: [{
      id: marker, name: 'image.png', path: '/synthetic/image.png', ext: '.png', size: 10,
      category: 'image', mimeType: 'image/png', url: 'cindy-media://blobs/' + marker.repeat(64) + '.png',
    }] });
    await store.saveComposerDraft(write('task', image('a')));
    let release!: () => void;
    harness.gate = new Promise<void>(resolve => { release = resolve; harness.releaseGate = resolve; });
    const outcomes = Promise.allSettled([
      store.saveComposerDraft(write('task', image('b'))),
      store.saveComposerDraft(write('task', image('c'))),
      store.saveComposerDraft(write('task', null)),
    ]);
    await Promise.resolve(); await Promise.resolve();
    harness.owner = 'account-b'; harness.generation++;
    expect(new Set(store.getPersistedComposerDraftUrls())).toEqual(new Set(['a', 'b', 'c'].map(
      marker => 'cindy-media://blobs/' + marker.repeat(64) + '.png')));
    release();
    expect((await outcomes).every(outcome => outcome.status === 'rejected')).toBe(true);
    expect(store.getPersistedComposerDraftUrls()).toEqual(['cindy-media://blobs/' + 'a'.repeat(64) + '.png']);
  });

  it('distinguishes an absent owner/draft file from an invalid namespace and partial enumeration', () => {
    expect(store.getPersistedComposerDraftUrls()).toEqual([]);
    fs.mkdirSync(ownerRoot(), { recursive: true });
    expect(store.getPersistedComposerDraftUrls()).toEqual([]);
    fs.writeFileSync(file(), JSON.stringify({ entries: [] }));
    // Simulate a namespace entry discovered only after the first listing.
    vi.spyOn(fs, 'readdirSync').mockReturnValueOnce([]);
    expect(() => store.getPersistedComposerDraftUrls()).toThrow();
  });

  it('rejects a census when an earlier owner publishes during a later owner read', async () => {
    await store.saveComposerDraft(write('task', content('first owner')));
    harness.owner = 'account-b'; harness.generation++;
    await store.saveComposerDraft(write('task', content('second owner')));
    const root = path.join(harness.root, 'owners');
    const files = fs.readdirSync(root).sort().map(name => path.join(root, name, 'composer-drafts.json'));
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      if (target === files[1]) {
        // The other Host's lock and temp file have already disappeared by the
        // final census check; its completed atomic publish changed the directory.
        fs.writeFileSync(files[0] + '.tmp', JSON.stringify({ entries: [] }));
        fs.renameSync(files[0] + '.tmp', files[0]);
      }
      return open(target, flags, mode);
    });
    expect(() => store.getPersistedComposerDraftUrls()).toThrow();
  });

  it.each(['.lock', '.tmp'])('refuses cleanup while an atomic writer artifact %s exists', (suffix) => {
    fs.mkdirSync(ownerRoot(), { recursive: true });
    fs.writeFileSync(file() + suffix, 'synthetic writer');
    expect(() => store.getPersistedComposerDraftUrls()).toThrow();
    expect(fs.readFileSync(file() + suffix, 'utf8')).toBe('synthetic writer');
  });

  it.each(['root-file', 'owner-file', 'unknown-owner-directory', 'oversized-file', 'incomplete-file'])(
    'does not treat %s as a complete empty census', failure => {
      if (failure === 'root-file') fs.writeFileSync(path.join(harness.root, 'owners'), 'synthetic invalid root');
      else {
        fs.mkdirSync(path.join(harness.root, 'owners'));
        if (failure === 'owner-file') fs.writeFileSync(ownerRoot(), 'synthetic invalid owner');
        if (failure === 'unknown-owner-directory') fs.mkdirSync(path.join(harness.root, 'owners', 'unrecognized'));
        if (failure === 'incomplete-file') { fs.mkdirSync(ownerRoot()); fs.writeFileSync(file(), '{}'); }
        if (failure === 'oversized-file') {
          fs.mkdirSync(ownerRoot()); fs.writeFileSync(file(), '');
          fs.truncateSync(file(), 32 * 1024 * 1024 + 1);
        }
      }
      expect(() => store.getPersistedComposerDraftUrls()).toThrow();
    },
  );
});
