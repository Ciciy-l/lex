import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types/events.js';
import type { Effort } from '../../types/common.js';
import { AgentPresentationRuntime } from '../presentation.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { managePiNativeHistory, type PiNativeHistoryHandle } from './native-history-reopen.js';

function fixture() {
  const files = ['source', 'branch-one', 'branch-two'].map(name => path.resolve('history', name + '.jsonl'));
  const releases: Array<() => void> = [];
  const handles = files.map((id, index) => {
    const queue = createAsyncQueue<AgentEvent>();
    let draft = 'unsent native text';
    let effort: Effort = 'medium';
    const presentation = new AgentPresentationRuntime(id, { write() {}, resize() {}, onData: () => () => {}, onExit: () => () => {}, close() {} });
    const handle: PiNativeHistoryHandle = {
      id, model: 'exact-model', agentKind: 'pi', presentation,
      send: vi.fn(async () => {}), steer: vi.fn(async () => {}), abort: vi.fn(async () => {}),
      isTurnRunning: () => false, setInteractionResolver: vi.fn(), setNativeInputResolver: vi.fn(),
      readNativeEditorDraft: async () => draft, restoreNativeEditorDraft: async text => { draft = text; },
      getEffort: () => effort, setEffort: async value => { effort = value; },
      readSessionTree: async () => ({ tree: { roots: [], activePathIds: [], leafId: null }, messages: [], contextTokens: 10, contextWindow: 100 }),
      forkNativeHistory: vi.fn(async (_entry, checkpoint) => { await checkpoint(files[index + 1]!); return files[index + 1]!; }),
      reopenNativeHistory: vi.fn(async () => { await handles[index + 1]!.setEffort!(effort); return handles[index + 1]!; }),
      events: () => queue,
      close: vi.fn(async () => { queue.end(); await presentation.close(); }),
      getUsageSnapshot: () => ({ tokenUsage: 20, costUsd: 1, contextTokens: 10, contextWindow: 100 }),
    }; return handle;
  });
  const checkpoint = { holdInput: (release: () => void) => releases.push(release), beforeReplacement: vi.fn(async () => {}), target: vi.fn(async (_target: string) => {}) };
  const handle = managePiNativeHistory({ initial: handles[0]! });
  return { handles, handle, files, releases, checkpoint };
}

it('forks each current executor once and forwards later settings and draft to its next replacement', async () => {
  const f = fixture();
  try {
    await f.handle.navigateSessionTree!('first', { fork: true }, f.checkpoint);
    f.releases.splice(0).forEach(release => release());
    await f.handle.setEffort!('high');
    await f.handle.restoreNativeEditorDraft!('changed draft');
    const result = await f.handle.navigateSessionTree!('second', { fork: true }, f.checkpoint);
    expect(result.nativeIdentity).toEqual({ source: f.files[1], target: f.files[2] });
    expect(f.handles[0]!.reopenNativeHistory).toHaveBeenCalledExactlyOnceWith(f.files[1]);
    expect(f.handles[1]!.reopenNativeHistory).toHaveBeenCalledExactlyOnceWith(f.files[2]);
    expect(f.handle.id).toBe(f.files[2]); expect(f.handle.getEffort!()).toBe('high');
    expect(await f.handle.readNativeEditorDraft!()).toBe('changed draft');
    expect(f.handle.getUsageSnapshot()).toMatchObject({ tokenUsage: 60, costUsd: 3 });
    expect(f.handles.every(handle => vi.mocked(handle.send).mock.calls.length === 0)).toBe(true);
    const peer = f.handle.presentation!.attach('current', () => {}); expect(peer.acquireControl()).toBeNull();
    f.releases.splice(0).forEach(release => release()); expect(peer.acquireControl()).not.toBeNull(); peer.detach();
  } finally { await f.handle.close(); }
});

it('does not reopen or repeat a fork after the target checkpoint fails', async () => {
  const f = fixture(); f.checkpoint.target.mockRejectedValue(new Error('disk unavailable'));
  try {
    await expect(f.handle.navigateSessionTree!('first', { fork: true }, f.checkpoint)).rejects.toThrow('disk unavailable');
    expect(f.handles[0]!.reopenNativeHistory).not.toHaveBeenCalled();
    await expect(f.handle.navigateSessionTree!('first', { fork: true }, f.checkpoint)).rejects.toThrow('not ready');
    expect(f.handles[0]!.forkNativeHistory).toHaveBeenCalledOnce();
    expect(await f.handle.readNativeEditorDraft!()).toBe('unsent native text');
  } finally { await f.handle.close(); }
});

it('revokes a role immediately during a history handoff and discards its late replacement', async () => {
  const f = fixture();
  let finish!: () => void;
  f.checkpoint.beforeReplacement.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  f.handles[0]!.revokeOrcaIdentity = vi.fn();
  const change = f.handle.navigateSessionTree!('first', { fork: true }, f.checkpoint);
  try {
    await vi.waitFor(() => expect(f.checkpoint.beforeReplacement).toHaveBeenCalledOnce());
    await expect(f.handle.setVendorOptions!({ orcaRole: null })).rejects.toThrow('not ready');
    expect(f.handles[0]!.revokeOrcaIdentity).toHaveBeenCalledOnce();
    finish(); await expect(change).rejects.toThrow('owner changed');
    expect(f.handles[0]!.forkNativeHistory).not.toHaveBeenCalled();
    expect(f.handles[0]!.reopenNativeHistory).not.toHaveBeenCalled();
  } finally { await f.handle.close(); }
});
