import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNativeHistoryJournal, nativeHistoryStartupTarget, nativeHistoryConfiguration, nativeHistoryRouteReference } from '../nativeHistoryJournal.js';

describe('durable native history operation identity', () => {
  it.each([
    { providerId: 'other-route' }, { effort: 'low' }, { permissionMode: 'bypassPermissions' }, { fastMode: true },
    { routeReference: 'changed-route-or-credential-reference' },
  ])('rejects changed restart configuration before opening any executor: %j', async patch => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-config-'));
    const settings = { providerId: 'route', effort: 'high', permissionMode: 'ask', fastMode: false };
    const identity = { sessionId: 'task', nativeId: path.join(root, 'source.jsonl'), agentKind: 'pi', workingDir: root, model: 'exact',
      configuration: nativeHistoryConfiguration(settings) };
    try {
      createNativeHistoryJournal(root, identity).begin('entry', 'draft');
      expect(() => nativeHistoryStartupTarget(root, { ...identity, configuration: nativeHistoryConfiguration({ ...settings, ...patch }) }))
        .toThrow('identity changed');
      expect(nativeHistoryStartupTarget(root, identity)).toMatchObject({ pending: true, target: identity.nativeId });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('binds same-provider endpoint/protocol/credential references without retaining secret values', () => {
    const route = { upstream: 'https://example.invalid', authStrategy: 'api-key-header' as const,
      wireProtocol: 'anthropic-messages' as const, channelCredential: { channelId: 'channel-one', protocol: 'anthropic-messages' as const } };
    const original = nativeHistoryRouteReference(route);
    for (const patch of [{ upstream: 'https://other.invalid' }, { requestPath: '/other' },
      { channelCredential: { ...route.channelCredential, channelId: 'channel-two' } }, { authStrategy: 'none' as const }]) {
      expect(nativeHistoryRouteReference({ ...route, ...patch })).not.toBe(original);
    }
    expect(nativeHistoryRouteReference({ ...route, headerOverride: { authorization: 'fixture-secret-never-retained' } })).toBe(original);
    expect(nativeHistoryConfiguration({ routeReference: original })).not.toContain('fixture-secret');
  });
  it('blocks source startup after unknown mutation and resumes only the durably observed target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-target-'));
    const identity = { sessionId: 'task', nativeId: path.join(root, 'source.jsonl'), agentKind: 'omp', workingDir: root, model: 'exact' };
    try {
      const journal = createNativeHistoryJournal(root, identity);
      const pending = journal.replace(journal.begin('entry', 'unsent'));
      expect(() => nativeHistoryStartupTarget(root, identity)).toThrow('outcome is unknown');
      const target = path.join(root, 'target.jsonl');
      journal.replace(pending, target);
      expect(nativeHistoryStartupTarget(root, identity)).toEqual({ source: identity.nativeId, target, pending: true });
      expect(createNativeHistoryJournal(root, { ...identity, nativeId: target }).read()).toMatchObject({ nativeId: identity.nativeId, targetNativeId: target });
      expect(() => journal.replace(pending, path.join(root, 'unrelated.jsonl'))).toThrow('target');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recovers the same unfinished operation after a new store instance and keeps owners separate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-journal-'));
    const identity = { sessionId: 'task', nativeId: '/history/original.jsonl', agentKind: 'pi', workingDir: '/project', model: 'exact-model' };
    try {
      const first = createNativeHistoryJournal(path.join(root, 'owner-a'), identity);
      const pending = first.begin('entry', 'original terminal draft');
      first.recordResult(pending, { draftText: 'selected row draft' });
      const reopened = createNativeHistoryJournal(path.join(root, 'owner-a'), identity);
      expect(reopened.read()).toMatchObject({ operationId: pending.operationId, nativeDraft: 'original terminal draft', draftText: 'selected row draft' });
      expect(reopened.begin('entry').operationId).toBe(pending.operationId);
      expect(() => reopened.begin('other-entry')).toThrow('unfinished');
      expect(createNativeHistoryJournal(path.join(root, 'owner-b'), identity).read()).toBeNull();
      expect(() => createNativeHistoryJournal(path.join(root, 'owner-a'), { ...identity, nativeId: '/different' }).read()).toThrow('identity changed');
      reopened.complete(pending);
      expect(createNativeHistoryJournal(path.join(root, 'owner-a'), identity).read()).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves cancellation and refuses stale completion after a newer operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-journal-'));
    const identity = { sessionId: 'task', nativeId: '/history', agentKind: 'pi', workingDir: '/project', model: 'model' };
    try {
      const journal = createNativeHistoryJournal(root, identity), first = journal.begin('one');
      journal.recordResult(first, { cancelled: true, draftText: 'not a new draft' });
      expect(journal.read()).toMatchObject({ cancelled: true }); expect(journal.read()?.draftText).toBeUndefined();
      journal.complete(first);
      expect(() => journal.recordResult(first, { draftText: 'late reply' })).toThrow('operation changed');
      expect(journal.read()).toBeNull();
      journal.begin('two');
      expect(() => journal.recordResult(first, { cancelled: true })).toThrow('operation changed');
      expect(() => journal.complete(first)).toThrow('operation changed');
      expect(journal.read()?.entryId).toBe('two');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
