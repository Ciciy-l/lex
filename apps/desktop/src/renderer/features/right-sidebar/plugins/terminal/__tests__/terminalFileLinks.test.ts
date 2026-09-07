import { describe, expect, it } from 'vitest';
import { terminalFileLinks } from '../lib/terminalFileLinks';
import { adjacentTerminalPane, createInitialTerminalState, createPaneState, splitTerminalPane } from '../terminal-layout';

describe('terminal file links', () => {
  it('recognizes file locations and quoted paths with spaces while excluding URLs', () => {
    const links = terminalFileLinks('src/main.ts:12:4 "C:\\My Project\\test.ts":3:2 https://example.com/a.ts:4');
    expect(links.map(({ path, line, column }) => ({ path, line, column }))).toEqual([
      { path: 'src/main.ts', line: 12, column: 4 },
      { path: 'C:\\My Project\\test.ts', line: 3, column: 2 },
    ]);
  });
  it('bounds tokenization on padded or hostile output', () => {
    expect(terminalFileLinks(' '.repeat(20000) + 'a.ts:1')).toEqual([]);
    expect(terminalFileLinks('a.ts '.repeat(2000))).toHaveLength(32);
  });
  it('cycles panes in layout order without modifying the split tree', () => {
    const initial = createInitialTerminalState();
    const state = splitTerminalPane(initial, initial.activePaneId, 'horizontal', createPaneState('second'))!;
    const before = JSON.stringify(state);
    expect(adjacentTerminalPane(state, 1)).toBe('pane-1');
    expect(adjacentTerminalPane(state, -1)).toBe('pane-1');
    expect(JSON.stringify(state)).toBe(before);
  });
});
