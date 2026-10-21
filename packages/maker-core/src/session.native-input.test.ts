import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, type SessionNativeInput, type SessionOptions } from './session.js';
import { AUTO_REVIEW_SOURCE_CONTENT, TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type AgentSessionHandle } from './agents/base-agent.js';
import type { AgentEvent } from './types/events.js';
import type { AgentNativeInputRequest, AgentNativeInputResolver, AgentNativeMediaResolver } from './agents/native-input.js';
import { AgentPresentationRuntime } from './agents/presentation.js';
import { CodexNativeTaskPresentation } from './agents/codex/native-task-presentation.js';
import type { CodexNativeSessionHandle } from './agents/codex/native-input.js';

const sessions: Session[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
function fixture(options: Partial<SessionOptions> = {}, handleOptions: Partial<AgentSessionHandle> = {}) {
  const ended = deferred();
  let running = false;
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const handle = {
    id: 'native-session', agentKind: 'claude-code', model: 'fixture-model',
    send: vi.fn(async () => { running = true; }), steer: vi.fn(),
    abort: vi.fn(async () => { running = false; }),
    close: vi.fn(async () => { running = false; ended.resolve(); }),
    async *events(): AsyncGenerator<AgentEvent> { await ended.promise; },
    isTurnRunning: () => running, setInteractionResolver: vi.fn(), setNativeInputResolver: vi.fn(), setNativeRuntimeResolver: vi.fn(), validateSendOptions: vi.fn(),
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    ...handleOptions,
  } as unknown as AgentSessionHandle;
  const session = new Session({ id: 'task', agentKind: 'claude-code', workDir: '/owned/work', handle,
    capabilities: {} as never, logger, turnStallMs: 0, ...options });
  sessions.push(session);
  const accept = vi.fn<SessionNativeInput['accept']>(async () => { running = true; });
  const input: SessionNativeInput = { nativeSessionId: 'native-session', message: { type: 'user', content: 'native input' }, accept };
  return { session, handle, input, accept };
}

describe('native presentation activation through the product Session', () => {
  it('returns a receipt without launching, then activates once only after input and interaction ownership exist', async () => {
    const activate = vi.fn<NonNullable<AgentSessionHandle['activatePresentation']>>(async owner => {
      expect(owner.isCurrent()).toBe(true); expect(owner.signal.aborted).toBe(false); return { status: 'ready' };
    });
    const f = fixture({}, { activatePresentation: activate });
    const receipt = f.session.presentationInitialization;
    await Promise.resolve(); expect(receipt).toBeDefined(); expect(activate).not.toHaveBeenCalled();
    f.session.onNativeInput(vi.fn()); f.session.setInteractionListener(vi.fn());
    const dispose = f.session.activatePresentation(() => true);
    f.session.activatePresentation(() => true);
    expect(await receipt).toEqual({ status: 'ready' }); expect(activate).toHaveBeenCalledOnce();
    dispose(); expect(activate.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(f.handle.send).not.toHaveBeenCalled();
  });

  it.each(['input', 'interaction', 'main-owner'] as const)('rejects missing %s ownership without launching', async missing => {
    const activate = vi.fn<NonNullable<AgentSessionHandle['activatePresentation']>>(async () => ({ status: 'ready' }));
    const f = fixture({}, { activatePresentation: activate });
    if (missing !== 'input') f.session.onNativeInput(vi.fn());
    if (missing !== 'interaction') f.session.setInteractionListener(vi.fn());
    f.session.activatePresentation(() => missing !== 'main-owner');
    expect(await f.session.presentationInitialization).toEqual({ status: 'unavailable', reason: 'owner-changed' });
    expect(activate).not.toHaveBeenCalled(); expect(f.handle.close).not.toHaveBeenCalled();
  });

  it.each(['unbind', 'close', 'native-id', 'main-owner'] as const)('does not publish a delayed successful activation after %s changes', async boundary => {
    const entered = deferred(), release = deferred(); let current = true;
    const activate = vi.fn<NonNullable<AgentSessionHandle['activatePresentation']>>(async () => {
      entered.resolve(); await release.promise; return { status: 'ready' };
    });
    const f = fixture({}, { activatePresentation: activate });
    const unbind = f.session.onNativeInput(vi.fn()); f.session.setInteractionListener(vi.fn());
    f.session.activatePresentation(() => current); await entered.promise;
    if (boundary === 'unbind') unbind();
    else if (boundary === 'close') await f.session.close();
    else if (boundary === 'native-id') Object.defineProperty(f.handle, 'id', { value: 'replacement' });
    else current = false;
    expect(activate.mock.calls[0]![0].isCurrent()).toBe(false);
    release.resolve();
    expect(await f.session.presentationInitialization).toEqual({ status: 'unavailable', reason: 'owner-changed' });
    expect(activate).toHaveBeenCalledOnce();
    if (boundary !== 'close') expect(f.handle.close).not.toHaveBeenCalled();
  });

  it('retains GUI send while host-owned frontend initialization is pending', async () => {
    const entered = deferred(), release = deferred();
    const f = fixture({}, { activatePresentation: async () => { entered.resolve(); await release.promise; return { status: 'ready' }; } });
    f.session.onNativeInput(vi.fn()); f.session.setInteractionListener(vi.fn());
    f.session.activatePresentation(() => true); await entered.promise;
    expect(await f.session.send('GUI remains available')).toEqual({ accepted: true });
    expect(f.handle.send).toHaveBeenCalledOnce();
    release.resolve(); expect(await f.session.presentationInitialization).toEqual({ status: 'ready' });
  });

  it('keeps the same frontend during Stop without admitting input until the turn interruption settles', async () => {
    const release = deferred(), task = new CodexNativeTaskPresentation(vi.fn());
    const close = vi.fn();
    const presentation = new AgentPresentationRuntime('native-session', {
      write: vi.fn(), resize: vi.fn(), close, onData: () => () => {}, onExit: () => () => {},
    });
    const service = new AbortController();
    let mainOwnerCurrent = true;
    const f = fixture({}, {
      abort: async () => { await release.promise; },
      activatePresentation: async owner => {
        await task.start(async () => ({ presentation, ready: Promise.resolve(), close: () => presentation.close() }), {
          handle: f.handle as CodexNativeSessionHandle, cwd: f.session.workDir, ownerSignal: owner.signal, isCurrent: owner.isCurrent,
          service: { endpoint: { url: 'ws://127.0.0.1:1', token: 'fixture' }, signal: service.signal, isCurrent: () => !service.signal.aborted },
          routingContext: { ownsDescendant: () => false, titleContext: () => ({ model: 'fixture-model', mcpServers: [] }) },
        });
        return { status: 'ready' };
      },
    });
    Object.defineProperty(f.handle, 'presentation', { get: () => task.presentation });
    f.session.onNativeInput(async input => { await f.session.acceptNativeInput(input, { signal: input.signal }); });
    f.session.setInteractionListener(vi.fn());
    f.session.activatePresentation(() => mainOwnerCurrent);
    expect(await f.session.presentationInitialization).toEqual({ status: 'ready' });
    const resolveInput = vi.mocked(f.handle.setNativeInputResolver!).mock.calls[0]![0];
    const signal = new AbortController().signal;
    const stop = f.session.abort();
    try {
      expect(f.session.getStatus()).toBe('aborting');
      // Main resolves this getter while a terminal read is pending.
      expect(f.session.presentation).toBe(presentation);
      expect(close).not.toHaveBeenCalled();
      await expect(resolveInput({ ...f.input, nativeMessageId: 'during-stop', signal })).rejects.toThrow('no longer current');
      expect(f.accept).not.toHaveBeenCalled();
    } finally { release.resolve(); await stop; }
    expect(f.session.presentation).toBe(presentation);
    expect(presentation.state().status).toBe('running');
    await resolveInput({ ...f.input, nativeMessageId: 'after-stop', signal });
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.handle.send).not.toHaveBeenCalled();
    // A real owner change still retires the same frontend.
    mainOwnerCurrent = false;
    expect(f.session.presentation).toBeUndefined();
    await task.close();
    expect(close).toHaveBeenCalledOnce();
    expect(service.signal.aborted).toBe(false);
  });
});

describe('native input through the product Session', () => {
  it('runs the existing policy/history lifecycle and accepts the original input without sending another prompt', async () => {
    const f = fixture(), order: string[] = [];
    f.session.setTurnLifecycleObserver({ beforeProviderStart: generation => { order.push('lifecycle:' + generation); },
      onUndispatched: vi.fn(), onTerminal: vi.fn() });
    f.accept.mockImplementation(async () => { order.push('native'); });
    const result = await f.session.acceptNativeInput(f.input, {
      afterTurnReserved: () => { order.push('reserved'); },
      beforeProviderStart: () => { order.push('policy'); },
      onAccepted: () => { order.push('history'); },
      onDispatching: () => { order.push('dispatching'); },
    });
    expect(result).toEqual({ accepted: true });
    expect(order).toEqual(['reserved', 'lifecycle:1', 'policy', 'history', 'dispatching', 'native']);
    expect(f.handle.validateSendOptions).toHaveBeenCalledOnce();
    expect(f.handle.send).not.toHaveBeenCalled();
    expect(f.session.getTurnControlSnapshot()).toMatchObject({ active: true, turnGeneration: 1 });
  });

  it('does not admit GUI input during native preparation or native input during GUI preparation', async () => {
    for (const nativeFirst of [true, false]) {
      const f = fixture(), entered = deferred(), release = deferred();
      const opts = { beforeProviderStart: async () => { entered.resolve(); await release.promise; } };
      const first = nativeFirst ? f.session.acceptNativeInput(f.input, opts) : f.session.send('gui', opts);
      await entered.promise;
      await expect(nativeFirst ? f.session.send('gui') : f.session.acceptNativeInput(f.input)).rejects.toThrow('running');
      expect(f.accept).not.toHaveBeenCalled(); expect(f.handle.send).not.toHaveBeenCalled();
      release.resolve(); expect(await first).toEqual({ accepted: true });
      expect(nativeFirst ? f.accept : f.handle.send).toHaveBeenCalledOnce();
    }
  });

  it('cancels a held input on Stop before history and provider acceptance', async () => {
    const f = fixture(), entered = deferred(), release = deferred(), history = vi.fn(), cleanup = vi.fn();
    f.session.setTurnLifecycleObserver({ beforeProviderStart: async () => { entered.resolve(); await release.promise; },
      onUndispatched: cleanup, onTerminal: vi.fn() });
    const pending = f.session.acceptNativeInput(f.input, { onAccepted: history });
    await entered.promise; await f.session.abort(); release.resolve();
    expect(await pending).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(f.accept).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(1); expect(f.session.getTurnGeneration()).toBe(0);
  });

  it('preserves vision conversion and the original review input without re-submitting either', async () => {
    const original = { type: 'user' as const, content: [{ type: 'image' as const, path: '/owned/image.png' }] };
    const converted = { type: 'user' as const, content: 'host vision description' };
    const f = fixture({ visionBridge: async () => ({ applied: true, message: converted }) });
    await f.session.acceptNativeInput({ ...f.input, message: original });
    expect(f.accept).toHaveBeenCalledWith(converted, expect.objectContaining({
      [AUTO_REVIEW_SOURCE_CONTENT]: original.content, signal: expect.any(AbortSignal),
    }));
    expect(f.handle.send).not.toHaveBeenCalled();
  });

  it('rejects stale session identities and repeated native capabilities before persistence', async () => {
    const f = fixture(), history = vi.fn();
    await expect(f.session.acceptNativeInput({ ...f.input, nativeSessionId: 'other' }, { onAccepted: history })).rejects.toThrow('different session');
    expect(history).not.toHaveBeenCalled();
    await f.session.acceptNativeInput(f.input, { onAccepted: history });
    await expect(f.session.acceptNativeInput(f.input, { onAccepted: history })).rejects.toThrow('already admitted');
    expect(history).toHaveBeenCalledOnce(); expect(f.accept).toHaveBeenCalledOnce();
  });

  it('rechecks native identity after asynchronous host preparation before writing history', async () => {
    const f = fixture(), entered = deferred(), release = deferred(), history = vi.fn();
    const result = f.session.acceptNativeInput(f.input, {
      beforeProviderStart: async () => { entered.resolve(); await release.promise; }, onAccepted: history,
    });
    const rejected = expect(result).rejects.toThrow('different session');
    await entered.promise; Object.defineProperty(f.handle, 'id', { value: 'replacement' }); release.resolve(); await rejected;
    expect(history).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  });

  it('waits for an existing host turn lease and honors cancellation while waiting', async () => {
    const f = fixture(), controller = new AbortController(), history = vi.fn();
    const release = f.session.acquireTurnLease();
    const pending = f.session.acceptNativeInput(f.input, { signal: controller.signal, onAccepted: history });
    controller.abort();
    expect(await pending).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    release(); expect(history).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  });

  it('keeps confirmed native refusal distinct from an uncertain receipt and never retries', async () => {
    const f = fixture(), cleanup = vi.fn();
    f.session.setTurnLifecycleObserver({ beforeProviderStart: vi.fn(), onUndispatched: cleanup, onTerminal: vi.fn() });
    f.accept.mockRejectedValue(new TurnDispatchRejectedError('refused'));
    expect(await f.session.acceptNativeInput(f.input)).toEqual({ accepted: false, reason: 'provider-rejected-before-dispatch' });
    expect(f.handle.close).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledWith(1);
    const uncertain = fixture();
    uncertain.accept.mockRejectedValue(new TurnDispatchUnconfirmedError('receipt lost'));
    await expect(uncertain.session.acceptNativeInput(uncertain.input)).rejects.toThrow('receipt lost');
    expect(uncertain.handle.close).toHaveBeenCalledOnce(); expect(uncertain.accept).toHaveBeenCalledOnce();
    expect(uncertain.handle.send).not.toHaveBeenCalled();
  });
});

describe('adapter native input binding', () => {
  it('admits an OMP pre-journal submission without asserting a native message ID', async () => {
    const f = fixture({ agentKind: 'omp' }, { agentKind: 'omp' });
    const resolve = vi.mocked(f.handle.setNativeInputResolver!).mock.calls[0]![0];
    const input: AgentNativeInputRequest = { ...f.input, submissionId: 'bridge-submission', signal: new AbortController().signal };
    f.session.onNativeInput(async held => {
      expect(held.submissionId).toBe('bridge-submission');
      expect(held.nativeMessageId).toBeUndefined(); expect(held.source).toBeUndefined();
      await f.session.acceptNativeInput(held, { signal: held.signal });
    });
    await resolve(input); expect(f.accept).toHaveBeenCalledOnce(); expect(f.handle.send).not.toHaveBeenCalled();
  });
  it('does not permit a pre-journal submission to bypass another engine or become a steer', async () => {
    for (const engine of ['claude-code', 'omp'] as const) {
      const f = fixture({ agentKind: engine }, { agentKind: engine });
      const resolve = vi.mocked(f.handle.setNativeInputResolver!).mock.calls[0]![0], listener = vi.fn();
      f.session.onNativeInput(listener);
      await expect(resolve({ ...f.input, submissionId: 'bridge-submission', signal: new AbortController().signal,
        ...(engine === 'omp' ? { nativeTurnId: 'existing-turn' } : {}) })).rejects.toThrow('identity changed');
      expect(listener).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
    }
  });
  function bindingFixture() {
    const f = fixture();
    const resolver = vi.mocked(f.handle.setNativeInputResolver!).mock.calls[0]![0];
    const controller = new AbortController();
    const input: AgentNativeInputRequest = { ...f.input, nativeMessageId: 'native-row', signal: controller.signal };
    return { ...f, resolver, controller, input };
  }

  it('binds attachment import to the same product owner and native session', async () => {
    const f = bindingFixture();
    const importMedia = vi.mocked(f.handle.setNativeInputResolver!).mock.calls[0]![1]!;
    const input = { sessionId: 'native-session', messageId: 'row', index: 0, block: { type: 'image' }, signal: f.controller.signal };
    await expect(importMedia(input)).rejects.toThrow('no current product owner');
    const host = vi.fn<AgentNativeMediaResolver>(async () => ({ type: 'image', path: '/fixture/image', managedUrl: 'cindy-media://blobs/fixture.png' }));
    const stop = f.session.onNativeInput(vi.fn(), host);
    await expect(importMedia({ ...input, sessionId: 'foreign' })).rejects.toThrow('no longer current');
    await expect(importMedia({ ...input, index: -1 })).rejects.toThrow('identity');
    expect(host).not.toHaveBeenCalled();
    await expect(importMedia(input)).resolves.toMatchObject({ type: 'image' });
    stop();
    await expect(importMedia(input)).rejects.toThrow('no current product owner');
  });

  it('cancels an in-flight attachment import when the product binding is disposed', async () => {
    const f = bindingFixture(), started = deferred(), finished = deferred();
    const importMedia = vi.mocked(f.handle.setNativeInputResolver!).mock.calls[0]![1]!;
    let signal!: AbortSignal;
    const stop = f.session.onNativeInput(vi.fn(), async input => {
      signal = input.signal; started.resolve(); await finished.promise; return { type: 'image', path: '/fixture/image' };
    });
    const result = importMedia({ sessionId: 'native-session', messageId: 'row', index: 0, block: {}, signal: f.controller.signal });
    const rejection = expect(result).rejects.toThrow('no longer current');
    await started.promise; stop(); expect(signal.aborted).toBe(true); finished.resolve(); await rejection;
  });

  it('requires one product owner and explicit same-input acceptance', async () => {
    const f = bindingFixture();
    await expect(f.resolver(f.input)).rejects.toThrow('no current product owner');
    const history = vi.fn();
    const stop = f.session.onNativeInput(async input => {
      expect(input.nativeMessageId).toBe('native-row');
      expect(await f.session.acceptNativeInput(input, { signal: input.signal, onAccepted: history })).toEqual({ accepted: true });
    });
    expect(() => f.session.onNativeInput(vi.fn())).toThrow('already has a product owner');
    await f.resolver(f.input);
    expect(history).toHaveBeenCalledOnce(); expect(f.accept).toHaveBeenCalledOnce();
    expect(f.handle.send).not.toHaveBeenCalled();
    await expect(f.resolver(f.input)).rejects.toThrow('already delivered');
    stop(); stop();
  });

  it.each(['dispose', 'close', 'cancel'] as const)('fences delayed acceptance on %s', async boundary => {
    const f = bindingFixture(), entered = deferred(), release = deferred();
    let receivedSignal: AbortSignal | undefined;
    const stop = f.session.onNativeInput(async input => {
      receivedSignal = input.signal; entered.resolve(); await release.promise;
      await input.accept(input.message, {});
    });
    const result = f.resolver(f.input);
    const rejection = expect(result).rejects.toThrow('no longer current');
    await entered.promise;
    if (boundary === 'dispose') stop();
    else if (boundary === 'close') await f.session.close();
    else f.controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
    release.resolve(); await rejection; expect(f.accept).not.toHaveBeenCalled();
  });

  it('rejects mismatched provenance and a callback that never admits the input', async () => {
    const f = bindingFixture(), listener = vi.fn<AgentNativeInputResolver>(async () => {});
    f.session.onNativeInput(listener);
    const foreignSource: NonNullable<AgentNativeInputRequest['source']> = { version: 1, engine: 'claude-code',
      sessionId: 'foreign', messageId: 'native-row', origin: { kind: 'user' } };
    await expect(f.resolver({ ...f.input, source: foreignSource })).rejects.toThrow('identity changed');
    expect(listener).not.toHaveBeenCalled();
    await expect(f.resolver(f.input)).rejects.toThrow('not admitted');
    expect(f.accept).not.toHaveBeenCalled();
  });

  it('freezes native payload and leaves a replacement owner intact when an old disposer runs', async () => {
    const f = bindingFixture();
    const staleStop = f.session.onNativeInput(vi.fn()); staleStop();
    let received!: AgentNativeInputRequest;
    const entered = deferred(), release = deferred();
    f.session.onNativeInput(async input => { received = input; entered.resolve(); await release.promise; await input.accept(input.message, {}); });
    staleStop();
    const result = f.resolver(f.input); await entered.promise;
    f.input.message.content = 'mutated';
    expect(received.message.content).toBe('native input');
    release.resolve(); await result; expect(f.accept).toHaveBeenCalledOnce();
  });
});

describe('native menu ownership through Session', () => {
  it('shares the exact native identity with the current product owner', async () => {
    const f = fixture();
    const resolve = vi.mocked(f.handle.setNativeRuntimeResolver!).mock.calls[0]![0];
    const selected = vi.fn(async () => {});
    const request = { nativeSessionId: 'native-session', patch: { model: 'chosen' }, signal: new AbortController().signal };
    await expect(resolve(request)).rejects.toThrow('no product owner');
    const dispose = f.session.onNativeRuntimeSelection(selected);
    await resolve(request);
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'native-session', patch: { model: 'chosen' } }));
    expect(f.handle.send).not.toHaveBeenCalled();
    dispose(); await expect(resolve(request)).rejects.toThrow('no product owner');
  });
  it('retirement aborts a pending settings request and does not accept its late receipt', async () => {
    const f = fixture(), gate = deferred();
    const resolve = vi.mocked(f.handle.setNativeRuntimeResolver!).mock.calls[0]![0];
    let signal: AbortSignal | undefined;
    f.session.onNativeRuntimeSelection(async request => { signal = request.signal; await gate.promise; });
    const pending = expect(resolve({ nativeSessionId: 'native-session', patch: { effort: 'low' }, signal: new AbortController().signal })).rejects.toThrow('owner changed');
    await f.session.close(); expect(signal?.aborted).toBe(true);
    gate.resolve(); await pending;
  });
});

describe('native steering through the same Core Session',()=>{
  it('preserves the active turn and original review content while applying vision preparation',async()=>{
    const f=fixture({capabilities:{sameTurnSteer:{supported:true}} as never,visionBridge:async()=>({applied:true,message:{type:'user',content:'vision'}})});
    f.handle.getCurrentTurnId=()=> 'turn'; await f.session.send('first');
    const generation=f.session.getTurnGeneration();
    const message={type:'user' as const,content:[{type:'image' as const,path:'/fixture'}]};
    const input={...f.input,nativeTurnId:'turn',message};
    await f.session.acceptNativeSteer(input);
    expect(f.accept).toHaveBeenCalledWith({type:'user',content:'vision'},expect.objectContaining({[AUTO_REVIEW_SOURCE_CONTENT]:message.content}));
    expect(f.session.getTurnGeneration()).toBe(generation); expect(f.handle.steer).not.toHaveBeenCalled();
    await expect(f.session.acceptNativeSteer(input)).rejects.toThrow('already admitted');
  });
  it('does not dispatch after the native turn changes during vision conversion',async()=>{
    let turn='turn', calls=0;const gate=deferred(),entered=deferred();
    const f=fixture({capabilities:{sameTurnSteer:{supported:true}} as never,visionBridge:async message=>{
      if(++calls>1){entered.resolve();await gate.promise;}return {applied:false,message};
    }});
    f.handle.getCurrentTurnId=()=>turn;await f.session.send('first');
    const accept=vi.fn(async()=>{});
    const input={...f.input,nativeTurnId:'turn',accept};
    const pending=expect(f.session.acceptNativeSteer(input)).rejects.toThrow('another turn');
    await entered.promise;turn='new';gate.resolve();await pending;
    expect(accept).not.toHaveBeenCalled();
  });
});
