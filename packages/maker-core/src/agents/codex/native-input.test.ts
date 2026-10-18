import { describe, expect, it, vi } from 'vitest';
import { CodexNativeInputAdmission, CODEX_NATIVE_TURN, type CodexNativeSendOptions } from './native-input.js';
import { TurnDispatchUnconfirmedError } from '../base-agent.js';
import type { AgentNativeInputRequest } from '../native-input.js';
import type { UserMessage } from '../../types/common.js';
import type { TurnStartParams } from './app-server/protocol.js';

const messageId = '676c9703-2253-4dc2-8b4b-9fe8832d9810';
function fixture() {
  const lifetime = new AbortController();
  let id = 'thread';
  const dispatch = vi.fn(async (_params: TurnStartParams) => ({ turn: { id: 'turn' } }));
  const send = vi.fn(async (message: UserMessage, options: CodexNativeSendOptions) => {
    const native = options[CODEX_NATIVE_TURN]!;
    await native.start({ threadId: id, input: native.input(message), approvalPolicy: 'untrusted', model: 'selected-model' });
  });
  const admission = new CodexNativeInputAdmission(() => id, send);
  const owner = vi.fn(async (input: AgentNativeInputRequest) => input.accept(input.message, {}));
  admission.bind(owner);
  const request = { params: { threadId: id, clientUserMessageId: messageId, input: [{ type: 'text' as const, text: 'native input' }] },
    signal: lifetime.signal, dispatch };
  return { admission, request, owner, send, dispatch, lifetime, replace: () => { id = 'replacement'; } };
}

describe('Codex native input reservation', () => {
  it('refuses a foreign task or a missing original message identity before invoking the owner', async () => {
    const f = fixture();
    await expect(f.admission.accept({ ...f.request, params: { ...f.request.params, threadId: 'other' } })).rejects.toThrow('reservation');
    await expect(f.admission.accept({ ...f.request, params: { ...f.request.params, clientUserMessageId: null } })).rejects.toThrow('reservation');
    expect(f.owner).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('passes the original identity through the product owner and forwards exactly once with host policy', async () => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(input).toMatchObject({ nativeSessionId: 'thread', nativeMessageId: messageId });
      await input.accept({ type: 'user', content: 'prepared native input' }, { planMode: true });
    });
    expect(await f.admission.accept(f.request)).toEqual({ turn: { id: 'turn' } });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![1]).toMatchObject({ messageUuid: messageId, throwOnStartFailure: true, planMode: true });
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', clientUserMessageId: messageId,
      input: [{ type: 'text', text: 'prepared native input' }], approvalPolicy: 'untrusted', model: 'selected-model' });
  });

  it('retains native skill/mention and text metadata when the host keeps the original blocks', async () => {
    const f = fixture();
    const params: TurnStartParams = { ...f.request.params, input: [
      { type: 'skill', name: 'review', path: '/owned/skill' }, { type: 'mention', name: 'plugin', path: 'plugin://example' },
      { type: 'text', text: 'native', text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: 'native' }] } as TurnStartParams['input'][number],
    ] };
    await f.admission.accept({ ...f.request, params });
    expect(f.dispatch.mock.calls[0]![0].input).toEqual(params.input);
  });

  it('imports images for product history while forwarding the original native bytes exactly once', async () => {
    const f = fixture();
    const image = { type: 'image' as const, url: 'data:image/png;base64,fixture' };
    const importer = vi.fn(async () => ({ type: 'image' as const, path: '/owned/image.png', managedUrl: 'cindy-media://blobs/fixture' }));
    f.admission.bind(f.owner, importer);
    await f.admission.accept({ ...f.request, params: { ...f.request.params, input: [image] } });
    expect(importer).toHaveBeenCalledOnce();
    expect(f.owner.mock.calls[0]![0].message.content).toEqual([{ type: 'image', path: '/owned/image.png', managedUrl: 'cindy-media://blobs/fixture' }]);
    expect(f.dispatch.mock.calls[0]![0].input).toEqual([image]);
  });

  it('refuses new host attachments instead of silently dropping or substituting them', async () => {
    const f = fixture(); f.owner.mockImplementation(async input => input.accept({ type: 'user', content: [{ type: 'image', path: '/unknown' }] }, {}));
    await expect(f.admission.accept(f.request)).rejects.toThrow('unprepared attachment');
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(['owner', 'thread', 'cancel', 'close'] as const)('fences a pending input after %s changes', async kind => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      if (kind === 'owner') f.admission.bind(async () => {});
      if (kind === 'thread') f.replace();
      if (kind === 'cancel') f.lifetime.abort();
      if (kind === 'close') f.admission.close();
      await input.accept(input.message, {});
    });
    await expect(f.admission.accept(f.request)).rejects.toThrow('no longer active');
    expect(f.send).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('rejects competing inputs and reusing the same admission continuation', async () => {
    const f = fixture();
    f.owner.mockImplementation(async input => {
      await expect(f.admission.accept(f.request)).rejects.toThrow('reservation');
      await input.accept(input.message, {});
      await expect(input.accept(input.message, {})).rejects.toThrow('already admitted');
    });
    await f.admission.accept(f.request); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('does not claim acceptance when the owner never dispatches, and preserves uncertainty after a lost receipt', async () => {
    const f = fixture(); f.owner.mockImplementation(async () => {});
    await expect(f.admission.accept(f.request)).rejects.toThrow('not accepted');
    expect(f.dispatch).not.toHaveBeenCalled();
    f.owner.mockImplementation(async input => input.accept(input.message, {}));
    f.dispatch.mockRejectedValue(new Error('connection lost'));
    await expect(f.admission.accept(f.request)).rejects.toBeInstanceOf(TurnDispatchUnconfirmedError);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
});
