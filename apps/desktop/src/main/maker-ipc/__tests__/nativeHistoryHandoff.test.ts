import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Session, type AgentSessionHandle } from '@cindy/maker-core';
import { createNativeHistoryHandoff } from '../nativeHistoryHandoff.js';
import { withNativeHistoryOperation } from '../nativeHistoryOperation.js';

const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
function executor() {
  const state = { tree: { roots: [], leafId: 'actual', activePathIds: [] }, messages: [], contextTokens: 19, contextWindow: 100 };
  const navigate = vi.fn(async () => ({ ...state, draftText: 'selected text' }));
  const read = vi.fn(async () => state), restoreDraft = vi.fn(async () => {});
  const handle: AgentSessionHandle = {
    id: '/original-native-history', agentKind: 'pi', model: 'model',
    send: vi.fn(async () => {}), steer: vi.fn(async () => {}), abort: vi.fn(async () => {}), close: vi.fn(async () => {}),
    events: async function* () {}, setInteractionResolver() {}, isTurnRunning: () => false,
    navigateSessionTree: navigate, readSessionTree: read,
    readNativeEditorDraft: async () => 'unsent terminal text', restoreNativeEditorDraft: restoreDraft,
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 19, contextWindow: 100, costUsd: 0 }),
  };
  const session = new Session({ id: 'task', agentKind: 'pi', workDir: '.', handle, logger, turnStallMs: 0,
    capabilities: { sessionTree: { supported: true } } as never });
  return { session, handle, navigate, read, restoreDraft };
}

describe('native history restart reconciliation', () => {
  it('keeps input frozen when route or permissions change before projection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-route-race-'));
    const f = executor();
    let configuration = 'original-route-and-ask';
    f.navigate.mockImplementationOnce(async () => { configuration = 'changed-route-or-permission'; return { ...await f.read(), draftText: 'selected text' }; });
    const persist = vi.fn(async () => true);
    try {
      const handoff = createNativeHistoryHandoff({ root, session: f.session, assertCurrent() {}, persist,
        configuration: () => configuration, exclusive: operation => withNativeHistoryOperation(root, 'task', operation) });
      await expect(handoff.navigate('chosen', {})).rejects.toThrow('configuration changed');
      expect(persist).not.toHaveBeenCalled(); expect(f.navigate).toHaveBeenCalledOnce();
      expect(handoff.pending).toBe(true); expect(f.session.isTurnRunning()).toBe(true);
      await expect(handoff.recover()).rejects.toThrow('configuration changed');
      expect(f.navigate).toHaveBeenCalledOnce();
    } finally { await f.session.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('restores original editor and usage into a new Session from disk after projection failure without replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-restart-'));
    const old = executor(), fresh = executor();
    try {
      const original = createNativeHistoryHandoff({ root, session: old.session, assertCurrent() {},
        exclusive: operation => withNativeHistoryOperation(root, 'task', operation),
        persist: async () => { throw new Error('projection unavailable'); } });
      await expect(original.navigate('chosen', {})).rejects.toThrow('projection unavailable');
      expect(old.navigate).toHaveBeenCalledOnce();
      await old.session.close();
      const persist = vi.fn(async result => {
        expect(fresh.session.isTurnRunning()).toBe(true);
        expect(fresh.restoreDraft).toHaveBeenCalledWith('unsent terminal text');
        return result.contextTokens;
      });
      const restored = createNativeHistoryHandoff({ root, session: fresh.session, assertCurrent() {}, persist,
        exclusive: operation => withNativeHistoryOperation(root, 'task', operation) });
      expect(fresh.session.isTurnRunning()).toBe(true);
      await expect(fresh.session.send('no implicit send')).rejects.toThrow();
      expect(await restored.recover()).toMatchObject({ result: { draftText: 'selected text' }, persisted: 19 });
      expect(fresh.read).toHaveBeenCalledOnce(); expect(fresh.navigate).not.toHaveBeenCalled();
      expect(fresh.handle.send).not.toHaveBeenCalled(); expect(fresh.session.isTurnRunning()).toBe(false);
      expect(await restored.recover()).toBeNull();
      // Completion is durable: reopening the controller does not resurrect it.
      expect(await createNativeHistoryHandoff({ root, session: fresh.session, assertCurrent() {}, persist,
        exclusive: operation => withNativeHistoryOperation(root, 'task', operation) }).recover()).toBeNull();
    } finally { await old.session.close(); await fresh.session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('never persists a readback or releases recovery input after the owner changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-owner-'));
    const old = executor(), fresh = executor();
    try {
      await expect(createNativeHistoryHandoff({ root, session: old.session, assertCurrent() {},
        exclusive: operation => withNativeHistoryOperation(root, 'task', operation),
        persist: async () => { throw new Error('offline'); } }).navigate('chosen', {})).rejects.toThrow('offline');
      await old.session.close();
      let current = true;
      fresh.restoreDraft.mockImplementationOnce(async () => { current = false; });
      const persist = vi.fn(async () => true);
      const restored = createNativeHistoryHandoff({ root, session: fresh.session,
        exclusive: operation => withNativeHistoryOperation(root, 'task', operation),
        assertCurrent() { if (!current) throw new Error('owner changed'); }, persist });
      await expect(restored.recover()).rejects.toThrow('owner changed');
      expect(persist).not.toHaveBeenCalled(); expect(fresh.read).not.toHaveBeenCalled();
      expect(fresh.session.isTurnRunning()).toBe(true); expect(fresh.navigate).not.toHaveBeenCalled();
    } finally { await old.session.close(); await fresh.session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a competing controller before mutation and never adopts its pending checkpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-contender-'));
    const first = executor(), second = executor();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const persist = vi.fn(async () => { await wait; throw new Error('projection failed'); });
    const a = createNativeHistoryHandoff({ root, session: first.session, assertCurrent() {}, persist,
      exclusive: operation => withNativeHistoryOperation(root, 'task', operation) });
    const b = createNativeHistoryHandoff({ root, session: second.session, assertCurrent() {}, persist: async () => true,
      exclusive: operation => withNativeHistoryOperation(path.join(root, '.'), 'task', operation) });
    const running = a.navigate('entry', {});
    const failure = expect(running).rejects.toThrow('projection failed');
    try {
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      await expect(b.navigate('entry', {})).rejects.toThrow('busy');
      expect(second.navigate).not.toHaveBeenCalled();
      release(); await failure;
      await expect(b.navigate('entry', {})).rejects.toThrow('checkpoint changed');
      expect(second.navigate).not.toHaveBeenCalled();
      expect(first.navigate).toHaveBeenCalledOnce();
    } finally { release(); await failure; await first.session.close(); await second.session.close(); await rm(root, { recursive: true, force: true }); }
  });
});
