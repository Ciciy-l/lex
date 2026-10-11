import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  HARNESS_KINDS,
  OMP_HARNESS_DEFAULTS,
  type HarnessKind,
  type HarnessSource,
  type OmpHarnessSettings,
} from '../shared/harnessSettings.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from './security/trustedAppRenderer.js';
import {
  harnessState,
  checkHarness,
  installHarness,
  cancelHarness,
  onHarnessProgress,
} from './agent-binaries/harness-manager.js';
import {
  ompHarnessState,
  parseOmpHarnessPatch,
  writeOmpHarnessSettings,
  clearOmpNativeMemory,
} from './maker-host/omp-harness-settings.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isIpcError } from '../shared/ipc-errors.js';
import { getActiveAppSession } from './appSessionState.js';

function assertOwnerGeneration(value: unknown): void {
  const current = getActiveAppSession();
  if (!current.dataOwnerId || typeof value !== 'number' || value !== current.generation)
    throwIpcError('PRECONDITION_FAILED', 'ACCOUNT_CHANGED');
}

function handle(
  channel: string,
  operation: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedAppRendererEvent(event);
    try {
      return await operation(event, ...args);
    } catch (error) {
      if (isIpcError(error)) throw error;
      const detail =
        error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
          ? error.message
          : 'HARNESS_OPERATION_FAILED';
      throwIpcError(
        detail.startsWith('INVALID_')
          ? 'INVALID_PARAMS'
          : detail === 'OMP_MEMORY_BUSY'
            ? 'SESSION_RUNNING'
            : 'PRECONDITION_FAILED',
        detail,
      );
    }
  });
}

function kind(value: unknown): HarnessKind {
  if (!HARNESS_KINDS.includes(value as HarnessKind))
    throwIpcError('INVALID_PARAMS', 'INVALID_HARNESS');
  return value as HarnessKind;
}
export function registerHarnessSettingsIpc(): void {
  handle('harness:state', (_event, raw: unknown) => {
    return harnessState(kind(raw));
  });
  handle('harness:check', (_event, raw: unknown, force: unknown) => {
    if (force !== undefined && typeof force !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'INVALID_PARAMS');
    return checkHarness(kind(raw), force === true);
  });
  handle('harness:install', (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throwIpcError('INVALID_PARAMS', 'INVALID_PARAMS');
    const input = raw as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !['kind', 'source', 'version'].includes(key)) ||
      !['upstream', 'baseline'].includes(input.source as string) ||
      typeof input.version !== 'string' ||
      !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(input.version)
    )
      throwIpcError('INVALID_PARAMS', 'INVALID_PARAMS');
    return installHarness({
      kind: kind(input.kind),
      source: input.source as HarnessSource,
      version: input.version,
    });
  });
  handle('harness:cancel', (_event, raw: unknown) => {
    cancelHarness(kind(raw));
  });
  handle('harness:omp:get', (_event) => {
    return ompHarnessState();
  });
  handle('harness:omp:set', (_event, raw: unknown, generation: unknown) => {
    assertOwnerGeneration(generation);
    return writeOmpHarnessSettings(parseOmpHarnessPatch(raw));
  });
  handle('harness:omp:reset', (_event, raw: unknown, generation: unknown) => {
    assertOwnerGeneration(generation);
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.some((key) => typeof key !== 'string' || !Object.hasOwn(OMP_HARNESS_DEFAULTS, key))
    )
      throwIpcError('INVALID_PARAMS', 'INVALID_PARAMS');
    return writeOmpHarnessSettings(
      Object.fromEntries(
        raw.map((key) => [key, OMP_HARNESS_DEFAULTS[key as keyof OmpHarnessSettings]]),
      ),
    );
  });
  handle('harness:omp:clear-memory', (_event, generation: unknown) => {
    assertOwnerGeneration(generation);
    return clearOmpNativeMemory();
  });
  onHarnessProgress((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (!window.isDestroyed() && isTrustedAppRendererWindow(window))
          window.webContents.send('harness:progress', state);
      } catch {
        /* A closing window must not interrupt installation or other windows. */
      }
    }
  });
}
