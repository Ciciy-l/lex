// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateXterm, __resetPoolForTesting, updateXtermTheme } from '../lib/xtermPool';

afterEach(() => {
  __resetPoolForTesting();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty('--panel-bg');
  document.documentElement.style.removeProperty('--text-primary');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real xterm color queries', () => {
  it('supports synchronized redraws across separate PTY writes', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const write = vi.fn(async () => undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true, value: { terminal: { write } },
    });
    const entry = getOrCreateXterm('sync-query');
    const container = document.createElement('div');
    document.body.appendChild(container);
    entry.terminal.open(container);
    const output = (chunk: string) => new Promise<void>(resolve => entry.terminal.write(chunk, resolve));
    await output('[?2026$p');
    expect(write).toHaveBeenLastCalledWith('sync-query', '[?2026;2$y');
    await output('[?202');
    await output('6h[?25l[2;1Hreply');
    await output('[?2026$p');
    expect(write).toHaveBeenLastCalledWith('sync-query', '[?2026;1$y');
    await output('[4;3H[?25h[?2026l');
    await output('[?2026$p[?25$p');
    expect(write).toHaveBeenCalledWith('sync-query', '[?25;1$y');
    expect(write).toHaveBeenNthCalledWith(3, 'sync-query', '[?2026;2$y');
    expect(entry.terminal.buffer.active.cursorX).toBe(2);
    expect(entry.terminal.buffer.active.cursorY).toBe(3);
  });

  it('replies with the current light and dark colors through the retained PTY bridge', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const write = vi.fn(async () => undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true, value: { terminal: { write } },
    });
    document.documentElement.style.setProperty('--panel-bg', '#fafafa');
    document.documentElement.style.setProperty('--text-primary', '#202020');
    const entry = getOrCreateXterm('color-query');
    const container = document.createElement('div');
    document.body.appendChild(container);
    entry.terminal.open(container);
    await new Promise<void>(resolve => entry.terminal.write('\x1b]11;?\x07', resolve));
    expect(write).toHaveBeenCalledWith('color-query', '\x1b]11;rgb:fafa/fafa/fafa\x1b\\');
    write.mockClear();
    container.remove();
    document.documentElement.style.setProperty('--panel-bg', '#202020');
    updateXtermTheme(entry);
    await new Promise<void>(resolve => entry.terminal.write('\x1b]11;?\x1b\\', resolve));
    expect(write).toHaveBeenCalledExactlyOnceWith('color-query', '\x1b]11;rgb:2020/2020/2020\x1b\\');
  });
});
