import { describe, expect, it, vi } from 'vitest';
import type { AgentNativeInputRequest, AgentNativeInputResolver, AgentNativeMediaResolver, Session } from '@cindy/maker-core';
import { bindNativeSessionInput, nativeInputQueueItem, preparedNativeMessage, type NativeInputBindingDeps } from '../nativeInputBinding.js';

const createOpts = { agentKind: 'claude-code' as const, workingDir: '/owned/work', model: 'model' };
function fixture() {
  let listener!: AgentNativeInputResolver;
  let media!: AgentNativeMediaResolver | undefined;
  const stop = vi.fn();
  const session = { id: 'task', onNativeInput: (next: AgentNativeInputResolver, importer?: AgentNativeMediaResolver) => { listener = next; media = importer; return stop; } } as unknown as Session;
  const controller = new AbortController();
  const input: AgentNativeInputRequest = { nativeSessionId: 'native', nativeMessageId: 'row',
    message: { type: 'user', content: 'original' }, signal: controller.signal, accept: vi.fn() };
  const deps: NativeInputBindingDeps = {
    isCurrent: vi.fn(() => true), assertAllowed: vi.fn(async () => {}),
    importMedia: vi.fn(async () => ({ type: 'image' as const, path: '/fixture/image' })),
    readCreateOpts: vi.fn(async () => createOpts),
    accept: vi.fn(async () => ({ outcome: { kind: 'dispatched' }, accepted: true }) as never),
    withIdleSendLock: vi.fn(async (_id, run) => run()),
    coordinator: { isExecutionPaused: vi.fn(() => false), acceptNativeInput: vi.fn(async (id, item, native) => {
      const message = native.buildMessage!(item);
      await native.dispatch(id, message, item.createOpts, { signal: native.signal, messageUuid: native.messageId });
    }) },
  };
  const dispose = bindNativeSessionInput(session, deps);
  return { session, input, deps, controller, stop, dispose, media, receive: (request = input) => listener(request) };
}

describe('Desktop native input binding', () => {
  it('installs the host attachment importer on the same Session binding', () => {
    const f = fixture(); expect(f.media).toBe(f.deps.importMedia);
  });
  it('enters the same coordinator and send transaction with actual row identity/provenance', async () => {
    const f = fixture();
    const source = { version: 1 as const, engine: 'claude-code' as const, sessionId: 'native', messageId: 'row', origin: { kind: 'plugin', name: 'external' } };
    await f.receive({ ...f.input, source });
    expect(f.deps.assertAllowed).toHaveBeenCalledTimes(2);
    expect(f.deps.coordinator.acceptNativeInput).toHaveBeenCalledWith('task', expect.objectContaining({ clientId: 'row', autoReviewUserText: '' }),
      expect.objectContaining({ session: f.session, messageId: 'row', signal: f.input.signal }));
    expect(f.deps.accept).toHaveBeenCalledWith(f.session, expect.objectContaining({ message: f.input.message, accept: f.input.accept }),
      expect.objectContaining({ messageUuid: 'row' }), source);
    f.dispose(); expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'owner', 'pause'] as const)('refuses %s during preparation before admission', async change => {
    const f = fixture();
    vi.mocked(f.deps.readCreateOpts).mockImplementation(async () => {
      if (change === 'cancel') f.controller.abort();
      else if (change === 'owner') vi.mocked(f.deps.isCurrent).mockReturnValue(false);
      else vi.mocked(f.deps.coordinator.isExecutionPaused).mockReturnValue(true);
      return createOpts;
    });
    await expect(f.receive()).rejects.toThrow('no longer belongs');
    expect(f.deps.coordinator.acceptNativeInput).not.toHaveBeenCalled();
    expect(f.deps.accept).not.toHaveBeenCalled();
  });

  it('refuses a held GUI send lock instead of waiting or starting another writer', async () => {
    const f = fixture();
    vi.mocked(f.deps.withIdleSendLock).mockRejectedValue(new Error('busy'));
    await expect(f.receive()).rejects.toThrow('busy');
    expect(f.deps.accept).not.toHaveBeenCalled();
  });

  it('checks ownership again inside the acquired send lock', async () => {
    const f = fixture();
    vi.mocked(f.deps.withIdleSendLock).mockImplementation(async (_id, run) => {
      vi.mocked(f.deps.isCurrent).mockReturnValue(false); return run();
    });
    await expect(f.receive()).rejects.toThrow('no longer belongs');
    expect(f.deps.accept).not.toHaveBeenCalled();
  });

  it('keeps media identity and ordered native blocks through host text rewrites', () => {
    const f = fixture();
    f.input.message.content = [
      { type: 'text', text: 'one' },
      { type: 'image', path: '/owned/blob.png', managedUrl: 'cindy-media://blobs/abc.png', mimeType: 'image/png' },
      { type: 'text', text: 'two' }, { type: 'file', path: '/work/report.pdf' },
    ];
    const item = nativeInputQueueItem(f.input, createOpts);
    expect(item.text).toBe('one\ntwo');
    expect(JSON.parse(item.persistedContent)).toMatchObject({ images: [{ url: 'cindy-media://blobs/abc.png' }], files: [{ path: '/work/report.pdf' }] });
    expect(item.persistedContent).not.toContain('/owned/blob.png');
    expect(preparedNativeMessage(f.input.message, item.text)).toEqual(f.input.message);
    expect(preparedNativeMessage(f.input.message, 'rewritten').content).toEqual([
      { type: 'text', text: 'rewritten' }, f.input.message.content[1], f.input.message.content[3],
    ]);
    expect(f.input.message.content[0]).toEqual({ type: 'text', text: 'one' });
  });

  it('does not persist a native image path as a cross-device image URL', () => {
    const f = fixture();
    f.input.message.content = [{ type: 'image', path: '/tmp/native.png' }];
    expect(() => nativeInputQueueItem(f.input, createOpts)).toThrow('not been imported');
  });
});

describe('native steering Main binding', () => {
  it('shares current task policy and the existing steer path without holding the send lock', async () => {
    const f=fixture();
    Object.assign(f.session,{getTurnGeneration:()=>1,getCurrentTurnId:()=> 'turn'});
    f.deps.steer=vi.fn(async()=>{});
    const state = { version: 1 as const, engine: 'codex' as const, sessionId: 'native', turnId: 'turn',
      messageId: 'row', status: 'unconsumed' as const };
    const consumption = { read: () => state, settled: Promise.resolve(state) };
    const persistConsumption = vi.fn(async () => true);
    f.deps.captureConsumption = vi.fn(() => persistConsumption);
    f.deps.coordinator.acceptNativeSteer=vi.fn(async(id,item,native)=>{
      await native.dispatch(id,native.buildMessage(item),{signal:native.signal,messageUuid:native.messageId});
    });
    await f.receive({...f.input,nativeTurnId:'turn',consumption});
    expect(f.deps.captureConsumption).toHaveBeenCalledExactlyOnceWith(f.session,
      expect.objectContaining({ consumption, nativeTurnId: 'turn', nativeMessageId: 'row' }));
    expect(f.deps.coordinator.acceptNativeSteer).toHaveBeenCalledWith('task', expect.anything(),
      expect.objectContaining({ consumption, persistConsumption }));
    expect(f.deps.steer).toHaveBeenCalledExactlyOnceWith(f.session,expect.objectContaining({nativeTurnId:'turn',message:f.input.message}),
      expect.objectContaining({messageUuid:'row'}));
    expect(f.deps.withIdleSendLock).not.toHaveBeenCalled(); expect(f.deps.accept).not.toHaveBeenCalled();
  });
  it.each(['turn','owner','cancel'] as const)('fences %s changes while native steering policy awaits',async kind=>{
    const f=fixture();let turn='turn';
    Object.assign(f.session,{getTurnGeneration:()=>1,getCurrentTurnId:()=>turn});
    f.deps.steer=vi.fn(async()=>{});
    f.deps.coordinator.acceptNativeSteer=vi.fn(async(id,item,native)=>{
      if(kind==='turn')turn='other';
      if(kind==='owner')vi.mocked(f.deps.isCurrent).mockReturnValue(false);
      if(kind==='cancel')f.controller.abort();
      await native.dispatch(id,native.buildMessage(item),{});
    });
    await expect(f.receive({...f.input,nativeTurnId:'turn'})).rejects.toThrow();
    expect(f.deps.steer).not.toHaveBeenCalled();
  });
});
