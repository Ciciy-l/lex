import { app, screen, type BrowserWindow } from 'electron';
import path from 'node:path';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { createLogger } from '../logger.js';

const log = createLogger('right-sidebar-content-sizing');
const states = new WeakMap<
  BrowserWindow,
  {
    expandedWidth: number;
    compact: boolean;
    requested: boolean;
    resizing: boolean;
    initialized: boolean;
  }
>();
const settingsPath = () =>
  path.join(app.getPath('userData'), 'right-sidebar-window-content-width.json');

export function installSidebarContentSizing(win: BrowserWindow): void {
  let expandedWidth = win.getBounds().width;
  try {
    const raw = JSON.parse(readAtomicFileSync(settingsPath()) ?? '{}');
    if (
      Number.isFinite(raw.expandedWidth) &&
      raw.expandedWidth >= 360 &&
      raw.expandedWidth <= 10000
    )
      expandedWidth = raw.expandedWidth;
  } catch {
    /* first launch retains the existing window-state width */
  }
  const state = {
    expandedWidth,
    compact: false,
    requested: false,
    resizing: false,
    initialized: false,
  };
  states.set(win, state);
  const persist = () => {
    if (
      !state.initialized ||
      state.resizing ||
      state.compact ||
      win.isDestroyed() ||
      win.isMaximized() ||
      win.isFullScreen() ||
      win.isMinimized()
    )
      return;
    state.expandedWidth = win.getBounds().width;
    try {
      atomicWriteFileSync(settingsPath(), JSON.stringify({ expandedWidth: state.expandedWidth }));
    } catch (error) {
      log.warn('failed to save expanded sidebar width', { error });
    }
  };
  win.on('resized', persist);
  win.on('close', persist);
  for (const event of ['unmaximize', 'leave-full-screen', 'restore'] as const)
    win.on(event, () => setSidebarContentLayout(win, state.requested));
}

export function setSidebarContentLayout(win: BrowserWindow, compact: boolean): void {
  const state = states.get(win);
  if (!state || win.isDestroyed()) return;
  state.requested = compact;
  if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
  const bounds = win.getBounds();
  if (state.initialized && state.compact === compact && (!compact || bounds.width === 360)) return;
  if (compact && !state.compact) {
    if (state.initialized) state.expandedWidth = bounds.width;
    try {
      atomicWriteFileSync(settingsPath(), JSON.stringify({ expandedWidth: state.expandedWidth }));
    } catch (error) {
      log.warn('failed to save expanded sidebar width', { error });
    }
  }
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(area.width, compact ? 360 : state.expandedWidth);
  state.initialized = true;
  state.compact = compact;
  state.resizing = true;
  try {
    win.setBounds({
      ...bounds,
      width,
      x: Math.max(area.x, Math.min(bounds.x + bounds.width - width, area.x + area.width - width)),
    });
  } finally {
    state.resizing = false;
  }
}
