import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  clearEntryLoadRetry,
  isRetryableViteEntryLoadError,
  reserveEntryLoadRetry,
  type EntryLoadRetryStorage,
} from '../entryLoadRecovery';

const rendererRoot = resolve(__dirname, '..', '..');
const desktopRoot = resolve(rendererRoot, '..', '..');
const rendererIndexSource = readFileSync(resolve(rendererRoot, 'index.tsx'), 'utf8');
const mainEntrySource = readFileSync(resolve(rendererRoot, 'main-entry.tsx'), 'utf8');

function storage(): EntryLoadRetryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe('entry load recovery', () => {
  it('propagates a deferred App import failure to the entry recovery boundary', () => {
    expect(mainEntrySource).toContain('export const mainEntryReady: Promise<void> = (async () => {');
    expect(mainEntrySource).toContain("const { App } = await import('./App');");
    expect(rendererIndexSource).toContain(
      "import('./main-entry').then(({ mainEntryReady }) => mainEntryReady)",
    );
  });

  it('recognizes Vite optimize-deps handoff failures but not arbitrary entry errors', () => {
    expect(
      isRetryableViteEntryLoadError(
        new TypeError('Failed to fetch dynamically imported module: http://localhost:5174/App.tsx'),
      ),
    ).toBe(true);
    expect(
      isRetryableViteEntryLoadError(
        new Error('The file is in the optimize deps directory and is unavailable'),
      ),
    ).toBe(true);
    expect(isRetryableViteEntryLoadError(new Error('Unexpected application failure'))).toBe(false);
  });

  it('permits one reload and reopens the retry after a successful entry load', () => {
    const retryStorage = storage();
    expect(reserveEntryLoadRetry(retryStorage)).toBe(true);
    expect(reserveEntryLoadRetry(retryStorage)).toBe(false);
    clearEntryLoadRetry(retryStorage);
    expect(reserveEntryLoadRetry(retryStorage)).toBe(true);
  });

  it('uses the fixed no-cache recovery bridge in every renderer preload', () => {
    const bridge = rendererIndexSource.indexOf('window.electronAPI?.recoverViteDependencyLoad');
    const legacyFallback = rendererIndexSource.indexOf('window.location.reload()', bridge);

    expect(bridge).toBeGreaterThanOrEqual(0);
    expect(legacyFallback).toBeGreaterThan(bridge);

    for (const preload of [
      'preload/preload.ts',
      'preload/sidebarWindowPreload.ts',
      'preload/resourceUsagePreload.ts',
      'preload/ghostPanelWindowPreload.ts',
    ]) {
      const source = readFileSync(resolve(desktopRoot, 'src', preload), 'utf8');
      expect(source).toContain("ipcRenderer.send('renderer:recover-vite-deps')");
    }
  });
});
