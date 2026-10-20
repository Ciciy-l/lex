import { describe, expect, it, vi } from 'vitest';
import type { AgentNativeInputRequest } from '../native-input.js';
import { resolveClaudeNativeInput } from './native-input-adapter.js';
import type { ClaudeNativeInputPreparation } from './native-input-preparation.js';

function fixture(content: unknown[]) {
  const input: ClaudeNativeInputPreparation = { row: { sessionId: 'native', uuid: 'row', door: 'prompt',
    origin: { kind: 'composer' }, message: { type: 'user', content } },
    signal: new AbortController().signal, accept: vi.fn(async () => {}) };
  return input;
}

describe('native composer into Session admission', () => {
  it('retains native UUID/source and installs host text rewriting into the same row', async () => {
    const input = fixture([{ type: 'text', text: 'original' }]);
    const controller = new AbortController();
    await resolveClaudeNativeInput(input, async request => {
      expect(request).toMatchObject({ nativeSessionId: 'native', nativeMessageId: 'row',
        source: { origin: { kind: 'composer' }, messageId: 'row' } });
      await request.accept({ type: 'user', content: 'host rewritten' }, { signal: controller.signal });
    });
    expect(input.accept).toHaveBeenCalledWith([{ type: 'text', text: 'host rewritten' }], controller.signal);
  });

  it('round-trips imported media by identity and permits vision conversion without reading a filesystem', async () => {
    const native = { type: 'image', source: { type: 'base64', data: 'fixture', media_type: 'image/png' } };
    const imported = { type: 'image' as const, path: '/host/blob.png', managedUrl: 'cindy-media://blobs/abc.png' };
    const importer = vi.fn(async () => imported);
    const input = fixture([{ type: 'text', text: 'look' }, native]);
    await resolveClaudeNativeInput(input, async request => {
      expect(request.message.content).toEqual([{ type: 'text', text: 'look' }, imported]);
      await request.accept(request.message, {});
    }, importer);
    expect(input.accept).toHaveBeenCalledWith(input.row.message.content, undefined);
    expect(importer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native', messageId: 'row', index: 1, block: native }));
    const converted = fixture([native]);
    await resolveClaudeNativeInput(converted, async request => {
      await request.accept({ type: 'user', content: 'vision description' }, {});
    }, importer);
    expect(converted.accept).toHaveBeenCalledWith([{ type: 'text', text: 'vision description' }], undefined);
  });

  it('rejects missing import, swapped media and cancellation without changing the native row', async () => {
    const input = fixture([{ type: 'image', source: { data: 'fixture' } }]);
    const resolve = vi.fn();
    await expect(resolveClaudeNativeInput(input, resolve)).rejects.toThrow('importer');
    expect(resolve).not.toHaveBeenCalled();
    await expect(resolveClaudeNativeInput(input, async request => {
      await request.accept({ type: 'user', content: [{ type: 'image', path: '/foreign' }] }, {});
    }, async () => ({ type: 'image', path: '/owned' }))).rejects.toThrow('replace');
    const controller = new AbortController(); controller.abort();
    await expect(resolveClaudeNativeInput({ ...input, signal: controller.signal }, resolve)).rejects.toThrow('cancelled');
    expect(input.accept).not.toHaveBeenCalled();
  });

  it('keeps external plugin provenance without minting a built-in bridge association', async () => {
    const input = fixture([{ type: 'text', text: 'plugin envelope' }]); input.row.origin = { kind: 'plugin', name: 'lex-native-bridge' };
    let request!: AgentNativeInputRequest;
    await resolveClaudeNativeInput(input, async value => { request = value; });
    expect(request.source?.origin.name).toBe('lex-native-bridge');
    expect(request.source?.bridge).toBeUndefined();
    expect(request.message.content).toEqual(input.row.message.content);
  });
});
