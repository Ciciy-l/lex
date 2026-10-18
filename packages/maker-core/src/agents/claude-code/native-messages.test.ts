import { describe, expect, it, vi } from 'vitest';
import { ClaudeNativeMessages, claudeNativeMessageSource, type ClaudeNativeSubmission, type ClaudeNativeUserMessage } from './native-messages.js';
import { nativeMessagePluginSource } from '@cindy/maker-shared/message-presentation';

const input = (): ClaudeNativeSubmission => ({ messageId: 'host-message', text: 'same text',
  originalContent: [{ type: 'text', text: 'same text' }, { type: 'image', managedUrl: 'cindy-media://image' }] });
function row(uuid: string, submissionId?: number, name = 'lex-native-bridge') {
  return { sequence: 1, kind: 'session.append', value: { uuid, door: 'prompt', origin: { kind: 'plugin', name },
    message: { type: 'user', content: [{ type: 'text', text: 'proposal' }] },
    result: { uuid, message: { type: 'user', content: [{ type: 'text', text: 'actual native envelope' }] } },
    ...(submissionId ? { submissionId } : {}) } };
}
function fixture() {
  const onMessage = vi.fn(), messages = new ClaudeNativeMessages('session', onMessage);
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const enqueue = vi.fn(() => ({ id: 1, result }));
  return { messages, onMessage, enqueue, resolve, reject };
}

describe('authenticated native message association', () => {
  it('derives durable provenance from accepted rows rather than trusting a display hint', () => {
    const message: ClaudeNativeUserMessage = { row: { sessionId: 'native', uuid: 'row', door: 'prompt',
      origin: { kind: 'plugin', name: 'lex-native-bridge' }, message: { type: 'user', content: [] } },
      display: { content: [] }, submission: { sessionId: 'native', nativeMessageId: 'row',
        submissionId: 'host-input', pluginName: 'lex-native-bridge', originalContent: [] } };
    const trusted = claudeNativeMessageSource(message);
    expect(trusted.bridge?.submissionId).toBe('host-input');
    expect(nativeMessagePluginSource(trusted)).toBeUndefined();
    message.submission!.nativeMessageId = 'other';
    const mismatched = claudeNativeMessageSource(message);
    expect(mismatched.bridge).toBeUndefined();
    expect(nativeMessagePluginSource(mismatched)).toBe('lex-native-bridge');
  });
  it('binds the original immutable input before its native receipt and retains the actual stored row', async () => {
    const f = fixture(), original = input(), pending = f.messages.submit(original, f.enqueue);
    original.originalContent = []; original.text = 'changed later';
    f.messages.accept(row('native', 1));
    f.messages.accept({ sequence: 2, kind: 'command-result', value: { id: 1, ok: true } }); f.resolve({});
    expect(await pending).toEqual({ nativeMessageId: 'native' });
    expect(f.enqueue).toHaveBeenCalledWith({ text: 'same text' });
    expect(f.onMessage.mock.calls[0][0]).toMatchObject({
      display: { content: input().originalContent },
      row: { uuid: 'native', message: { content: [{ type: 'text', text: 'actual native envelope' }] } },
      submission: { submissionId: 'host-message', nativeMessageId: 'native', sessionId: 'session' },
    });
    expect(f.onMessage.mock.calls[0][0].display.pluginSource).toBeUndefined();
  });

  it('preserves third-party and unbound same-name sources without text matching', async () => {
    const f = fixture(), pending = f.messages.submit(input(), f.enqueue);
    f.messages.accept(row('other', 1, 'third-party'));
    f.messages.accept(row('unbound'));
    f.messages.accept(row('ours', 1));
    f.messages.accept(row('later', 1));
    f.resolve({}); await pending;
    expect(f.onMessage.mock.calls.map(([message]) => [message.row.uuid, message.display.pluginSource])).toEqual([
      ['other', 'third-party'], ['unbound', 'lex-native-bridge'], ['ours', undefined], ['later', 'lex-native-bridge'],
    ]);
  });

  it('keeps the identity after an uncertain result without submitting it again', async () => {
    const f = fixture(), pending = f.messages.submit(input(), f.enqueue);
    f.reject(new Error('outcome unconfirmed')); await expect(pending).rejects.toThrow('unconfirmed');
    expect(() => f.messages.submit(input(), f.enqueue)).toThrow('already pending');
    f.messages.accept(row('late-native', 1));
    expect(f.onMessage.mock.calls[0][0].display.pluginSource).toBeUndefined();
    expect(f.enqueue).toHaveBeenCalledOnce();
  });

  it('does not report accepted input when native hooks drop it before appending', async () => {
    const f = fixture(), pending = f.messages.submit(input(), f.enqueue);
    f.resolve({ drop: 'native hook' });
    await expect(pending).rejects.toThrow('not recorded');
    expect(f.onMessage).not.toHaveBeenCalled();
  });

  it('emits original composer input once while excluding tool-result, sidechain and meta rows', () => {
    const f = fixture();
    const event = row('native'); event.value.origin = { kind: 'composer', name: '' };
    f.messages.accept(event);
    f.messages.accept({ ...event, value: { ...event.value, door: 'tool-result' } });
    f.messages.accept({ ...event, value: { ...event.value, agentId: 'child' } });
    f.messages.accept({ ...event, value: { ...event.value, result: { ...event.value.result, message: { type: 'user', isMeta: true, content: [] } } } });
    expect(f.onMessage).toHaveBeenCalledOnce();
    expect(f.onMessage.mock.calls[0][0].display).toEqual({ content: event.value.result.message.content });
  });

  it('binds media only to its authenticated command row and retains managed image identity', async () => {
    const f = fixture(), original = { ...input(), imagePaths: ['/owned/image.png'] };
    const pending = f.messages.submit(original, f.enqueue);
    const command = row('command', 1); command.value.door = 'command';
    f.messages.accept({ ...command, value: { ...command.value, submissionKind: 'media' } });
    f.resolve({ uuid: 'command' });
    expect(await pending).toEqual({ nativeMessageId: 'command' });
    expect(f.onMessage.mock.calls[0][0]).toMatchObject({
      display: { content: original.originalContent }, submission: { inputKind: 'media' },
    });
  });
});
