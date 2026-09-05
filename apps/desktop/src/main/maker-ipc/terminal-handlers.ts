/**
 * RSB 终端 tab 的 IPC handler 集合。
 *
 * 设计：
 *   - 单一 `registerTerminalHandlers()` 入口，由 `register.ts` 在 maker IPC 注册末尾调一次。
 *   - 内部构造 PtyManager 单例（per main 进程），sink 走 `webContents.send`，把 PTY
 *     data / exit 推回创建它的 owner 窗口。
 *   - 所有失败统一走 `throwIpcError(code, message)`（rule 13），renderer 侧用
 *     `extractIpcError` 反解 code。
 *
 * channels：TERMINAL_INVOKE / TERMINAL_PUSH（见 channels.ts）。
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import {
  isTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import { isRsbWindowWebContentsId } from '../right-sidebar-window/registry.js';
import { TERMINAL_INVOKE, TERMINAL_PUSH } from './channels.js';
import {
  probeAvailableShells,
  type AvailableShell,
  type ShellId,
} from '../terminal/shellResolver.js';
import { isTerminalProfile, type TerminalProfile } from '../../shared/terminal-bridge.js';
import {
  PtyManager,
  type CreateOptions,
  type CreateResult,
  type DataPayload,
  type ExitPayload,
} from '../terminal/ptyManager.js';
import { getDefaultShellPref, setDefaultShellPref } from '../terminal/terminalPrefsStore.js';

const VALID_SHELL_PREFS: ReadonlySet<ShellId> = new Set<ShellId>([
  'auto',
  'zsh',
  'bash',
  'fish',
  'sh',
  'pwsh',
  'powershell',
  'cmd',
  'gitbash',
  'wsl',
]);

// Renderer input is untrusted even for Cindy-owned windows. Keep identifiers,
// paths, paste chunks, and PTY geometry bounded before they reach native code.
const MAX_TERMINAL_ID_LENGTH = 512;
const MAX_TERMINAL_CWD_LENGTH = 4_096;
const MAX_TERMINAL_WRITE_LENGTH = 1024 * 1024;
const MAX_TERMINAL_DIMENSION = 10_000;
const log = createLogger('terminal/ipc');

export interface TerminalHandlersOptions {
  /**
   * owner webContents destroyed 时的 PTY 接管者(典型:主窗 webContents)。
   * RSB 独立子窗口销毁时把它名下的 PTY 转移回主窗保活,而不是杀掉;
   * 解析不到活 webContents(app 退出)时 PtyManager 回落 dispose。
   */
  getFallbackOwner?: () => WebContents | null;
  /**
   * Sender guard is injectable for unit tests; production defaults to Cindy's
   * trusted top-level renderer check. Terminal IPC launches native processes,
   * so a WebView/Ghost must never be able to invoke it.
   */
  isTrustedSender?: (event: IpcMainInvokeEvent) => boolean;
  /** Outbound destination guard; injectable to make navigation races testable. */
  isTrustedOwner?: (target: WebContents) => boolean;
}

/**
 * 在 main 进程注册所有终端 IPC handler。
 * 必须只调一次（重复注册会被 ipcMain 抛错）。返回 PtyManager 实例供调用方在
 * shutdown 流程里手动 dispose（如果需要）。
 */
export function registerTerminalHandlers(options?: TerminalHandlersOptions): PtyManager {
  const isTrustedSender = options?.isTrustedSender ?? isTrustedAppRendererEvent;
  const isTrustedOwner = options?.isTrustedOwner ?? isTrustedTerminalOwner;
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedSender(event)) {
      throwIpcError('PERMISSION_DENIED', `terminal IPC is only available to ${BRAND_NAME} renderers`);
    }
  };
  const pushToTrustedOwner = (target: WebContents, channel: string, payload: unknown): void => {
    if (!isTrustedOwner(target)) return;
    try {
      target.send(channel, payload);
    } catch {
      // Navigation/destruction can race the authorization check and send.
      // Dropping one late PTY chunk is safer than leaking or crashing Main.
    }
  };
  const manager = new PtyManager({
    sink: {
      emitData: (target: WebContents, payload: DataPayload) => {
        // A renderer can navigate after the PTY is attached.  Checking only
        // `isDestroyed()` would keep sending private terminal output to an
        // untrusted page loaded in the same WebContents.  Re-check the
        // window's current Cindy URL + registration on every push (the same
        // outbound gate used by the process monitor and other sensitive
        // broadcasters).
        pushToTrustedOwner(target, TERMINAL_PUSH.DATA, payload);
      },
      emitExit: (target: WebContents, payload: ExitPayload) => {
        pushToTrustedOwner(target, TERMINAL_PUSH.EXIT, payload);
      },
    },
    resolveFallbackOwner: options?.getFallbackOwner
      ? () => options.getFallbackOwner?.() ?? null
      : undefined,
    canTransferOwner: (currentOwner, nextOwner) => {
      const fallback = options?.getFallbackOwner?.() ?? null;
      if (!fallback) return false;
      const currentIsRsb = isRsbWindowWebContentsId(currentOwner.id);
      const nextIsRsb = isRsbWindowWebContentsId(nextOwner.id);
      return (currentOwner === fallback && nextIsRsb) || (currentIsRsb && nextOwner === fallback);
    },
  });

  ipcMain.handle(TERMINAL_INVOKE.CREATE, (event: IpcMainInvokeEvent, params: unknown) => {
    assertTrustedSender(event);
    const opts = parseCreateParams(params, event.sender);
    // Renderer callers normally omit shellPref. Resolve the persisted default
    // once at the main-process create boundary so the session snapshots the
    // choice and restart keeps using the same preference even if Settings
    // changes later. Explicit `auto`, a concrete shell, and `null` keep their
    // existing caller-provided semantics.
    const resolvedOpts: CreateOptions = {
      ...opts,
      shellPref: opts.shellPref === undefined ? getDefaultShellPref() : opts.shellPref,
    };
    try {
      const result = manager.create(resolvedOpts);
      return result satisfies CreateResult;
    } catch (err) {
      // 区分 shell not found vs 通用 spawn 失败。shellResolver 永远返回 ResolvedShell，
      // 兜底到 /bin/sh / cmd.exe；这里失败一般是 spawn 系统调用层面的（权限 / 路径不可达）。
      const msg = err instanceof Error ? err.message : String(err);
      if (/TERMINAL_AGENT_NOT_READY/.test(msg)) {
        throwIpcError('TERMINAL_AGENT_NOT_READY', 'the selected Agent runtime is not ready');
      }
      if (/TERMINAL_OWNER_MISMATCH|TERMINAL_SESSION_MISMATCH/.test(msg)) {
        throwIpcError('PERMISSION_DENIED', 'terminal session cannot be attached by this window');
      }
      if (/ENOENT|not found|no such file/i.test(msg)) {
        log.warn('terminal executable unavailable', { sensitive: { error: err } });
        throwIpcError('TERMINAL_SHELL_NOT_FOUND', 'the selected shell binary is unavailable');
      }
      log.warn('terminal spawn failed', { sensitive: { error: err } });
      throwIpcError('TERMINAL_SPAWN_FAILED', 'failed to start the terminal process');
    }
  });

  ipcMain.handle(
    TERMINAL_INVOKE.WRITE,
    (event: IpcMainInvokeEvent, idArg: unknown, dataArg: unknown) => {
      assertTrustedSender(event);
      const id = requireString(idArg, 'id', MAX_TERMINAL_ID_LENGTH);
      const data = requireString(dataArg, 'data', MAX_TERMINAL_WRITE_LENGTH);
      if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
      if (!manager.isOwner(id, event.sender)) {
        throwIpcError('PERMISSION_DENIED', 'terminal session is owned by another window');
      }
      manager.write(id, data, event.sender);
    },
  );

  ipcMain.handle(
    TERMINAL_INVOKE.RESIZE,
    (event: IpcMainInvokeEvent, idArg: unknown, colsArg: unknown, rowsArg: unknown) => {
      assertTrustedSender(event);
      const id = requireString(idArg, 'id', MAX_TERMINAL_ID_LENGTH);
      const cols = requirePositiveInt(colsArg, 'cols', MAX_TERMINAL_DIMENSION);
      const rows = requirePositiveInt(rowsArg, 'rows', MAX_TERMINAL_DIMENSION);
      if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
      if (!manager.isOwner(id, event.sender)) {
        throwIpcError('PERMISSION_DENIED', 'terminal session is owned by another window');
      }
      manager.resize(id, cols, rows, event.sender);
    },
  );

  ipcMain.handle(TERMINAL_INVOKE.DISPOSE, (event: IpcMainInvokeEvent, idArg: unknown) => {
    assertTrustedSender(event);
    const id = requireString(idArg, 'id', MAX_TERMINAL_ID_LENGTH);
    if (manager.has(id) && !manager.isOwner(id, event.sender)) {
      throwIpcError('PERMISSION_DENIED', 'terminal session is owned by another window');
    }
    manager.dispose(id, event.sender);
  });

  ipcMain.handle(TERMINAL_INVOKE.RESTART, (event, idArg: unknown) => {
    assertTrustedSender(event);
    const id = requireString(idArg, 'id', MAX_TERMINAL_ID_LENGTH);
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    if (!manager.isOwner(id, event.sender)) {
      throwIpcError('PERMISSION_DENIED', 'terminal session is owned by another window');
    }
    try {
      const result = manager.restart(id, event.sender);
      return result satisfies CreateResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/still running/i.test(msg)) {
        throwIpcError('PRECONDITION_FAILED', 'cannot restart a session that has not exited');
      }
      if (/TERMINAL_AGENT_NOT_READY/.test(msg)) {
        throwIpcError('TERMINAL_AGENT_NOT_READY', 'the selected Agent runtime is not ready');
      }
      if (/ENOENT|no such file|(?:executable|binary) .*not found/i.test(msg)) {
        log.warn('terminal executable unavailable during restart', {
          sensitive: { error: err },
        });
        throwIpcError('TERMINAL_SHELL_NOT_FOUND', 'the selected terminal binary is unavailable');
      }
      if (/session not found|already disposed/i.test(msg)) {
        throwIpcError('TERMINAL_ALREADY_DISPOSED', 'terminal session was already disposed');
      }
      log.warn('terminal restart failed', { sensitive: { error: err } });
      throwIpcError('TERMINAL_SPAWN_FAILED', 'failed to restart the terminal process');
    }
  });

  ipcMain.handle(
    TERMINAL_INVOKE.LIST_AVAILABLE_SHELLS,
    (event: IpcMainInvokeEvent): AvailableShell[] => {
      assertTrustedSender(event);
      return probeAvailableShells();
    },
  );

  ipcMain.handle(TERMINAL_INVOKE.GET_DEFAULT_SHELL_PREF, (event: IpcMainInvokeEvent): ShellId => {
    assertTrustedSender(event);
    return getDefaultShellPref();
  });

  ipcMain.handle(
    TERMINAL_INVOKE.SET_DEFAULT_SHELL_PREF,
    (event: IpcMainInvokeEvent, valueArg: unknown) => {
      assertTrustedSender(event);
      if (typeof valueArg !== 'string' || !VALID_SHELL_PREFS.has(valueArg as ShellId)) {
        throwIpcError('INVALID_PARAMS', `invalid shell pref: ${String(valueArg)}`);
      }
      setDefaultShellPref(valueArg as ShellId);
    },
  );

  return manager;
}

/**
 * Outbound PTY payloads contain arbitrary command output (often source code,
 * credentials printed by a CLI, or other user data).  Treat the destination
 * as an authorization boundary too: a WebContents that navigated away from a
 * Cindy app page must not receive queued output merely because its native
 * process is still alive.
 */
function isTrustedTerminalOwner(target: WebContents): boolean {
  if (target.isDestroyed()) return false;
  try {
    return isTrustedAppRendererWindow(BrowserWindow.fromWebContents(target));
  } catch {
    // Electron may race destruction/navigation with a push.  Fail closed.
    return false;
  }
}

// ---------- params 校验 helpers ----------

function parseCreateParams(raw: unknown, owner: WebContents): CreateOptions {
  if (!raw || typeof raw !== 'object') {
    throwIpcError('INVALID_PARAMS', 'create params must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const id = requireString(obj.id, 'id', MAX_TERMINAL_ID_LENGTH);
  const cwd = requireString(obj.cwd, 'cwd', MAX_TERMINAL_CWD_LENGTH);
  const cols = optionalPositiveInt(obj.cols);
  const rows = optionalPositiveInt(obj.rows);
  const shellPref = optionalShellPref(obj.shellPref);
  const profile = optionalTerminalProfile(obj.profile);
  return { id, cwd, cols, rows, shellPref, profile, owner };
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throwIpcError(
      'INVALID_PARAMS',
      `${name} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function requirePositiveInt(value: unknown, name: string, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > max ||
    !Number.isInteger(value)
  ) {
    throwIpcError('INVALID_PARAMS', `${name} must be a positive integer at most ${max}`);
  }
  return value;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requirePositiveInt(value, 'optional number', MAX_TERMINAL_DIMENSION);
}

function optionalShellPref(value: unknown): ShellId | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !VALID_SHELL_PREFS.has(value as ShellId)) {
    throwIpcError('INVALID_PARAMS', `invalid shellPref: ${String(value)}`);
  }
  return value as ShellId;
}

function optionalTerminalProfile(value: unknown): TerminalProfile | undefined {
  if (value === undefined) return undefined;
  if (!isTerminalProfile(value)) {
    throwIpcError('INVALID_PARAMS', `invalid terminal profile: ${String(value)}`);
  }
  return value;
}
