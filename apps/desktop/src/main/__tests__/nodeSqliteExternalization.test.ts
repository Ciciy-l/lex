import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = resolve(__dirname, '..', '..', '..');

describe('node:sqlite main-process packaging', () => {
  it('keeps the Electron builtin external when Vite runs on Node 22', () => {
    const viteConfig = readFileSync(resolve(DESKTOP_ROOT, 'vite.main.config.ts'), 'utf8');

    expect(viteConfig).toContain("'sqlite'");
    expect(viteConfig).toContain("'node:sqlite'");
    expect(viteConfig).toContain('__vite-browser-external');
  });

  it('uses the Electron runtime builtin from the browser profile snapshot', () => {
    const snapshotSource = readFileSync(
      resolve(
        DESKTOP_ROOT,
        'src/main/mcp-integrations/browser-real-profile/snapshot.ts',
      ),
      'utf8',
    );

    expect(snapshotSource).toContain(
      "import { backup, DatabaseSync } from 'node:sqlite'",
    );
  });
});
