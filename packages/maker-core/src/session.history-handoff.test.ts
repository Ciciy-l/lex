import { describe, expect, it, vi } from 'vitest';
import { Session } from './session.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import { AgentPresentationRuntime } from './agents/presentation.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentEvent } from './types/events.js';

const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
function fixture() {
  const queue = createAsyncQueue<AgentEvent>();
  const driver = { write: vi.fn(), resize: vi.fn(), onData: () => () => {}, onExit: () => () => {}, close() {} };
  const presentation = new AgentPresentationRuntime('native-file', driver);
  const state = { tree: { roots: [], leafId: 'actual', activePathIds: [] }, messages: [], contextTokens: 17, contextWindow: 100 };
  const navigate = vi.fn(async () => ({ ...state, draftText: 'selected draft' }));
  const read = vi.fn(async () => state);
  const handle: AgentSessionHandle = { id: 'native-file', agentKind: 'pi', model: 'model', presentation,
    send: vi.fn(async () => {}), steer: vi.fn(async () => {}), abort: vi.fn(async () => {}), isTurnRunning: () => false,
    events: () => queue, close: async () => { queue.end(); await presentation.close(); },
    navigateSessionTree: navigate, readSessionTree: read, setInteractionResolver() {},
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 17, contextWindow: 100, costUsd: 0 }),
  };
  const session = new Session({ id: 'task', agentKind: 'pi', workDir: '.', handle, logger, turnStallMs: 0,
    capabilities: { sessionTree: { supported: true }, switchModel: { supported: true }, effort: { supported: true } } as never });
  return { session, presentation, handle, navigate, read, state };
}
describe('native history and Host projection handoff', () => {
  it.each(['setModel', 'setEffort'] as const)('refuses history mutation while an earlier %s is unresolved', async setting => {
    const f = fixture(); let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.handle.setModel = vi.fn(() => pending); f.handle.setEffort = vi.fn(() => pending);
    try {
      const change = setting === 'setModel' ? f.session.setModel('new-model') : f.session.setEffort('high');
      await expect(f.session.navigateSessionTreeAndPersist('selected', {}, async () => true)).rejects.toThrow();
      expect(f.navigate).not.toHaveBeenCalled(); finish(); await change;
      await f.session.navigateSessionTreeAndPersist('selected', {}, async () => true);
      expect(f.navigate).toHaveBeenCalledOnce();
    } finally { finish(); await f.session.close(); }
  });
  it('blocks configuration drift after native success while Host persistence is still pending', async () => {
    const f = fixture();
    f.handle.setModel = vi.fn(); f.handle.setEffort = vi.fn(); f.handle.setPermissionMode = vi.fn();
    try {
      await expect(f.session.navigateSessionTreeAndPersist('selected', {}, async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
      await expect(f.session.setModel('different')).rejects.toThrow('HISTORY_RECOVERY_PENDING');
      await expect(f.session.setEffort('high')).rejects.toThrow('HISTORY_RECOVERY_PENDING');
      await expect(f.session.setPermissionModeTracked('ask')).rejects.toThrow('HISTORY_RECOVERY_PENDING');
      expect(f.handle.setModel).not.toHaveBeenCalled(); expect(f.handle.setEffort).not.toHaveBeenCalled(); expect(f.handle.setPermissionMode).not.toHaveBeenCalled();
      await f.session.navigateSessionTreeAndPersist('selected', {}, async () => true);
      expect(f.navigate).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce();
    } finally { await f.session.close(); }
  });
  it('persists a confirmed replacement with its source and holds the new presentation through a failed projection', async () => {
    const f = fixture();
    let nativeId = 'native-file'; Object.defineProperty(f.handle, 'id', { get: () => nativeId });
    const next = new AgentPresentationRuntime('new-file', { write() {}, resize() {}, close() {}, onData: () => () => {}, onExit: () => () => {} });
    const checkpoint = { beforeNavigate: vi.fn(async () => {}), afterNavigate: vi.fn(async () => {}),
      beforeReplacement: vi.fn(async () => {}), target: vi.fn(async (_id: string) => {}) };
    f.handle.navigateSessionTree = vi.fn(async (_entry, _options, handoff) => {
      await handoff!.beforeReplacement(); await handoff!.target('new-file');
      handoff!.holdInput(next.suspendInput()); nativeId = 'new-file'; return f.state;
    });
    try {
      await expect(f.session.navigateSessionTreeAndPersist('chosen', {}, async () => { throw new Error('projection unavailable'); }, checkpoint)).rejects.toThrow('projection unavailable');
      const view = next.attach('new-view', () => {}); expect(view.acquireControl()).toBeNull();
      const result = await f.session.navigateSessionTreeAndPersist('chosen', {}, async result => result, checkpoint);
      expect(result.result.nativeIdentity).toEqual({ source: 'native-file', target: 'new-file' });
      expect(f.handle.navigateSessionTree).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce();
      expect(view.acquireControl()).not.toBeNull(); expect(f.handle.send).not.toHaveBeenCalled();
    } finally { await f.session.close(); await next.close(); }
  });
  it('revokes both controllers through persistence and reads back after failure without repeating the mutation', async () => {
    const f = fixture();
    const first = f.presentation.attach('first', () => {}), second = f.presentation.attach('second', () => {});
    const old = first.acquireControl()!;
    const persist = vi.fn(async () => {
      expect(first.acquireControl()).toBeNull(); expect(second.acquireControl(true)).toBeNull();
      await expect(f.session.send('racing input')).rejects.toThrow();
      throw new Error('database unavailable');
    });
    try {
      await expect(f.session.navigateSessionTreeAndPersist('selected', {}, persist)).rejects.toThrow('database unavailable');
      expect(first.acquireControl()).toBeNull();
      expect(() => first.write(old, 1, 'old lease')).toThrow();
      const commit = vi.fn(async result => { expect(result.tree.leafId).toBe('actual'); return 'committed'; });
      expect(await f.session.navigateSessionTreeAndPersist('selected', {}, commit)).toMatchObject({ persisted: 'committed', result: { draftText: 'selected draft' } });
      expect(f.navigate).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce();
      expect(second.acquireControl()).not.toBeNull(); expect(f.handle.send).not.toHaveBeenCalled();
    } finally { await f.session.close(); }
  });
  it('reconciles a failed native operation from actual readback without blindly navigating back', async () => {
    const f = fixture(); f.navigate.mockRejectedValueOnce(new Error('native outcome unknown'));
    const persist = vi.fn(async () => true);
    try {
      await expect(f.session.navigateSessionTreeAndPersist('selected', {}, persist)).rejects.toThrow('native outcome unknown');
      expect(persist).toHaveBeenCalledWith(f.state); expect(f.navigate).toHaveBeenCalledOnce();
      expect(f.session.isTurnRunning()).toBe(false);
    } finally { await f.session.close(); }
  });
  it('retains native cancellation across a failed projection without restoring the selected draft', async () => {
    const f = fixture();
    f.navigate.mockResolvedValueOnce({ ...f.state, draftText: 'must not replace the editor', cancelled: true } as never);
    try {
      await expect(f.session.navigateSessionTreeAndPersist('selected', {}, async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
      const recovered = await f.session.navigateSessionTreeAndPersist('selected', {}, async result => result);
      expect(recovered.result).toMatchObject({ cancelled: true, tree: f.state.tree });
      expect(recovered.result.draftText).toBeUndefined();
      expect(f.navigate).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce();
    } finally { await f.session.close(); }
  });
  it('restores a checkpoint into a new executor and reads back without a second navigation or input replay', async () => {
    const old = fixture(), fresh = fixture();
    let record: { entryId: string; nativeId: string; draftText?: string } | undefined;
    try {
      await expect(old.session.navigateSessionTreeAndPersist('selected', {}, async () => { throw new Error('db offline'); }, {
        async beforeNavigate() { record = { entryId: 'selected', nativeId: old.session.sdkSessionId }; },
        async afterNavigate(result) { record!.draftText = result.draftText; },
      })).rejects.toThrow('db offline');
      await old.session.close();
      fresh.session.restoreSessionTreeHandoff(record!);
      const view = fresh.presentation.attach('new-window', () => {});
      expect(view.acquireControl()).toBeNull();
      await expect(fresh.session.send('racing input')).rejects.toThrow();
      const checkpoint = { beforeNavigate: vi.fn(), afterNavigate: vi.fn() };
      const result = await fresh.session.navigateSessionTreeAndPersist('selected', {}, async result => result, checkpoint);
      expect(result.result.draftText).toBe('selected draft');
      expect(fresh.navigate).not.toHaveBeenCalled(); expect(fresh.read).toHaveBeenCalledOnce();
      expect(checkpoint.beforeNavigate).not.toHaveBeenCalled(); expect(checkpoint.afterNavigate).toHaveBeenCalledOnce();
      expect(fresh.handle.send).not.toHaveBeenCalled(); expect(view.acquireControl()).not.toBeNull();
    } finally { await old.session.close(); await fresh.session.close(); }
  });
  it('does not mutate native history when the durable before checkpoint fails', async () => {
    const f = fixture();
    try {
      await expect(f.session.navigateSessionTreeAndPersist('selected', {}, vi.fn(), {
        async beforeNavigate() { throw new Error('checkpoint unavailable'); }, afterNavigate: vi.fn(),
      })).rejects.toThrow('checkpoint unavailable');
      expect(f.navigate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
      expect(f.session.isTurnRunning()).toBe(false);
      expect(f.presentation.attach('view', () => {}).acquireControl()).not.toBeNull();
    } finally { await f.session.close(); }
  });
});
