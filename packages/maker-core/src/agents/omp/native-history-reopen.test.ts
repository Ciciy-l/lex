import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionHandle } from '../base-agent.js';
import type { OmpNativeSessionHandle } from './native-session.js';
import { AgentPresentationRuntime } from '../presentation.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import type { AgentEvent } from '../../types/events.js';
import { manageOmpNativeHistory } from './native-history-reopen.js';

function fixture() {
  const source = path.resolve('history/old.jsonl'), target = path.resolve('history/new.jsonl');
  const native = (id: string) => {
    const queue = createAsyncQueue<AgentEvent>();
    const presentation = new AgentPresentationRuntime(id, { write() {}, resize() {}, onData: () => () => {}, onExit: () => () => {}, close() {} });
    let draft = 'original draft';
    const handle: OmpNativeSessionHandle = { id, model: 'exact-model', agentKind: 'omp', presentation,
      send: vi.fn(async () => {}), steer: vi.fn(async () => {}), abort: vi.fn(async () => {}),
      isTurnRunning: () => false, setInteractionResolver: vi.fn(), setNativeInputResolver: vi.fn(), events: () => queue,
      close: vi.fn(async () => { queue.end(); await presentation.close(); }),
      readNativeEditorDraft: async () => draft, restoreNativeEditorDraft: vi.fn(async value => { draft = value; }),
      readSessionTree: async () => ({ tree: { roots: [], activePathIds: ['chosen'], leafId: 'chosen' }, messages: [], contextTokens: 12, contextWindow: 100 }),
      getUsageSnapshot: () => ({ tokenUsage: id === source ? 50 : 0, costUsd: id === source ? 1 : 0, contextTokens: 12, contextWindow: 100 }),
    }; return handle;
  };
  const old = native(source), next = native(target);
  let forked = false;
  const request = vi.fn((command: { type: string }) => ({ response: Promise.resolve({ data: command.type === 'get_state'
    ? { sessionFile: forked ? target : source, model: { id: 'exact-model', provider: 'cindy' } }
    : command.type === 'get_tree' ? { tree: [{ entry: { id: 'chosen' }, children: [] }] }
    : (forked = true, { cancelled: false }) }) }));
  const rpc = { host: { client: { request } }, stopAndDispose: vi.fn(async () => true) };
  const openRpc = vi.fn(async () => rpc as never), openNative = vi.fn(async () => next);
  const handle = manageOmpNativeHistory({ initial: old, model: 'exact-model', openRpc, openNative });
  const releases: Array<() => void> = [];
  const checkpoint = { beforeReplacement: vi.fn(async () => {}), target: vi.fn(async (_target: string) => {}), holdInput: (release: () => void) => releases.push(release) };
  return { source, target, old, next, rpc, openRpc, openNative, handle, checkpoint, releases };
}

it('performs one official fork only after exact exit and checkpoints before reopening, preserving draft and usage', async () => {
  const f = fixture();
  f.openRpc.mockImplementation(async () => { expect(f.old.close).toHaveBeenCalledOnce(); return f.rpc as never; });
  f.openNative.mockImplementation(async () => { expect(f.checkpoint.target).toHaveBeenCalledWith(f.target); expect(f.rpc.stopAndDispose).toHaveBeenCalledOnce(); return f.next; });
  try {
    const result = await f.handle.navigateSessionTree!('chosen', {}, f.checkpoint);
    expect(result.nativeIdentity).toEqual({ source: f.source, target: f.target });
    expect(f.rpc.host.client.request.mock.calls.map(([command]) => command.type)).toEqual(['get_state', 'get_tree', 'fork', 'get_state']);
    expect(await f.handle.readNativeEditorDraft!()).toBe('original draft');
    expect(f.handle.getUsageSnapshot()).toMatchObject({ tokenUsage: 50, costUsd: 1 });
    const view = f.handle.presentation!.attach('new-view', () => {});
    expect(view.acquireControl()).toBeNull(); f.releases.forEach(release => release()); expect(view.acquireControl()).not.toBeNull();
    expect(f.old.send).not.toHaveBeenCalled(); expect(f.next.send).not.toHaveBeenCalled();
  } finally { await f.handle.close(); }
});

it('does not repeat a fork or reopen the source when target persistence fails', async () => {
  const f = fixture(); f.checkpoint.target.mockRejectedValue(new Error('checkpoint write failed'));
  try {
    await expect(f.handle.navigateSessionTree!('chosen', {}, f.checkpoint)).rejects.toThrow('checkpoint write failed');
    expect(f.openNative).not.toHaveBeenCalled(); expect(f.rpc.stopAndDispose).toHaveBeenCalledOnce();
    expect(await f.handle.readNativeEditorDraft!()).toBe('original draft');
    await expect(f.handle.navigateSessionTree!('chosen', {}, f.checkpoint)).rejects.toThrow('not ready');
    await expect(f.handle.send({ type: 'user', content: 'no implicit retry' })).rejects.toThrow('not ready');
    expect(f.openRpc).toHaveBeenCalledOnce();
  } finally { await f.handle.close(); }
});

it('does not start the RPC writer if native exit is unconfirmed', async () => {
  const f = fixture(); f.old.close = vi.fn(async () => { throw new Error('exit unconfirmed'); });
  await expect(f.handle.navigateSessionTree!('chosen', {}, f.checkpoint)).rejects.toThrow('exit unconfirmed');
  expect(f.openRpc).not.toHaveBeenCalled(); await expect(f.handle.close()).rejects.toThrow('exit unconfirmed');
});

it('revokes role during an unfinished history handoff before any RPC mutation', async () => {
  const f = fixture();
  let finish!: () => void;
  f.checkpoint.beforeReplacement.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  f.old.revokeOrcaIdentity = vi.fn();
  const change = f.handle.navigateSessionTree!('chosen', {}, f.checkpoint);
  try {
    await vi.waitFor(() => expect(f.checkpoint.beforeReplacement).toHaveBeenCalledOnce());
    await expect(f.handle.setVendorOptions!({ orcaRole: null })).rejects.toThrow('not ready');
    expect(f.old.revokeOrcaIdentity).toHaveBeenCalledOnce();
    finish(); await expect(change).rejects.toThrow('owner changed');
    expect(f.openRpc).not.toHaveBeenCalled(); expect(f.openNative).not.toHaveBeenCalled();
  } finally { await f.handle.close(); }
});
