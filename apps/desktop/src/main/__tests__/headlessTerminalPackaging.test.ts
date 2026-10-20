import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfigFromFile, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(__dirname, '../../..');
const nodeRequire = createRequire(resolve(desktopRoot, 'package.json'));

describe('headless terminal main-process packaging', () => {
  it.each(['development', 'production'])('bundles the real Node entry in %s', async (mode) => {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode },
      resolve(desktopRoot, 'vite.main.config.ts'),
    );
    expect(loaded).not.toBeNull();
    const config = await resolveConfig({
      ...loaded!.config,
      configFile: false,
      root: desktopRoot,
      resolve: {
        ...loaded!.config.resolve,
        // Match Forge's module-first Main resolver, which must not select the
        // headless package's nonexistent module entry.
        conditions: ['node'],
        mainFields: ['module', 'jsnext:main', 'jsnext'],
      },
    }, 'build', mode);
    const resolved = await config.createResolver()(
      '@xterm/headless',
      resolve(desktopRoot, 'src/main/terminal/agentTerminalDriver.ts'),
    );
    expect(resolved).toBeTruthy();
    expect(realpathSync(resolved!)).toBe(realpathSync(nodeRequire.resolve('@xterm/headless')));
    // Ship the parser and serializer in the Main bundle; they are not additional
    // external runtime packages that release packaging would need to copy.
    expect(config.build.rollupOptions.external).not.toContain('@xterm/headless');
    expect(config.build.rollupOptions.external).not.toContain('@xterm/addon-serialize');
  });
});
