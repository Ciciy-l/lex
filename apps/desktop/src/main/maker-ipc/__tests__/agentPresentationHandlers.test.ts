import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { AgentPresentationRuntime, type AgentTerminalDriver, type AgentPresentationInitialization } from '@cindy/maker-core';
import { createAgentPresentationHandler } from '../agentPresentationHandlers.js';
import type { PresentationInitialization } from '../agentPresentationService.js';

const mock = vi.hoisted(() => ({ context: null as any, owner: {} as any, pending: false, trusted: vi.fn() }));
vi.mock('../../device-link/invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => mock.context }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => mock.owner }));
vi.mock('../../appSessionState.js', () => ({ isAppSessionBoundaryPending: () => mock.pending }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: mock.trusted }));

const cleanup: Array<() => void> = [];
beforeEach(() => { mock.context = null; mock.owner = {}; mock.pending = false; mock.trusted.mockReset(); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(initialization?: (id: string) => PresentationInitialization | undefined) {
  let output!: (data: string) => void;
  const driver: AgentTerminalDriver = { write: vi.fn(), resize: vi.fn(), close: vi.fn(), onData: (fn) => { output = fn; return vi.fn(); }, onExit: () => vi.fn() };
  const runtime = new AgentPresentationRuntime('native', driver);
  const handler = createAgentPresentationHandler((id) => id === 'task' ? runtime : undefined, initialization);
  cleanup.push(() => handler.close());
  const event = { sender: { id: 10, once: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
  const call = (request: object) => handler.handle(event, { sessionId: 'task', ...request });
  return { runtime, handler, event, call, output: (data: string) => output(data) };
}

describe('native presentation IPC identity', () => {
  it.each(['account', 'device-generation'] as const)('rechecks %s after waiting for host activation', async boundary => {
    let complete!: (value: AgentPresentationInitialization) => void;
    const settled = new Promise<AgentPresentationInitialization>(resolve => { complete = resolve; });
    const context = { controllerDeviceId: 'remote', assertCurrent: vi.fn() };
    if (boundary === 'device-generation') mock.context = context;
    const f = fixture(() => ({ settled, isCurrent: () => true }));
    const pending = expect(f.call({ action: 'attach' })).rejects.toThrow('view expired');
    if (boundary === 'account') mock.owner = {};
    else context.assertCurrent.mockImplementation(() => { throw new Error('private device generation error'); });
    complete({ status: 'ready' }); await pending;
    expect(f.runtime.state().controller).toBeNull();
  });

  it('requires an application renderer and never trusts a wire peer identity', async () => {
    const f = fixture(); mock.trusted.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(f.call({ action: 'attach', peerId: 'device:trusted' })).rejects.toThrow('untrusted');
    expect(f.runtime.state().controller).toBeNull();
  });
  it('rejects shared-task guests and old device contexts without a generation fence', async () => {
    const f = fixture(); mock.context = { controllerDeviceId: 'remote', sharedTask: {}, assertCurrent: vi.fn() };
    await expect(f.call({ action: 'attach' })).rejects.toThrow('shared task');
    mock.context = { controllerDeviceId: 'remote' };
    await expect(f.call({ action: 'attach' })).rejects.toThrow('current device link');
  });
  it('rechecks the captured account after long-poll and does not leak driver errors', async () => {
    const f = fixture(); const attached = await f.call({ action: 'attach' }) as { attachmentId: string };
    const waiting = f.call({ action: 'read', ...attached, afterSequence: 0, wait: true });
    const rejected = expect(waiting).rejects.toThrow('view expired');
    mock.owner = {}; f.output('private'); await rejected;
  });
  it('separates paired desktops and releases only a destroyed local window', async () => {
    const f = fixture(); const local = await f.call({ action: 'attach' }) as { attachmentId: string };
    await f.call({ action: 'control', ...local });
    mock.context = { controllerDeviceId: 'remote', assertCurrent: vi.fn() };
    const remote = await f.call({ action: 'attach' }) as { attachmentId: string };
    await expect(f.call({ action: 'control', ...local })).rejects.toThrow('view expired');
    expect(await f.call({ action: 'control', ...remote })).toBeNull();
    const destroy = vi.mocked(f.event.sender.once).mock.calls[0][1] as () => void; destroy();
    expect(await f.call({ action: 'control', ...remote })).toHaveProperty('lease');
    expect(f.runtime.state().status).toBe('running');
  });
});
