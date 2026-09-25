import type { CodexModelListItem, CodexModelListResponse } from './protocol.js';

export async function listCodexModels(
  readPage: (cursor: string | null) => Promise<CodexModelListResponse>,
): Promise<CodexModelListItem[]> {
  const models: CodexModelListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await readPage(cursor);
    if (!page || !Array.isArray(page.data)) throw new Error('Invalid Codex model list');
    models.push(...page.data);
    const next = page.nextCursor;
    if (next == null || next === '') return models;
    if (typeof next !== 'string' || seenCursors.has(next)) {
      throw new Error('Invalid Codex model list cursor');
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error('Codex model list page limit exceeded');
}
