import { describe, expect, it, vi } from 'vitest';
import { prepareClaudeNativeInputContent } from './native-input-content.js';

const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'ZmFrZQ==' } };
const stored = { type: 'image' as const, path: '/owned/fixture.png', managedUrl: 'cindy-media://blobs/fixture.png', pathOrigin: 'desktop-host' as const };
describe('native GUI input uses the existing task media owner', () => {
  it('passes prepared bytes and native identity to the account-bound importer', async () => {
    const importMedia = vi.fn(async () => stored), signal = new AbortController().signal;
    const result = await prepareClaudeNativeInputContent([{ type: 'text', text: 'first' }, image, { type: 'text', text: 'second' }],
      { nativeSessionId: 'native', signal, importMedia });
    expect(result).toEqual({ text: ['first', 'second'].join(String.fromCharCode(10)), imagePaths: [stored.path] });
    expect(importMedia).toHaveBeenCalledWith({ sessionId: 'native', messageId: expect.any(String), index: 1, block: image, signal });
  });

  it('refuses missing media ownership, remote paths and cancellation after import', async () => {
    const controller = new AbortController(), options = { nativeSessionId: 'native', signal: controller.signal };
    await expect(prepareClaudeNativeInputContent([image], options)).rejects.toThrow('media owner');
    await expect(prepareClaudeNativeInputContent([image], { ...options, importMedia: async () => ({ ...stored, pathOrigin: 'remote' as never }) })).rejects.toThrow('managed local identity');
    await expect(prepareClaudeNativeInputContent([image], { ...options, importMedia: async () => { controller.abort(); return stored; } })).rejects.toThrow('cancelled');
  });
});
