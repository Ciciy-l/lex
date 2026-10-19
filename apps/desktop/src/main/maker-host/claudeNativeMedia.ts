import { createNativeImageMediaImporter } from './nativeImageMedia.js';

/** Claude's original composer reports its resolved image bytes. */
export function createClaudeNativeMediaImporter(context: Parameters<typeof createNativeImageMediaImporter>[0]) {
  return createNativeImageMediaImporter(context, block => {
    const raw = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null;
    const source = raw?.source;
    if (raw?.type !== 'image' || source?.type !== 'base64'
      || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
      throw new Error('Native attachment requires supported image bytes');
    }
    return { data: source.data, mimeType: source.media_type };
  });
}
