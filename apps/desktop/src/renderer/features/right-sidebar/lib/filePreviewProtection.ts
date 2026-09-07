// Shared by navigation and persistence; no dependency on the tab store.
const protectedPreviews = new Map<string, number>();
const keyFor = (sessionId: string, tabId: string) => JSON.stringify([sessionId, tabId]);
export function isFilePreviewProtected(sessionId: string, tabId: string): boolean {
  return protectedPreviews.has(keyFor(sessionId, tabId));
}
export function protectFilePreview(sessionId: string, tabId: string): () => void {
  const key = keyFor(sessionId, tabId);
  protectedPreviews.set(key, (protectedPreviews.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = protectedPreviews.get(key) ?? 0;
    if (count <= 1) protectedPreviews.delete(key);
    else protectedPreviews.set(key, count - 1);
  };
}
