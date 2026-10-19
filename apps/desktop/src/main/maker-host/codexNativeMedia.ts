import { createNativeImageMediaImporter } from './nativeImageMedia.js';

/** Codex's remote native frontend converts its local images into data URLs. */
export function createCodexNativeMediaImporter(context: Parameters<typeof createNativeImageMediaImporter>[0]) {
  return createNativeImageMediaImporter(context, block => {
    const raw = block as { type?: unknown; url?: unknown } | null;
    if (raw?.type !== 'image' || typeof raw.url !== 'string') {
      throw new Error('Native Codex attachment requires resolved image bytes');
    }
    const header = /^data:(image\/(?:png|jpeg|gif|webp));base64,/.exec(raw.url);
    if (!header) throw new Error('Native Codex attachment requires a supported image data URL');
    return { data: raw.url.slice(header[0].length), mimeType: header[1]! };
  });
}
