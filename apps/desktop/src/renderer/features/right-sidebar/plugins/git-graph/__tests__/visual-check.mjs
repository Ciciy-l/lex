import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = process.cwd();
const executablePath =
  process.env.GIT_GRAPH_BROWSER_PATH ??
  [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
  ].find(existsSync);
assert(executablePath, 'Set GIT_GRAPH_BROWSER_PATH to a Chromium browser executable');
const prefix = '/src/renderer/features/right-sidebar/plugins/git-graph/__tests__/';
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src/renderer') } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'git-graph-isolated-preview',
      resolveId(source, importer) {
        if (
          source.endsWith('/store') &&
          importer?.replaceAll('\\', '/').includes('/right-sidebar/')
        )
          return '\0preview-store';
        if (source.endsWith('/gitReviewTransport')) return '\0preview-transport';
      },
      load(id) {
        if (id === '\0preview-store')
          return 'export const getBucket = () => ({tabs: []}); export const addOrFocusSingletonTab = async () => ({id: "preview"}); export const patchTabState = async () => {};';
        if (id === '\0preview-transport')
          return 'export const gitReviewApiFor = () => window.electronAPI.gitReview;';
      },
      configureServer(instance) {
        instance.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/graph-preview?')) return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<html><head><meta charset="UTF-8" /></head><body><div id="root"></div><script type="module" src="' +
              prefix +
              'visualFixture.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const theme of ['light', 'dark'])
    for (const width of [520, 560, 1120]) {
      await page.setViewportSize({ width, height: 760 });
      await page.goto(server.resolvedUrls.local[0] + 'graph-preview?theme=' + theme);
      await page.locator('[data-commit-row]').first().waitFor();
      const facts = await page
        .locator('[data-commit-row]')
        .first()
        .evaluate((row) => {
          const svg = row.querySelector('svg');
          const times = [...row.querySelectorAll('time')].filter(
            (time) => time.getClientRects().length > 0,
          );
          const content = row.querySelector('span');
          const inlineMetadata = row.querySelector('.lex-git-graph-inline-meta');
          const inlineAuthor = inlineMetadata?.querySelector('.lex-git-graph-inline-author');
          const inlineTime = inlineMetadata?.querySelector('time');
          const inlineHash = inlineMetadata?.querySelector('code');
          const rect = (node) => {
            const box = node?.getBoundingClientRect();
            return box && node.getClientRects().length > 0
              ? { top: box.top, height: box.height, width: box.width }
              : null;
          };
          return {
            rowWidth: row.getBoundingClientRect().width,
            rowHeight: row.getBoundingClientRect().height,
            graphWidth: svg.getBoundingClientRect().width,
            subjectWidth: content.getBoundingClientRect().width,
            visibleTimes: times.length,
            overflow: row.scrollWidth > row.clientWidth,
            inlineMetadata: {
              author: rect(inlineAuthor),
              time: rect(inlineTime),
              hash: rect(inlineHash),
            },
            strokes: [
              ...new Set(
                [...svg.querySelectorAll('path')].map(
                  (edge) => row.ownerDocument.defaultView.getComputedStyle(edge).stroke,
                ),
              ),
            ],
          };
        });
      assert(facts.graphWidth <= 76, JSON.stringify(facts));
      assert(facts.subjectWidth >= 180, JSON.stringify(facts));
      assert(facts.visibleTimes === 1, JSON.stringify(facts));
      assert(!facts.overflow, JSON.stringify(facts));
      assert(facts.strokes.length > 1, JSON.stringify(facts));
      if (facts.rowWidth < 640) {
        assert.equal(facts.rowHeight, 36, JSON.stringify(facts));
        assert(facts.inlineMetadata.author, JSON.stringify(facts));
        assert(facts.inlineMetadata.time, JSON.stringify(facts));
        assert(facts.inlineMetadata.hash, JSON.stringify(facts));
        assert(facts.inlineMetadata.author.width > 0, JSON.stringify(facts));
        assert.equal(
          facts.inlineMetadata.author.top,
          facts.inlineMetadata.time.top,
          JSON.stringify(facts),
        );
        assert.equal(
          facts.inlineMetadata.time.top,
          facts.inlineMetadata.hash.top,
          JSON.stringify(facts),
        );
      }
      assert.equal(await page.locator('summary button').count(), 0);
      assert.equal(
        await page
          .locator('details')
          .filter({ has: page.getByText('精确比较快照', { exact: false }) })
          .evaluateAll((nodes) => nodes.some((node) => node.open)),
        false,
      );
      console.log(JSON.stringify({ theme, width, ...facts }));
      if (process.env.GIT_GRAPH_SCREENSHOT_DIR)
        await page.screenshot({
          path: path.join(
            process.env.GIT_GRAPH_SCREENSHOT_DIR,
            'graph-' + theme + '-' + width + '.png',
          ),
        });
      const firstRow = page.locator('[data-commit-row]').first();
      await firstRow.focus();
      await firstRow.press('ArrowDown');
      assert.equal(
        await page
          .locator('[data-commit-row]')
          .nth(1)
          .evaluate((row) => row === row.ownerDocument.activeElement),
        true,
      );
      await page.getByRole('button', { name: '设为基准', exact: true }).click();
      assert.equal(await page.getByLabel('基准引用', { exact: true }).isVisible(), true);
      await page.getByRole('button', { name: '设为目标', exact: true }).click();
      await page.locator('details').getByRole('button', { name: '比较快照', exact: true }).click();
      await page.locator('.lex-git-graph details').getByText('没有变更', { exact: true }).waitFor();
    }
  await page.setViewportSize({ width: 560, height: 760 });
  await page.goto(server.resolvedUrls.local[0] + 'graph-preview?theme=dark&history=merges');
  await page.locator('[data-commit-row]').first().waitFor();
  assert.equal(await page.locator('[data-commit-row] svg').first().getAttribute('width'), '28');
  assert.equal(await page.locator('[data-commit-row]').count(), 29);
  assert.equal(await page.getByRole('button', { name: '再加载 100 条', exact: true }).count(), 0);
  const titles = await page.locator('[data-commit-row] .font-medium').allTextContents();
  assert.deepEqual(titles.slice(0, 4), ['合并提交 0', 'HEAD', '功能改动 0', '合并提交 1']);
  console.log(
    'Grouped merge fixture: 29 commits preserved, two lanes, adjacent merge/change rows, no load-more button',
  );
  await page.goto(server.resolvedUrls.local[0] + 'graph-preview?theme=dark&history=real');
  await page.getByText('286148cb Merge branch dev/v1', { exact: true }).waitFor();
  await page.getByText('286148cb Merge branch dev/v1', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('[data-commit-row]').count(), 293);
  assert.equal(await page.locator('[data-commit-row] svg').first().getAttribute('width'), '40');
  console.log(
    'Real repository topology: 293 original-order nodes preserved, max 3 lanes, screenshot commit 286148cb verified',
  );
  if (process.env.GIT_GRAPH_SCREENSHOT_DIR)
    await page.screenshot({
      path: path.join(process.env.GIT_GRAPH_SCREENSHOT_DIR, 'graph-grouped-merges.png'),
    });
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
