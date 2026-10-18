import { randomUUID } from 'node:crypto';
import type { AgentNativeMediaResolver } from '../native-input.js';

type Image = { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };
type Content = string | Array<{ type: 'text'; text: string } | Image>;

/** The existing account/task media importer owns prepared image bytes and lifetime. */
export async function prepareClaudeNativeInputContent(content: Content, options: {
  nativeSessionId: string;
  signal: AbortSignal;
  importMedia?: AgentNativeMediaResolver;
}): Promise<{ text: string; imagePaths?: string[] }> {
  const live = () => { if (options.signal.aborted) throw new Error('Native Claude input preparation cancelled'); };
  live();
  if (typeof content === 'string') return { text: content };
  const imagePaths: string[] = [], messageId = randomUUID();
  for (const [index, block] of content.entries()) {
    if (block.type !== 'image') continue;
    if (!options.importMedia) throw new Error('Native Claude image has no product media owner');
    const stored = await options.importMedia({ sessionId: options.nativeSessionId, messageId, index,
      block, signal: options.signal });
    live();
    if (stored.type !== 'image' || stored.pathOrigin !== 'desktop-host' || !stored.managedUrl || !stored.path) {
      throw new Error('Native Claude image did not receive a managed local identity');
    }
    imagePaths.push(stored.path);
  }
  return { text: content.flatMap(block => block.type === 'text' ? [block.text] : []).join(String.fromCharCode(10)),
    ...(imagePaths.length ? { imagePaths } : {}) };
}
