import { describe, expect, it, vi } from 'vitest';
import { CodexNativeSteerAdmission, CODEX_NATIVE_STEER, type CodexNativeSteerOptions } from './native-steer.js';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError } from '../base-agent.js';
import type { AgentNativeInputRequest } from '../native-input.js';
import type { UserMessage } from '../../types/common.js';
import type { TurnSteerParams } from './app-server/protocol.js';

const messageId = '676c9703-2253-4dc2-8b4b-9fe8832d9810';
function fixture() {
  let thread = 'task', turn: string | null = 'running';
  const controller = new AbortController();
  const dispatch = vi.fn(async (_params: TurnSteerParams) => ({ turnId: 'running' }));
  const steer = vi.fn(async (message: UserMessage, options: CodexNativeSteerOptions) => {
    const native = options[CODEX_NATIVE_STEER]!;
    await native.start({ threadId: thread, expectedTurnId: turn!, input: native.input(message) });
  });
  const owner = vi.fn(async (input: AgentNativeInputRequest) => input.accept(input.message, {}));
  const admission = new CodexNativeSteerAdmission(() => thread, () => turn, steer); admission.bind(owner);
  const request = { params: { threadId: thread, expectedTurnId: turn!, clientUserMessageId: messageId,
    input: [{ type: 'text' as const, text: 'same text' }] }, signal: controller.signal, dispatch };
  return { admission, request, owner, dispatch, steer, controller, replaceThread: () => { thread = 'other'; },
    replaceTurn: () => { turn = 'new'; }, endTurn: () => { turn = null; } };
}

describe('native Codex same-turn admission', () => {
  it('retains the original native message identity through policy rewriting and one physical dispatch', async () => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      expect(input).toMatchObject({ nativeSessionId: 'task', nativeTurnId: 'running', nativeMessageId: messageId });
      expect(f.dispatch).not.toHaveBeenCalled();
      await input.accept({ type: 'user', content: 'screened' }, {});
    });
    expect(await f.admission.accept(f.request)).toEqual({ turnId: 'running' });
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ threadId: 'task', expectedTurnId: 'running',
      clientUserMessageId: messageId, input: [{ type: 'text', text: 'screened' }] });
  });
  it.each(['task', 'turn', 'identity', 'context'] as const)('rejects mismatched %s before policy or dispatch', async kind => {
    const f = fixture();
    const params = { ...f.request.params, ...(kind === 'task' ? { threadId: 'foreign' } : {}),
      ...(kind === 'turn' ? { expectedTurnId: 'old' } : {}), ...(kind === 'identity' ? { clientUserMessageId: null } : {}),
      ...(kind === 'context' ? { additionalContext: [{ text: 'unreviewed' }] } : {}) };
    await expect(f.admission.accept({ ...f.request, params })).rejects.toBeInstanceOf(TurnDispatchRejectedError);
    expect(f.owner).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(['thread', 'turn', 'close', 'abort', 'owner'] as const)('fences pending preparation after %s changes', async kind => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      if (kind === 'thread') f.replaceThread();
      if (kind === 'turn') f.replaceTurn();
      if (kind === 'close') f.admission.close();
      if (kind === 'abort') f.controller.abort();
      if (kind === 'owner') f.admission.bind(async () => {});
      await input.accept(input.message, {});
    });
    await expect(f.admission.accept(f.request)).rejects.toBeInstanceOf(TurnDispatchRejectedError);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('does not conflate identical text with identity or replay a continuation', async () => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      await expect(f.admission.accept(f.request)).rejects.toThrow('reservation');
      await input.accept(input.message, {});
      await expect(input.accept(input.message, {})).rejects.toThrow('already admitted');
    });
    await f.admission.accept(f.request);
    await f.admission.accept({ ...f.request, params: { ...f.request.params, clientUserMessageId: '676c9703-2253-4dc2-8b4b-9fe8832d9811' } });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('preserves native mentions and image bytes with managed history identities', async () => {
    const f = fixture();
    const image = { type: 'image' as const, url: 'data:image/png;base64,fixture' };
    const media = vi.fn(async () => ({ type: 'image' as const, path: '/fixture', managedUrl: 'cindy-media://blobs/fixture' }));
    f.admission.bind(f.owner, media);
    const input = [{ type: 'mention' as const, name: 'reference', path: '/reference' }, image];
    await f.admission.accept({ ...f.request, params: { ...f.request.params, input } });
    expect(media).toHaveBeenCalledOnce(); expect(f.dispatch.mock.calls[0]![0].input).toEqual(input);
  });
  it('keeps uncertainty after a missing or foreign receipt and never dispatches twice', async () => {
    const f = fixture(); f.dispatch.mockRejectedValue(new Error('lost response'));
    await expect(f.admission.accept(f.request)).rejects.toBeInstanceOf(TurnDispatchUnconfirmedError);
    expect(f.dispatch).toHaveBeenCalledOnce();
    f.dispatch.mockResolvedValue({ turnId: 'other' });
    await expect(f.admission.accept(f.request)).rejects.toBeInstanceOf(TurnDispatchUnconfirmedError);
  });
  it('retains confirmed acceptance after turn completion, cancellation or product persistence failure', async () => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      await input.accept(input.message, {}); f.endTurn(); f.controller.abort();
      throw new Error('history persistence failed');
    });
    expect(await f.admission.accept(f.request)).toEqual({ turnId: 'running' });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
});

describe('native input consumption on a continuous root stream', () => {
  const item = (clientId: string, turnId = 'running', threadId = 'task') => ({
    threadId, turnId, item: { type: 'userMessage', id: 'item-' + clientId, clientId },
  });
  it.each(['before', 'after'])('uses actual native user identity when consumption arrives %s receipt', async when => {
    const f = fixture();
    if (when === 'before') f.dispatch.mockImplementation(async () => {
      f.admission.consumption.itemStarted(item(messageId)); return { turnId: 'running' };
    });
    await f.admission.accept(f.request);
    const observation = f.owner.mock.calls[0]![0].consumption!;
    if (when === 'after') {
      expect(observation.read().status).toBe('pending');
      f.admission.consumption.itemStarted(item(messageId));
    }
    expect(await observation.settled).toEqual({ version: 1, engine: 'codex', sessionId: 'task',
      turnId: 'running', messageId, status: 'consumed', itemId: 'item-' + messageId });
    f.admission.consumption.turnCompleted('task', 'running');
    f.admission.close();
    expect(observation.read().status).toBe('consumed');
  });
  it('keeps terminal-before-receipt unconsumed rather than presenting it as an executed steer', async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async () => {
      f.admission.consumption.turnCompleted('task', 'running'); f.endTurn();
      return { turnId: 'running' };
    });
    expect(await f.admission.accept(f.request)).toEqual({ turnId: 'running' });
    const observation = f.owner.mock.calls[0]![0].consumption!;
    expect((await observation.settled).status).toBe('unconsumed');
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('does not assign a matching text from a later Escape turn to the unconsumed original', async () => {
    const f = fixture(); await f.admission.accept(f.request);
    const original = f.owner.mock.calls[0]![0].consumption!;
    f.admission.consumption.turnCompleted('task', 'running');
    const next = f.admission.consumption.begin('task', 'next', 'distinct-uuid');
    f.admission.consumption.itemStarted(item('distinct-uuid', 'next'));
    expect((await original.settled).status).toBe('unconsumed');
    expect((await next.settled).status).toBe('consumed');
    expect(original.read().messageId).toBe(messageId);
  });
  it('ignores foreign thread/turn/client and non-user items; one input cannot consume its neighbors', async () => {
    const f = fixture(); await f.admission.accept(f.request);
    const observation = f.owner.mock.calls[0]![0].consumption!;
    for (const event of [item(messageId, 'foreign'), item(messageId, 'running', 'foreign'), item('foreign'),
      { ...item(messageId), item: { ...item(messageId).item, type: 'agentMessage' } }]) {
      f.admission.consumption.itemStarted(event);
      expect(observation.read().status).toBe('pending');
    }
    f.admission.consumption.turnCompleted('foreign', 'running');
    f.admission.consumption.turnCompleted('task', 'foreign');
    expect(observation.read().status).toBe('pending');
    const other = f.admission.consumption.begin('task', 'running', 'other');
    f.admission.consumption.itemStarted(item(messageId));
    expect(observation.read().status).toBe('consumed');
    expect(other.read().status).toBe('pending');
    f.admission.consumption.turnCompleted('task', 'running');
    expect((await other.settled).status).toBe('unconsumed');
  });
  it.each(['disconnect', 'close', 'replacement'])('preserves unknown after %s even if a late terminal arrives', async reason => {
    const f = fixture(); await f.admission.accept(f.request);
    const observation = f.owner.mock.calls[0]![0].consumption!;
    if (reason === 'disconnect') f.admission.consumption.disconnect();
    if (reason === 'close') f.admission.close();
    if (reason === 'replacement') f.admission.bind(async () => {});
    f.admission.consumption.turnCompleted('task', 'running');
    expect((await observation.settled).status).toBe('unknown');
    expect(observation.read().status).toBe('unknown');
  });
  it('does not retroactively claim uncertainty after an observed consumption and lost response', async () => {
    const f = fixture(); f.dispatch.mockImplementation(async () => {
      f.admission.consumption.itemStarted(item(messageId)); throw new Error('lost receipt');
    });
    await expect(f.admission.accept(f.request)).rejects.toBeInstanceOf(TurnDispatchUnconfirmedError);
    expect(f.owner.mock.calls[0]![0].consumption!.read().status).toBe('consumed');
  });
  it('settles missing receipts as unknown without holding pending entries or replaying input', async () => {
    const f = fixture(); f.dispatch.mockRejectedValue(new Error('lost response'));
    await expect(f.admission.accept(f.request)).rejects.toBeInstanceOf(TurnDispatchUnconfirmedError);
    expect((await f.owner.mock.calls[0]![0].consumption!.settled).status).toBe('unknown');
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
});
