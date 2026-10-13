import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1400, height: 900 } }) },
}));
vi.mock('../../utils/atomicWriteFile.js', () => ({
  readAtomicFileSync: disk.read,
  atomicWriteFileSync: disk.write,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { installSidebarContentSizing, setSidebarContentLayout } from '../contentSizing';

function windowFixture(width = 720) {
  const emitter = new EventEmitter();
  const state = { bounds: { x: 600, y: 10, width, height: 800 }, maximized: false };
  const win = Object.assign(emitter, {
    getBounds: () => ({ ...state.bounds }),
    setBounds: (bounds: typeof state.bounds) => {
      state.bounds = bounds;
      emitter.emit('resized');
    },
    isDestroyed: () => false,
    isMaximized: () => state.maximized,
    isFullScreen: () => false,
    isMinimized: () => false,
  }) as unknown as BrowserWindow;
  installSidebarContentSizing(win);
  return { win, state };
}
beforeEach(() => {
  disk.read.mockReset().mockReturnValue(null);
  disk.write.mockReset();
});
it('narrows navigation without overwriting the expanded width, then restores it', () => {
  const { win, state } = windowFixture();
  setSidebarContentLayout(win, true);
  expect(state.bounds).toMatchObject({ x: 960, width: 360, height: 800 });
  win.emit('close', {});
  expect(disk.write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(disk.write.mock.calls[0][1]).expandedWidth).toBe(720);
  setSidebarContentLayout(win, false);
  expect(state.bounds).toMatchObject({ x: 600, width: 720 });
  state.bounds.width = 780;
  win.emit('resized');
  expect(JSON.parse(disk.write.mock.calls.at(-1)![1]).expandedWidth).toBe(780);
});
it('restores expanded width after restarting while the window-state file was compact', () => {
  disk.read.mockReturnValue(JSON.stringify({ expandedWidth: 820 }));
  const { win, state } = windowFixture(360);
  setSidebarContentLayout(win, true);
  setSidebarContentLayout(win, false);
  expect(state.bounds.width).toBe(820);
});
it('defers geometry changes while maximized and applies the requested layout on restore', () => {
  const { win, state } = windowFixture();
  state.maximized = true;
  setSidebarContentLayout(win, true);
  expect(state.bounds.width).toBe(720);
  state.maximized = false;
  win.emit('unmaximize');
  expect(state.bounds.width).toBe(360);
});
