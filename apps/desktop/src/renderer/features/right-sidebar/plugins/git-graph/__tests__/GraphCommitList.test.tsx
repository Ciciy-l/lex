// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitGraphData } from '../../../../../../shared/gitGraph';
import { GraphCommitList } from '../GraphCommitList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);
const commits = Array.from({ length: 13 }, (_, index) => ({
  oid: String(index),
  parents: index === 0 ? Array.from({ length: 12 }, (_, parent) => String(parent + 1)) : [],
  author: 'Author',
  authorTime: 1788940800 - index * 3600,
  title: 'Commit ' + index,
}));
const data = {
  commits,
  refs: [{ name: 'refs/heads/main', oid: '0', kind: 'local' }],
  scope: { headOid: '0' },
  hasMore: false,
} as GitGraphData;

it('bounds the ancestry column and keeps narrow author, date, and short OID metadata on one line', () => {
  const view = render(
    <GraphCommitList data={data} selected={null} query="" includeRemotes onSelect={() => {}} />,
  );
  expect(view.container.querySelectorAll('[data-commit-row]')).toHaveLength(13);
  expect(view.container.querySelector('[data-commit-row] svg')?.getAttribute('width')).toBe('76');
  expect(screen.getByText('Commit 0').getAttribute('title')).toBe('Commit 0');
  expect(screen.getByText('main').getAttribute('title')).toBe('refs/heads/main');
  expect(view.container.querySelector('time')?.dateTime).toBe(
    new Date(commits[0].authorTime * 1000).toISOString(),
  );
  expect(view.container.querySelector('time')?.getAttribute('title')).toBeTruthy();
  const inlineMetadata = view.container.querySelector('.lex-git-graph-inline-meta')!;
  expect(inlineMetadata.querySelector('.lex-git-graph-inline-author')?.textContent).toBe('Author');
  expect(inlineMetadata.querySelector('time')?.textContent).toBeTruthy();
  expect(inlineMetadata.querySelector('code')?.textContent).toBe('0');
  expect(
    new Set([...view.container.querySelectorAll('path')].map((path) => path.getAttribute('stroke')))
      .size,
  ).toBeGreaterThan(1);
});

it('pans only the graph column and keeps commit order and dates unchanged', () => {
  const view = render(
    <GraphCommitList data={data} selected={null} query="" includeRemotes onSelect={() => {}} />,
  );
  const before = view.container.querySelector('[data-commit-row]')?.textContent;
  fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.gitGraph.lanesRight' }));
  expect(view.container.querySelector('[data-commit-row] svg')?.getAttribute('viewBox')).toBe(
    '36 0 76 52',
  );
  expect(view.container.querySelector('[data-commit-row]')?.textContent).toBe(before);
  fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.gitGraph.lanesLeft' }));
  expect(view.container.querySelector('[data-commit-row] svg')?.getAttribute('viewBox')).toBe(
    '0 0 76 52',
  );
});

it('supports keyboard commit navigation without relying on lane color', () => {
  const select = vi.fn();
  const view = render(
    <GraphCommitList data={data} selected={null} query="" includeRemotes onSelect={select} />,
  );
  const rows = view.container.querySelectorAll<HTMLButtonElement>('[data-commit-row]');
  rows[0].focus();
  fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
  expect(select).toHaveBeenLastCalledWith('1');
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1], { key: 'End' });
  expect(document.activeElement).toBe(rows[12]);
});

it('marks unloaded parent edges as short dashed spurs rather than full-height phantom lanes', () => {
  const partial = { ...data, commits: [{ ...commits[0], parents: ['not-loaded'] }] };
  const view = render(
    <GraphCommitList data={partial} selected={null} query="" includeRemotes onSelect={() => {}} />,
  );
  const svg = view.container.querySelector('[data-commit-row] svg')!;
  expect(svg.getAttribute('width')).toBe('16');
  expect(svg.querySelector('path')?.getAttribute('d')).toBe('M 8 26 l 5 12');
  expect(svg.querySelector('path')?.getAttribute('stroke-dasharray')).toBe('2 2');
  expect(svg.querySelector('title')?.textContent).toBe('rightSidebar.gitGraph.unloadedParents');
});
