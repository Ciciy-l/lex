import { describe, expect, it } from 'vitest';
import { assertRendererSessionSourceAllowed } from '../sessionSourceGuard';

describe('assertRendererSessionSourceAllowed', () => {
  it('allows the ordinary renderer create path to omit a source', async () => {
    await expect(assertRendererSessionSourceAllowed({ source: undefined })).resolves.toBeUndefined();
  });

  it.each(['desktop', 'bot', 'review', 'plugin', 'cindy-make', null, 42])(
    'rejects a renderer-selected source %s',
    async (source) => {
      await expect(assertRendererSessionSourceAllowed({ source })).rejects.toThrow(
        /\[UNSUPPORTED_CAPABILITY\]/,
      );
    },
  );
});
