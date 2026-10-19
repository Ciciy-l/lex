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
