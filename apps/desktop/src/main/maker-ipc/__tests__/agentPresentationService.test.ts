import { describe, expect, it, vi } from 'vitest';
import { AgentPresentationRuntime, type AgentTerminalDriver, type AgentPresentationInitialization } from '@cindy/maker-core';
import { AgentPresentationService, type PresentationPeer, type PresentationInitialization } from '../agentPresentationService.js';
import type { AgentPresentationAttached, AgentTerminalControl } from '../../../shared/agentPresentation.js';

function fixture(initialization?: (id: string) => PresentationInitialization | undefined) {
  let output!: (data: string) => void;
  const driver: AgentTerminalDriver = { write: vi.fn(), resize: vi.fn(), close: vi.fn(),
    onData: (listener) => { output = listener; return vi.fn(); }, onExit: () => vi.fn() };
  const runtime = new AgentPresentationRuntime('native', driver);
  let live: AgentPresentationRuntime | undefined = runtime;
  let now = 0;
  const service = new AgentPresentationService((id) => id === 'task' ? live : undefined, () => now, initialization);
  const peer = (id: string): PresentationPeer => ({ id, assertCurrent: vi.fn() });
  const a = peer('desktop'), b = peer('remote');
  const invoke = (owner: PresentationPeer, input: object) => service.invoke(owner, { sessionId: 'task', ...input });
  const attach = (owner: PresentationPeer) => invoke(owner, { action: 'attach' }) as Promise<AgentPresentationAttached>;
  return { service, runtime, driver, a, b, invoke, attach, output: (data: string) => output(data),
    replace: () => { live = undefined; }, advance: (ms: number) => { now += ms; } };
}

describe('task presentation host boundary', () => {
  it('projects runtime GUI capabilities on status only after current-owner authorization', async () => {
    let current = true;
    const snapshot = vi.fn(() => ({ agentKind: 'pi', capabilities: { sameTurnSteer: { supported: false } } } as never));
    const service = new AgentPresentationService(() => undefined, Date.now, undefined, snapshot);
    const peer = { id: 'owner', assertCurrent: () => { if (!current) throw new Error('owner changed'); } };
    expect(await service.invoke(peer, { action: 'status', sessionId: 'task' })).toMatchObject({ supported: false,
      runtime: { agentKind: 'pi', capabilities: { sameTurnSteer: { supported: false } } } });
    current = false;
    await expect(service.invoke(peer, { action: 'status', sessionId: 'task' })).rejects.toThrow('owner changed');
    expect(snapshot).toHaveBeenCalledOnce(); service.close();
  });
  it('observes host activation before attaching without starting any task or writing input', async () => {
    let complete!: (value: AgentPresentationInitialization) => void;
    const settled = new Promise<AgentPresentationInitialization>(resolve => { complete = resolve; });
    const initialization = vi.fn(() => ({ settled, isCurrent: () => true }));
    const f = fixture(initialization);
    let attached = false;
    const pending = f.attach(f.a).then(value => { attached = true; return value; });
    await Promise.resolve(); expect(attached).toBe(false); expect(f.driver.write).not.toHaveBeenCalled();
    complete({ status: 'ready' }); expect(await pending).toHaveProperty('attachmentId');
    expect(initialization).toHaveBeenCalledExactlyOnceWith('task'); f.service.close();
  });

  it.each(['peer', 'task'] as const)('rejects a stale %s after activation finishes', async boundary => {
    let complete!: (value: AgentPresentationInitialization) => void, current = true;
    const settled = new Promise<AgentPresentationInitialization>(resolve => { complete = resolve; });
    const f = fixture(() => ({ settled, isCurrent: () => current }));
    const pending = expect(f.attach(f.a)).rejects.toThrow(boundary === 'peer' ? 'revoked' : 'generation changed');
    if (boundary === 'peer') vi.mocked(f.a.assertCurrent).mockImplementation(() => { throw new Error('revoked'); });
    else current = false;
    complete({ status: 'ready' }); await pending;
    expect(f.runtime.state().controller).toBeNull(); expect(f.driver.write).not.toHaveBeenCalled(); f.service.close();
  });

  it('returns the controlled unavailability reason and leaves the GUI task alone', async () => {
    const f = fixture(() => ({ settled: Promise.resolve({ status: 'unavailable', reason: 'unsupported-service' }), isCurrent: () => true }));
    f.replace();
    expect(await f.invoke(f.a, { action: 'status' })).toEqual({ supported: false, reason: 'unsupported-service' });
    expect(f.driver.close).not.toHaveBeenCalled();
  });

  it('reports unavailable without creating or resuming a task', async () => {
    const f = fixture(); f.replace();
    expect(await f.invoke(f.a, { action: 'status' })).toEqual({ supported: false });
    await expect(f.attach(f.a)).rejects.toThrow('unavailable');
    expect(f.driver.write).not.toHaveBeenCalled();
  });

  it('binds every view to its trusted peer and task', async () => {
    const f = fixture(); const { attachmentId } = await f.attach(f.a);
    await expect(f.invoke(f.b, { action: 'control', attachmentId })).rejects.toThrow('expired');
    await expect(f.service.invoke(f.a, { sessionId: 'other', action: 'control', attachmentId })).rejects.toThrow('expired');
    expect(f.runtime.state().controller).toBeNull();
  });

  it('delivers output to two observers while only one holds input control', async () => {
    const f = fixture(); const a = await f.attach(f.a), b = await f.attach(f.b);
    const control = await f.invoke(f.a, { action: 'control', attachmentId: a.attachmentId }) as AgentTerminalControl;
    expect(await f.invoke(f.b, { action: 'control', attachmentId: b.attachmentId })).toBeNull();
    const one = f.invoke(f.a, { action: 'read', attachmentId: a.attachmentId, afterSequence: 0, wait: true });
    const two = f.invoke(f.b, { action: 'read', attachmentId: b.attachmentId, afterSequence: 0, wait: true });
    f.output('native output');
    expect(await one).toMatchObject({ frames: [{ data: 'native output' }] });
    expect(await two).toMatchObject({ frames: [{ data: 'native output' }] });
    f.service.detachPeer(f.b.id);
    await f.invoke(f.a, { action: 'write', attachmentId: a.attachmentId, control, sequence: 1, data: 'hello' });
    expect(f.driver.write).toHaveBeenCalledWith('hello');
    expect(f.driver.close).not.toHaveBeenCalled();
    f.service.close();
  });

  it('rechecks ownership before returning data after a long poll', async () => {
    const f = fixture(); const { attachmentId } = await f.attach(f.a);
    const reading = f.invoke(f.a, { action: 'read', attachmentId, afterSequence: 0, wait: true });
    const rejected = expect(reading).rejects.toThrow('revoked');
    vi.mocked(f.a.assertCurrent).mockImplementation(() => { throw new Error('revoked'); });
    f.output('private'); await rejected;
    await expect(f.invoke(f.a, { action: 'write', attachmentId, control: { generation: 'g', lease: 'l' }, sequence: 1, data: 'x' })).rejects.toThrow('revoked');
    expect(f.driver.write).not.toHaveBeenCalled(); f.service.close();
  });

  it('rejects stale views after the task handle is replaced', async () => {
    const f = fixture(); const { attachmentId } = await f.attach(f.a); f.replace();
    await expect(f.invoke(f.a, { action: 'control', attachmentId })).rejects.toThrow('expired');
    expect(f.driver.close).not.toHaveBeenCalled();
  });

  it('expires only an inactive peer, leaving an active peer and task alive', async () => {
    const f = fixture(); const a = await f.attach(f.a), b = await f.attach(f.b);
    await f.invoke(f.b, { action: 'control', attachmentId: b.attachmentId });
    f.advance(40_000); await f.invoke(f.a, { action: 'read', attachmentId: a.attachmentId, afterSequence: 0 });
    f.advance(21_000);
    expect(await f.invoke(f.a, { action: 'control', attachmentId: a.attachmentId })).not.toBeNull();
    await expect(f.invoke(f.b, { action: 'read', attachmentId: b.attachmentId, afterSequence: 0 })).rejects.toThrow('expired');
    expect(f.driver.close).not.toHaveBeenCalled(); f.service.close();
  });

  it('rejects overlapping read requests and releases waiters on detach', async () => {
    const f = fixture(); const { attachmentId } = await f.attach(f.a);
    const first = f.invoke(f.a, { action: 'read', attachmentId, afterSequence: 0, wait: true });
    const rejected = expect(first).rejects.toThrow('expired');
    await expect(f.invoke(f.a, { action: 'read', attachmentId, afterSequence: 0, wait: true })).rejects.toThrow('already pending');
    await f.invoke(f.a, { action: 'detach', attachmentId }); await rejected;
    expect(f.driver.close).not.toHaveBeenCalled();
  });

  it('rejects malformed raw requests before any terminal mutation', async () => {
    const f = fixture(); const { attachmentId } = await f.attach(f.a);
    for (const bad of [null, [], { action: 'attach' }, { sessionId: 'task', action: 'exec' },
      { sessionId: 'task', action: 'control', attachmentId, takeOver: 'yes' },
      { sessionId: 'task', action: 'read', attachmentId, afterSequence: -1 }]) {
      await expect(f.service.invoke(f.a, bad)).rejects.toThrow('Invalid');
    }
    expect(f.driver.write).not.toHaveBeenCalled(); f.service.close();
  });
});
