// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

import { getTerminalTheme, updateXtermTheme, type XtermEntry } from '../lib/xtermPool';

afterEach(() => {
  for (const token of ['--panel-bg', '--text-primary', '--surface-chip']) {
    document.documentElement.style.removeProperty(token);
  }
});

describe('xterm theme integration', () => {
  it('maps semantic host tokens to the xterm theme', () => {
    document.documentElement.style.setProperty('--panel-bg', '#101010');
    document.documentElement.style.setProperty('--text-primary', '#eeeeee');
    document.documentElement.style.setProperty('--surface-chip', '#303030');

    expect(getTerminalTheme()).toMatchObject({
      background: '#101010',
      foreground: '#eeeeee',
      cursor: '#eeeeee',
      cursorAccent: '#101010',
      selectionBackground: '#303030',
    });
  });

  it('refreshes an existing terminal in place when the theme changes', () => {
    document.documentElement.style.setProperty('--panel-bg', '#fafafa');
    document.documentElement.style.setProperty('--text-primary', '#202020');
    document.documentElement.style.setProperty('--surface-chip', '#e5e5e5');
    const terminal = {
      options: { theme: {} },
      rows: 24,
      refresh: vi.fn(),
    };
    const entry = { terminal } as unknown as XtermEntry;

    updateXtermTheme(entry);

    expect(terminal.options.theme).toMatchObject({
      background: '#fafafa',
      foreground: '#202020',
      selectionBackground: '#e5e5e5',
    });
    expect(terminal.refresh).not.toHaveBeenCalled();
    const applied = terminal.options.theme;
    updateXtermTheme(entry);
    expect(terminal.options.theme).toBe(applied);
    expect(terminal.refresh).not.toHaveBeenCalled();
  });
});
