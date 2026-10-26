import { describe, expect, it, vi } from 'vitest';
import { createAsyncQueue } from '../shared/async-queue.js';
import { AgentPresentationRuntime } from '../presentation.js';
import type { AgentEvent } from '../../types/events.js';
import type { ClaudeNativeSessionHandle } from './native-session.js';
import { manageClaudeNativeModel } from './native-idle-reopen.js';

function native(model = 'exact-old') {
  const queue = createAsyncQueue<AgentEvent>();
  let draft = 'unsent /command', busy = false;
  const driver = { write: vi.fn(), resize: vi.fn(), onData: () => () => {}, onExit: () => () => {}, close: vi.fn() };
  const presentation = new AgentPresentationRuntime('history', driver);
  const snapshot = { sessionId: 'history', cwd: process.cwd(), model };
  const command = vi.fn(async () => ({ ...snapshot, draft: { text: draft } }));
  const handle: ClaudeNativeSessionHandle = {
    id: 'history', model, agentKind: 'claude-code', presentation,
    nativeRuntime: { ready: Promise.resolve(), presentation, command, submit: vi.fn(), close: vi.fn() },
    send: vi.fn(async () => {}), steer: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    setInteractionResolver: vi.fn(), setNativeInputResolver: vi.fn(),
    readNativeEditorDraft: async () => draft, restoreNativeEditorDraft: vi.fn(async text => { draft = text; }),
    isTurnRunning: () => busy, getUsageSnapshot: () => ({ tokenUsage: 10, costUsd: 1, contextTokens: 20, contextWindow: 100, outputTokens: 3 }),
    events: () => queue, close: vi.fn(async () => { await presentation.close(); queue.end(); }),
  };
  return { handle, snapshot, command, queue, setBusy(value: boolean) { busy = value; } };
}

describe('Claude idle exact-history model replacement', () => {
  it('rebuilds role context at idle, retains unrelated settings and never mutates the retired context', async () => {
    const old = native(), lead = native(), ordinary = native();
    const initialOptions = { customSetting: 'kept', orcaRole: null };
    const factory = vi.fn().mockResolvedValueOnce(lead.handle).mockResolvedValueOnce(ordinary.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), vendorOptions: initialOptions, reopen: factory });
    try {
      await handle.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'team' });
      expect(factory).toHaveBeenNthCalledWith(1, 'exact-old', 'history', { customSetting: 'kept', orcaRole: 'lead', orcaWorkflowId: 'team' });
      expect(initialOptions).toEqual({ customSetting: 'kept', orcaRole: null });
      expect(old.handle.close).toHaveBeenCalledOnce();
      await handle.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'team' });
      expect(factory).toHaveBeenCalledOnce();
      await handle.setVendorOptions!({ orcaRole: null, orcaWorkflowId: null });
      expect(factory).toHaveBeenNthCalledWith(2, 'exact-old', 'history', { customSetting: 'kept', orcaRole: null, orcaWorkflowId: null });
      expect(lead.handle.close).toHaveBeenCalledOnce();
      expect(await handle.readNativeEditorDraft!()).toBe('unsent /command');
      expect(old.handle.send).not.toHaveBeenCalled(); expect(ordinary.handle.send).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it('does not treat an in-flight role update as applied or restart a busy task', async () => {
    const old = native(), factory = vi.fn(); old.setBusy(true);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    try {
      await expect(handle.setVendorOptions!({ orcaRole: 'lead' })).rejects.toThrow('idle');
      expect(factory).not.toHaveBeenCalled(); expect(old.handle.close).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it('keeps failed replacement settings out of the next explicit recovery', async () => {
    const old = native(), refused = native(), recovery = native(); refused.snapshot.cwd = 'wrong';
    const factory = vi.fn().mockResolvedValueOnce(refused.handle).mockResolvedValueOnce(recovery.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), vendorOptions: { orcaRole: null }, reopen: factory });
    try {
      await expect(handle.setVendorOptions!({ orcaRole: 'lead' })).rejects.toThrow('readback');
      await handle.setVendorOptions!({ orcaRole: null });
      expect(factory).toHaveBeenNthCalledWith(2, 'exact-old', 'history', { orcaRole: null });
      expect(refused.handle.close).toHaveBeenCalledOnce();
    } finally { await handle.close(); }
  });

  it.each(['lead', 'worker'] as const)('retains revocation of a retired %s across another failed recovery', async role => {
    const old = native(), refusedModel = native('exact-next'), refusedRevoke = native(), recovered = native();
    refusedModel.snapshot.cwd = refusedRevoke.snapshot.cwd = 'wrong';
    const identity: Record<string, unknown> = { orcaRole: role, orcaWorkflowId: 'team', orcaLeadSessionId: 'lead',
      orcaWorkerId: role === 'worker' ? 'worker' : null };
    old.handle.readOrcaIdentity = () => ({ ...identity });
    old.handle.revokeOrcaIdentity = () => { for (const key of Object.keys(identity)) identity[key] = null; };
    const factory = vi.fn().mockResolvedValueOnce(refusedModel.handle).mockResolvedValueOnce(refusedRevoke.handle).mockResolvedValueOnce(recovered.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), vendorOptions: { ...identity }, reopen: factory });
    try {
      await expect(handle.setModel!('exact-next')).rejects.toThrow('readback');
      await expect(handle.setVendorOptions!({ orcaRole: null })).rejects.toThrow('readback');
      await handle.setModel!('exact-old');
      expect(factory.mock.calls[2]![2]).toMatchObject({ orcaRole: null, orcaWorkflowId: null, orcaWorkerId: null });
      expect(await handle.readNativeEditorDraft!()).toBe('unsent /command');
      expect(handle.getUsageSnapshot().tokenUsage).toBe(10);
      expect(recovered.handle.send).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it('freezes both leases, waits for exit, restores draft and forwards only the new executor', async () => {
    const old = native(), next = native('exact-next');
    let finish!: () => void;
    old.handle.close = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const factory = vi.fn(async () => next.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    const observer = old.handle.presentation!.attach('observer', () => {});
    const controller = old.handle.presentation!.attach('controller', () => {});
    const lease = controller.acquireControl()!;
    const resolver = vi.fn(), interaction = vi.fn();
    handle.setNativeInputResolver!(resolver); handle.setInteractionResolver(interaction);
    const seen: AgentEvent[] = []; void (async () => { for await (const event of handle.events()) seen.push(event); })();
    const change = handle.setModel!('exact-next');
    expect(observer.acquireControl(true)).toBeNull();
    expect(() => controller.write(lease, 1, 'late')).toThrow();
    await expect(handle.send({ type: 'user', content: 'racing' })).rejects.toThrow();
    await vi.waitFor(() => expect(old.handle.close).toHaveBeenCalledOnce());
    expect(factory).not.toHaveBeenCalled();
    old.queue.push({ type: 'text', source: 'claude-code', data: { text: 'late' } });
    finish(); await change;
    expect(factory).toHaveBeenCalledExactlyOnceWith('exact-next', 'history', {});
    expect(next.handle.restoreNativeEditorDraft).toHaveBeenCalledExactlyOnceWith('unsent /command');
    expect(next.handle.setNativeInputResolver).toHaveBeenCalledWith(resolver, undefined);
    expect(next.handle.setInteractionResolver).toHaveBeenCalledWith(interaction);
    expect(handle.id).toBe('history'); expect(handle.model).toBe('exact-next');
    expect(handle.getUsageSnapshot()).toMatchObject({ tokenUsage: 10, costUsd: 1, outputTokens: 3, contextTokens: 20 });
    next.queue.push({ type: 'text', source: 'claude-code', data: { text: 'new' } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.data).toEqual({ text: 'new' });
    expect(old.handle.send).not.toHaveBeenCalled(); expect(next.handle.send).not.toHaveBeenCalled();
    await handle.close(); old.queue.end();
  });
  it.each(['sessionId', 'cwd', 'model'] as const)('does not publish a replacement with different %s', async field => {
    const old = native(), next = native('exact-next'); next.snapshot[field] = 'unrelated';
    const factory = vi.fn(async () => next.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    await expect(handle.setModel!('exact-next')).rejects.toThrow('readback');
    expect(handle.model).toBe('exact-old'); expect(handle.id).toBe('history');
    expect(await handle.readNativeEditorDraft!()).toBe('unsent /command');
    expect(next.handle.close).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce();
    await expect(handle.send({ type: 'user', content: 'do not replay' })).rejects.toThrow();
    await handle.close();
  });
  it('does not create a replacement after an unconfirmed old exit', async () => {
    const old = native(), factory = vi.fn();
    old.handle.close = vi.fn(async () => { throw new Error('exit unconfirmed'); });
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    await expect(handle.setModel!('exact-next')).rejects.toThrow('exit unconfirmed');
    expect(factory).not.toHaveBeenCalled();
    await expect(handle.close()).rejects.toThrow('exit unconfirmed'); old.queue.end();
  });
  it('allows an explicit recovery after a refused model without replaying input or reusing the retired policy', async () => {
    const old = native(), recovery = native(), refused = native('exact-unavailable');
    refused.snapshot.model = 'different-model';
    const factory = vi.fn().mockResolvedValueOnce(refused.handle).mockResolvedValueOnce(recovery.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    await expect(handle.setModel!('exact-unavailable')).rejects.toThrow('readback');
    expect(refused.handle.close).toHaveBeenCalledOnce();
    expect(await handle.readNativeEditorDraft!()).toBe('unsent /command');
    await handle.setModel!('exact-old');
    expect(factory.mock.calls).toEqual([['exact-unavailable', 'history', {}], ['exact-old', 'history', {}]]);
    expect(old.handle.close).toHaveBeenCalledOnce();
    expect(recovery.handle.restoreNativeEditorDraft).toHaveBeenCalledWith('unsent /command');
    expect(recovery.handle.send).not.toHaveBeenCalled();
    await handle.close();
  });
  it('does not retry a factory rejection whose executor exit is unknown', async () => {
    const old = native(), factory = vi.fn().mockRejectedValue(new Error('startup failed after possible spawn'));
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    await expect(handle.setModel!('exact-next')).rejects.toThrow('startup failed');
    await expect(handle.setModel!('exact-old')).rejects.toThrow('not ready');
    expect(factory).toHaveBeenCalledOnce();
    expect(await handle.readNativeEditorDraft!()).toBe('unsent /command');
    await handle.close();
  });
  it('does not publish a replacement after the native input owner changes', async () => {
    const old = native(), next = native('exact-next');
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    next.handle.nativeRuntime.ready = ready;
    const factory = vi.fn(async () => next.handle);
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    handle.setNativeInputResolver!(vi.fn());
    const change = handle.setModel!('exact-next');
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    handle.setNativeInputResolver!(vi.fn());
    const interaction = vi.fn();
    handle.setInteractionResolver(interaction);
    expect(old.handle.setInteractionResolver).not.toHaveBeenCalled();
    finish(); await expect(change).rejects.toThrow('owner changed');
    expect(next.handle.restoreNativeEditorDraft).not.toHaveBeenCalled();
    expect(next.handle.close).toHaveBeenCalledOnce();
    expect(handle.model).toBe('exact-old');
    await handle.close();
  });
  it('rejects busy, different provider and unsupported effort before shutdown', async () => {
    const old = native(), factory = vi.fn();
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), providerId: 'source', reopen: factory });
    old.setBusy(true); await expect(handle.setModel!('exact-next')).rejects.toThrow('idle'); old.setBusy(false);
    await expect(handle.setModel!('exact-next', { providerId: 'other' })).rejects.toThrow('route');
    await expect(handle.setModel!('exact-next', { effort: 'high' })).rejects.toThrow('readback');
    expect(old.handle.close).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
    await handle.close();
  });
  it('serializes admission and discards a replacement when the task closes during startup', async () => {
    const old = native(), next = native('exact-next');
    let finish!: (handle: ClaudeNativeSessionHandle) => void;
    const factory = vi.fn(() => new Promise<ClaudeNativeSessionHandle>(resolve => { finish = resolve; }));
    const handle = manageClaudeNativeModel({ initial: old.handle, cwd: process.cwd(), reopen: factory });
    const change = handle.setModel!('exact-next'); void change.catch(() => {});
    await expect(handle.setModel!('racing-model')).rejects.toThrow('not ready');
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    const closing = handle.close(); finish(next.handle);
    await expect(change).rejects.toThrow('closed'); await closing;
    expect(next.handle.close).toHaveBeenCalledOnce(); expect(next.handle.restoreNativeEditorDraft).not.toHaveBeenCalled();
    expect(handle.model).toBe('exact-old');
  });
});
