import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';
import { test } from 'vitest';

const desktop = fileURLToPath(new URL('../', import.meta.url));

test.each([false, true])(
  'fresh dev module identity and CJS viability (remove all includes: %s)',
  async (removeIncludes) => {
    await mkdir(path.join(desktop, '.vite'), { recursive: true });
    const temporary = await mkdtemp(path.join(desktop, '.vite/tiptap-resolution-'));
    let server;
    try {
      // Read the real config without invoking its live dev-cache invalidation hook.
      // Build mode returns the same resolve/optimizeDeps settings, plus an unrelated
      // production fixture alias. No production plugin or live app cache is run here.
      const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'development' },
        path.join(desktop, 'vite.renderer.config.ts'),
      );
      assert(loaded);
      const entry = path.join(temporary, 'entry.js');
      await writeFile(
        entry,
        'import { Editor } from "@tiptap/react"; import { DecorationSet } from "@tiptap/pm/view"; export { Editor, DecorationSet };',
      );
      server = await createServer({
        configFile: false,
        root: desktop,
        cacheDir: path.join(temporary, 'cache'),
        resolve: loaded.config.resolve,
        optimizeDeps: {
          ...loaded.config.optimizeDeps,
          ...(removeIncludes ? { include: [] } : {}),
          entries: [entry],
          force: true,
        },
        server: {
          host: '127.0.0.1',
          port: 0,
          fs: { allow: [desktop, path.resolve(desktop, '../..'), temporary] },
        },
        logLevel: 'error',
      });
      await server.listen();
      const importer = path.join(desktop, 'src/renderer/tiptap-resolution-probe.ts');
      const resolve = async (specifier, from = importer) => {
        const result = await server.pluginContainer.resolveId(specifier, from);
        assert(result, specifier);
        return result.id;
      };
      const adapter = await resolve('@tiptap/react');
      assert(
        !adapter.includes('/deps/'),
        'adapter must not have a private optimized ProseMirror copy',
      );
      const core = await resolve('@tiptap/core', adapter);
      const directView = await resolve('@tiptap/pm/view');
      const adapterView = await resolve('@tiptap/pm/view', core);
      assert.equal(adapterView, directView);
      for (const name of ['model', 'state', 'view', 'transform']) {
        const direct = await resolve('prosemirror-' + name);
        assert.equal(await resolve('prosemirror-' + name, adapterView), direct);
        assert.equal(
          await resolve('@tiptap/pm/' + name, core),
          await resolve('@tiptap/pm/' + name),
        );
      }
      const url = (id) => '/@fs/' + id.replaceAll('\\', '/');
      const served = async (requestUrl) => {
        const response = await globalThis.fetch(new URL(requestUrl, server.resolvedUrls.local[0]));
        assert.equal(response.status, 200, requestUrl);
        return response.text();
      };
      const imports = (code) =>
        [...code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
      const adapterById = await served('/@id/@tiptap/react');
      const facadeById = await served('/@id/@tiptap/pm/view');
      assert(!adapterById.includes('localsInner'));
      const servedCoreUrl = imports(adapterById).find((id) => id.includes('/@tiptap/core/'));
      assert(servedCoreUrl, 'adapter must serve the raw core import');
      const servedCore = await served(servedCoreUrl);
      const servedFacadeUrl = imports(servedCore).find((id) =>
        id.includes('/@tiptap/pm/dist/view/'),
      );
      assert(servedFacadeUrl);
      const coreFacade = await served(servedFacadeUrl);
      const rawFromDirect = imports(facadeById).find((id) => id.includes('/prosemirror-view/'));
      const rawFromCore = imports(coreFacade).find((id) => id.includes('/prosemirror-view/'));
      assert(rawFromDirect?.startsWith('/@fs/'));
      assert.equal(
        rawFromCore,
        rawFromDirect,
        'HTTP-served imports must share the exact raw PM view URL, including its query',
      );
      for (const specifier of [
        '@tiptap/extensions',
        '@tiptap/react/menus',
        '@tiptap/extension-bubble-menu',
        '@tiptap/extension-floating-menu',
      ]) {
        const id = await resolve(specifier);
        assert(!id.includes('/deps/'), specifier + ' must not embed a PM copy');
        const code = await served('/@id/' + specifier);
        assert(!code.includes('localsInner'), specifier + ' must not inline PM view');
        assert(
          imports(code).some((imported) => imported.includes('/@tiptap/')),
          specifier + ' must preserve raw Tiptap/PM edges',
        );
        assert.equal(await resolve('@tiptap/pm/view', id), directView);
      }
      const transformedAdapter = await server.transformRequest(url(adapter));
      const transformedCore = await server.transformRequest(url(core));
      const transformedView = await server.transformRequest(url(directView));
      assert(transformedAdapter && transformedCore && transformedView);
      assert.match(transformedAdapter.code, /@tiptap\/core/);
      assert.match(transformedView.code, /prosemirror-view/);
      const coreImports = [...transformedCore.code.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      assert(
        coreImports.some((id) => id.split('?')[0] === url(directView).split('?')[0]),
        'core must import the same unbundled pm/view facade: ' + directView,
      );
      const adapterImports = [...transformedAdapter.code.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      assert(adapterImports.some((id) => id.split('?')[0] === url(core).split('?')[0]));
      const rawView = await resolve('prosemirror-view');
      const viewImports = [...transformedView.code.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      assert(viewImports.some((id) => id.split('?')[0] === url(rawView).split('?')[0]));
      assert(
        !transformedAdapter.code.includes('localsInner'),
        'adapter must not inline ProseMirror',
      );
      // Control case proves why removing all includes is not browser-safe here.
      await server.waitForRequestsIdle();
      for (const hook of [
        'use-sync-external-store/shim/index.js',
        'use-sync-external-store/shim/with-selector.js',
      ]) {
        const hookName = hook.endsWith('with-selector.js') ? 'with-selector' : 'index';
        const hookUrl = imports(adapterById).find(
          (id) => id.includes('use-sync-external-store') && id.includes(hookName),
        );
        assert(hookUrl, hook);
        const hookCode = await served(hookUrl);
        if (removeIncludes) {
          assert(
            hookUrl.startsWith('/@fs/'),
            'no-include control must expose the raw CJS dependency',
          );
          assert.match(hookCode, /module\.exports\s*=/);
          assert(
            !/export\s*\{/.test(hookCode),
            'raw hook cannot satisfy browser named ESM imports',
          );
        } else {
          assert(hookUrl.includes('/deps/'), hook + ' needs an optimized ESM wrapper');
          assert.match(hookCode, /export\s+(?:default|\{)/);
          assert.match(adapterById, /__vite__cjsImport/);
        }
      }
    } finally {
      await server?.close();
      await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
  60_000,
);
