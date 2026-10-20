import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';
import type { AttachedFile, BrowserCommentDraftItem, ComposerDraftContent } from './composerDraft';

// Bound both traversal and serialized size before parsing untrusted IPC/disk data.
export const COMPOSER_DRAFT_MAX_BYTES = 8 * 1024 * 1024;
export const COMPOSER_DRAFT_FILE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 1000;

export function isBoundedComposerDraftValue(value: unknown): boolean {
  const queue = [{ value, depth: 0 }];
  let nodes = 0;
  let size = 0;
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (++nodes > 100_000 || item.depth > 64) return false;
    const v = item.value;
    if (typeof v === 'string') size += v.length;
    else if (typeof v === 'number') { if (!Number.isFinite(v)) return false; }
    else if (v !== null && typeof v === 'object') {
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) return false;
      const values = Object.entries(v);
      if (values.length + queue.length > 100_000) return false;
      for (const [key, child] of values) {
        size += key.length;
        queue.push({ value: child, depth: item.depth + 1 });
      }
    } else if (v !== null && v !== undefined && typeof v !== 'boolean') return false;
    if (size > COMPOSER_DRAFT_MAX_BYTES) return false;
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= COMPOSER_DRAFT_MAX_BYTES; }
  catch { return false; }
}

const document: z.ZodType<JSONContent> = z.lazy(() => z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  marks: z.array(z.object({
    type: z.string(), attrs: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).optional(),
  content: z.array(document).optional(),
}).passthrough());

const point = z.object({ x: z.number(), y: z.number() });
const dimensions = z.object({ width: z.number(), height: z.number() });
const attachment: z.ZodType<AttachedFile> = z.object({
  id: z.string(), name: z.string(), path: z.string(), ext: z.string(),
  size: z.number().nonnegative(),
  category: z.enum(['image', 'pdf', 'text', 'office', 'file']), mimeType: z.string(),
  url: z.string().optional(), originalName: z.string().optional(),
  base64: z.string().optional(), textContent: z.string().optional(),
  truncated: z.boolean().optional(), annotated: z.boolean().optional(),
  annotationSourceUrl: z.string().optional(),
  annotationStrokes: z.array(z.object({ points: z.array(point) })).optional(),
  cacheUrlShared: z.boolean().optional(),
});
const comment: z.ZodType<BrowserCommentDraftItem> = z.object({
  id: z.string(), markerNumber: z.number(), pageUrl: z.string(), comment: z.string(),
  screenshot: attachment,
  styleChanges: z.array(z.object({
    property: z.string(), previousValue: z.string(), value: z.string(),
  })).optional(),
  target: z.object({
    kind: z.enum(['element', 'region', 'text']), point, viewport: dimensions,
    region: point.extend(dimensions.shape).nullable(), selectedText: z.string().nullable(),
    immediate: z.boolean(), targetTag: z.string().nullable(), targetLabel: z.string().nullable(),
    targetRole: z.string().nullable(), targetSelector: z.string().nullable(),
    targetPath: z.string().nullable(), nearbyText: z.string().nullable(),
    themeVariant: z.enum(['light', 'dark']).nullable(), markerNumber: z.number(),
    designBaseline: z.object({
      styles: z.record(z.string(), z.string()), editableText: z.string().nullable(),
      provenance: z.record(z.string(), z.string()),
    }).nullable(),
  }),
});
export const composerDraftContentSchema: z.ZodType<ComposerDraftContent> = z.unknown()
  .refine(isBoundedComposerDraftValue).pipe(z.object({
  text: document.nullable(), attachments: z.array(attachment),
  browserComments: z.array(comment).optional(),
}));
export const composerDraftKeySchema = z.string().min(1).max(512);
export const composerDraftEntriesSchema = z.array(z.object({
  key: composerDraftKeySchema, content: composerDraftContentSchema,
})).max(MAX_ENTRIES).refine(entries => new Set(entries.map(entry => entry.key)).size === entries.length);

export function getComposerDraftContentUrls(content: ComposerDraftContent): string[] {
  const urls: string[] = [];
  for (const file of [...content.attachments, ...(content.browserComments ?? []).map(c => c.screenshot)]) {
    if (file.url) urls.push(file.url);
    if (file.annotationSourceUrl) urls.push(file.annotationSourceUrl);
  }
  return urls;
}
