import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserCommentDraftItem, ComposerDraftContent, ComposerDraftSnapshot, ComposerDraftWrite,
} from '../../../shared/composerDraft';
import type { DataOwnerPushStamp } from '../../../shared/dataOwnerPush';

const disk = new Map<string, Map<string, ComposerDraftContent>>();
let available = true;
const loadSnapshot = vi.fn((stamp: DataOwnerPushStamp): ComposerDraftSnapshot | null => available ? {
  ...stamp, entries: Array.from(disk.get(stamp.dataOwnerId ?? '') ?? [], ([key, content]) => ({ key, content })),
} : null);
const save = vi.fn(async (request: ComposerDraftWrite): Promise<void> => {
  const key = request.dataOwnerId ?? '';
  const entries = disk.get(key) ?? new Map<string, ComposerDraftContent>(); disk.set(key, entries);
  if (request.content) entries.set(request.key, request.content);
  else entries.delete(request.key);
});
const reportDraftUrls = vi.fn();
const text = (value: string): ComposerDraftContent => ({
  text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] },
  attachments: [],
});
async function renderer(ownerId = 'account-a', generation = 1) {
  const owner = await import('../../contexts/dataOwnerGeneration');
  const store = await import('../composerDraftStore');
  owner.setDataOwnerGeneration(ownerId, generation);
  store.setComposerDraftOwner(ownerId);
  return { store, owner };
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); disk.clear(); available = true;
  vi.stubGlobal('window', { electronAPI: { composerDrafts: { loadSnapshot, save },
    cindyMediaStorage: { reportDraftUrls } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('durable composer UI mirror', () => {
  it('restores task text, attachments and browser comments into a fresh renderer without replaying focus/commands', async () => {
    let { store } = await renderer();
    const image = { id: 'image', name: 'image.png', path: '/staged/image.png', ext: '.png', size: 10,
      category: 'image' as const, mimeType: 'image/png', url: 'cindy-media://blob/hash',
      annotationSourceUrl: 'cindy-media://blob/original', cacheUrlShared: true };
    const comment: BrowserCommentDraftItem = {
      id: 'comment', markerNumber: 1, pageUrl: 'https://example.com', comment: 'make this blue', screenshot: image,
      target: { kind: 'element', point: { x: 1, y: 2 }, viewport: { width: 100, height: 100 }, region: null,
        selectedText: null, immediate: false, targetTag: 'button', targetLabel: 'OK', targetRole: 'button',
        targetSelector: '#ok', targetPath: 'body > button', nearbyText: null, themeVariant: 'light',
        designBaseline: null, markerNumber: 1 },
    };
    store.saveDraft('original-task', { ...text('unsent original task'), attachments: [image], browserComments: [comment],
      focusAtEnd: true, pendingGhostId: 'one-shot', pendingHostCapabilityGhostId: 'capability' });
    expect(save).toHaveBeenCalledTimes(1);
    vi.resetModules(); ({ store } = await renderer());
    expect(store.getDraft('original-task')).toEqual({ ...text('unsent original task'), attachments: [image], browserComments: [comment] });
    expect(store.getDraftPresence('original-task')).toBe(true);
    expect(store.getAllDraftAttachmentUrls()).toEqual(['cindy-media://blob/hash', 'cindy-media://blob/original']);
    expect(save).toHaveBeenCalledTimes(1); // restoration itself never sends/saves
  });

  it('loads before editor hydration, then never overwrites a newer edit with the old snapshot', async () => {
    disk.set('account-a', new Map([['task', text('older on disk')]]));
    const { store } = await renderer();
    expect(store.getDraft('task')).toEqual(text('older on disk'));
    store.saveDraft('task', text('new user edit'), { silent: true });
    store.setComposerDraftOwner('account-a');
    expect(store.getDraft('task')).toEqual(text('new user edit'));
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it('protects edits and explicit clears made before a failed bootstrap read becomes available', async () => {
    available = false;
    disk.set('account-a', new Map([['task', text('stale')], ['cleared', text('stale cleared')], ['other', text('restore')]]));
    const { store } = await renderer();
    store.saveDraft('task', text('newer')); store.clearDraft('cleared');
    // Simulate an older read result still present in Main/another window.
    disk.get('account-a')?.set('task', text('stale'));
    disk.get('account-a')?.set('cleared', text('stale cleared'));
    available = true;
    expect(store.getDraft('task')).toEqual(text('newer'));
    expect(store.getDraft('cleared')).toBeUndefined();
    expect(store.getDraft('other')).toEqual(text('restore'));
  });

  it('keeps accounts and task keys separate while same-owner generation bumps keep saving', async () => {
    disk.set('account-a', new Map([['same-task', text('A')]]));
    disk.set('account-b', new Map([['same-task', text('B')]]));
    const { store, owner } = await renderer();
    expect(store.getDraft('same-task')).toEqual(text('A'));
    owner.setDataOwnerGeneration('account-b', 2); store.setComposerDraftOwner('account-b');
    expect(store.getDraft('same-task')).toEqual(text('B'));
    expect(store.getDraft('different-task')).toBeUndefined();
    owner.setDataOwnerGeneration('account-b', 3); store.setComposerDraftOwner('account-b');
    store.saveDraft('same-task', text('new B'));
    expect(save).toHaveBeenLastCalledWith({ dataOwnerId: 'account-b', ownerGeneration: 3, key: 'same-task', content: { ...text('new B'), browserComments: undefined } });
    owner.setDataOwnerGeneration('account-a', 4); store.setComposerDraftOwner('account-a');
    expect(store.getDraft('same-task')).toEqual(text('A'));
    owner.setDataOwnerGeneration(null, 5); store.setComposerDraftOwner(null);
    store.saveDraft('same-task', text('signed out'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('persists send/discard removal and synchronously empties mounted composers to prevent unmount resurrection', async () => {
    let { store } = await renderer();
    store.saveDraft('sent', text('send once'));
    store.saveDraft('discard', text('discard this'));
    store.saveDraft('keep', text('keep editing'));
    let mounted = store.getDraft('discard');
    store.subscribeDraft('discard', () => { mounted = store.getDraft('discard'); });
    store.clearDraft('sent'); store.discardDraft('discard');
    expect(mounted).toEqual({ text: null, attachments: [] });
    expect(save.mock.calls.slice(-2).map(([request]) => [request.key, request.content])).toEqual([['sent', null], ['discard', null]]);
    vi.resetModules(); ({ store } = await renderer());
    expect(store.getDraft('sent')).toBeUndefined(); expect(store.getDraft('discard')).toBeUndefined();
    expect(store.getDraft('keep')).toEqual({ ...text('keep editing'), browserComments: undefined });
  });
});
