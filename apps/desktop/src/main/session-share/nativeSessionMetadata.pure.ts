/** Only native identity fields are capabilities. Never rewrite text or arbitrary path strings. */
const ID_FIELDS = new Set(['sdkSessionId', 'fromSdkSessionId', 'toSdkSessionId', 'sourceSdkSessionId']);
function visit(value: unknown, map: (id: string) => string | undefined): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (ID_FIELDS.has(key) && typeof child === 'string') {
      const mapped = map(child);
      if (mapped) (value as Record<string, unknown>)[key] = mapped;
      else delete (value as Record<string, unknown>)[key];
    } else if (child && typeof child === 'object') visit(child, map);
  }
}
export function nativeMetadataIds(raw: string | null): string[] {
  const ids = new Set<string>();
  try { visit(JSON.parse(raw ?? '{}'), (id) => { if (id) ids.add(id); return id; }); } catch { /* Legacy non-JSON metadata. */ }
  return [...ids];
}
export function rewriteNativeMetadata(raw: string | null, ids: ReadonlyMap<string, string>): string | null {
  if (!raw) return raw;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    visit(value, (id) => ids.get(id));
    return JSON.stringify(value);
  } catch { return null; }
}
