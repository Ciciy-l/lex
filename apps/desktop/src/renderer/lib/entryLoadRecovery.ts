/**
 * Dev-only recovery for Vite's optimize-deps handoff.
 *
 * Electron Forge can open a renderer as Vite finishes replacing a dependency
 * prebundle. The initial dynamic entry import may then still point at a chunk
 * from the preceding prebundle generation. A single page reload obtains the
 * current module graph; the session marker prevents an actual source error
 * from looping forever.
 */

export const ENTRY_LOAD_RETRY_STORAGE_KEY = 'lex:renderer-entry-load-retry';

export interface EntryLoadRetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isRetryableViteEntryLoadError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('optimize deps directory') ||
    message.includes('node_modules/.vite/deps')
  );
}

/** Returns true exactly once per unsuccessful entry-load cycle. */
export function reserveEntryLoadRetry(storage: EntryLoadRetryStorage): boolean {
  try {
    if (storage.getItem(ENTRY_LOAD_RETRY_STORAGE_KEY) === '1') return false;
    storage.setItem(ENTRY_LOAD_RETRY_STORAGE_KEY, '1');
    return true;
  } catch {
    // Storage can be unavailable in a restricted/failed renderer. Logging the
    // original error is safer than attempting an unbounded reload.
    return false;
  }
}

export function clearEntryLoadRetry(storage: EntryLoadRetryStorage): void {
  try {
    storage.removeItem(ENTRY_LOAD_RETRY_STORAGE_KEY);
  } catch {
    // Best effort only; a later entry failure will still be reported normally.
  }
}
