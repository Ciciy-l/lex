import { createNativeImageMediaImporter } from './nativeImageMedia.js';

/** Original Pi journal image blocks carry resolved bytes, never renderer paths. */
export function createPiNativeMediaImporter(context: Parameters<typeof createNativeImageMediaImporter>[0]) {
  return createNativeImageMediaImporter(context, block => {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image'
      || !('data' in block) || typeof block.data !== 'string'
      || !('mimeType' in block) || typeof block.mimeType !== 'string') {
      throw new Error('Native attachment requires supported image bytes');
    }
    return { data: block.data, mimeType: block.mimeType };
  });
}
