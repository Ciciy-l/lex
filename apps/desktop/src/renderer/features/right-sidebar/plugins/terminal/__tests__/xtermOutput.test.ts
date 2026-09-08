// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalDataEvent } from '../../../../../../shared/terminal-bridge';
import { themeService } from '@/themes/theme-service';
const inputListeners = vi.hoisted(() => new Set<(data: string) => void>());
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(public options: { theme?: unknown }) {}
    rows = 24;
    refresh = vi.fn();
    onData = vi.fn((listener: (data: string) => void) => {
      inputListeners.add(listener);
      return { dispose: () => inputListeners.delete(listener) };
    });
    write = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
import { __resetPoolForTesting, disposeXterm, getOrCreateXterm } from '../lib/xtermPool';
afterEach(() => {
  __resetPoolForTesting();
  document.documentElement.style.removeProperty('--panel-bg');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('retained terminal output', () => {
  it('coalesces Windows PTY output in the retained pool and cancels pending output on disposal', () => {
    vi.useFakeTimers();
    let deliver: ((event: TerminalDataEvent) => void) | undefined;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { platform: 'win32', terminal: { onData: (listener: typeof deliver) => {
        deliver = listener;
        return vi.fn();
      } } },
    });
    const entry = getOrCreateXterm('windows');
    const escape = String.fromCharCode(27);
    const frame = escape + '[?2026h' + escape + '[34;1H' + escape + '[?2026l';
    const restore = escape + '[37;3H';
    deliver?.({ id: 'windows', chunk: frame });
    vi.advanceTimersByTime(18);
    expect(entry.terminal.write).not.toHaveBeenCalled();
    deliver?.({ id: 'windows', chunk: restore });
    vi.advanceTimersByTime(14);
    expect(entry.terminal.write).toHaveBeenCalledExactlyOnceWith(frame + restore);
    deliver?.({ id: 'windows', chunk: frame });
    disposeXterm('windows');
    vi.runAllTimers();
    expect(entry.terminal.write).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the current theme at creation and retains input replies and theme updates until disposal', () => {
    const write = vi.fn(async () => undefined);
    const offTheme = vi.fn();
    let changeTheme: (() => void) | undefined;
    vi.spyOn(themeService, 'onDidChangeTheme').mockImplementation(listener => {
      changeTheme = () => listener({ id: 'test', type: 'light', colors: {} } as never);
      return offTheme;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true, value: { terminal: { write } },
    });
    document.documentElement.style.setProperty('--panel-bg', '#fafafa');
    const entry = getOrCreateXterm('hidden');
    expect(entry.terminal.options.theme?.background).toBe('#fafafa');
    expect(getOrCreateXterm('hidden')).toBe(entry);
    for (const listener of inputListeners) listener('color-query-reply');
    expect(write).toHaveBeenCalledExactlyOnceWith('hidden', 'color-query-reply');
    document.documentElement.style.setProperty('--panel-bg', '#202020');
    changeTheme?.();
    expect(entry.terminal.options.theme?.background).toBe('#202020');
    disposeXterm('hidden');
    expect(inputListeners.size).toBe(0);
    expect(offTheme).toHaveBeenCalledOnce();
  });
  it('subscribes once per PTY and keeps receiving output without a mounted view until Forget', () => {
    const subscribers = new Set<(event: TerminalDataEvent) => void>();
    const off = vi.fn();
    const onData = vi.fn((callback: (event: TerminalDataEvent) => void) => {
      subscribers.add(callback);
      return () => {
        off();
        subscribers.delete(callback);
      };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { terminal: { onData } },
    });
    const first = getOrCreateXterm('pty-a');
    expect(getOrCreateXterm('pty-a')).toBe(first);
    const second = getOrCreateXterm('pty-b');
    expect(onData).toHaveBeenCalledTimes(2);
    for (const emit of subscribers) emit({ id: 'pty-a', chunk: 'background output' });
    expect(first.terminal.write).toHaveBeenCalledWith('background output');
    expect(second.terminal.write).not.toHaveBeenCalled();
    disposeXterm('pty-a');
    expect(off).toHaveBeenCalledOnce();
    expect(first.terminal.dispose).toHaveBeenCalledOnce();
    for (const emit of subscribers) emit({ id: 'pty-b', chunk: 'sibling still running' });
    expect(second.terminal.write).toHaveBeenCalledWith('sibling still running');
  });
});
