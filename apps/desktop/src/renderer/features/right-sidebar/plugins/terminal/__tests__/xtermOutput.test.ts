// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalDataEvent } from '../../../../../../shared/terminal-bridge';
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    write = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
import { __resetPoolForTesting, disposeXterm, getOrCreateXterm } from '../lib/xtermPool';
afterEach(__resetPoolForTesting);

describe('retained terminal output', () => {
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
