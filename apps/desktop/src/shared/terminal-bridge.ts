/**
 * RSB terminal tab 在 main / preload / renderer 之间共享的 typing。
 *
 * preload 把 main 进程的 TERMINAL_INVOKE / TERMINAL_PUSH 通道再封装一层 `window.electronAPI.terminal`，
 * renderer 走类型走这里。channel 字符串常量本身保留在 `main/maker-ipc/channels.ts`，
 * preload 内联字面量；这里只定义 payload / 入参 shape。
 */

export type ShellId =
  | 'auto'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'sh'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'gitbash'
  | 'wsl';

/**
 * 终端工作台允许启动的受控 profile。
 *
 * Renderer 只能传这些稳定枚举，不能传 executable、args 或 env。Main 进程
 * 根据 profile 从受管的 agent binary 链解析真正的执行文件。
 */
export const TERMINAL_PROFILES = ['shell', 'claude', 'codex', 'pi'] as const;
export type TerminalProfile = (typeof TERMINAL_PROFILES)[number];

export function isTerminalProfile(value: unknown): value is TerminalProfile {
  return typeof value === 'string' && (TERMINAL_PROFILES as readonly string[]).includes(value);
}

export interface AvailableShell {
  id: Exclude<ShellId, 'auto'>;
  command: string;
  displayName: string;
  isAutoDetectTarget: boolean;
}

export interface TerminalCreateParams {
  /** 跟 RSB tabId 一致（1:1 关系）。 */
  id: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Settings 用户偏好；不传走 main 端的 GET_DEFAULT_SHELL_PREF。 */
  shellPref?: ShellId | null;
  /** 受控启动 profile；省略时创建普通 shell。 */
  profile?: TerminalProfile;
}

export interface TerminalCreateResult {
  /** Shell id for shell panes; profile id for agent panes (kept as a string for compatibility). */
  shellId: string;
  shellDisplayName: string;
  pid: number;
  profile: TerminalProfile;
  profileDisplayName: string;
  /** Re-attach reconciliation for a process that exited while another window owned it. */
  exit: TerminalExitInfo | null;
}

export interface TerminalExitInfo {
  code: number | null;
  signal: string | null;
}

/** main → renderer 推送的 data event payload。 */
export interface TerminalDataEvent {
  id: string;
  chunk: string;
}

/** main → renderer 推送的 exit event payload。 */
export interface TerminalExitEvent {
  id: string;
  exit: TerminalExitInfo;
}

/** preload 暴露给 renderer 的 terminal API 形状。 */
export interface TerminalBridge {
  create(params: TerminalCreateParams): Promise<TerminalCreateResult>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  dispose(id: string): Promise<void>;
  restart(id: string): Promise<TerminalCreateResult>;
  listAvailableShells(): Promise<AvailableShell[]>;
  getDefaultShellPref(): Promise<ShellId>;
  setDefaultShellPref(value: ShellId): Promise<void>;
  /** 订阅 PTY 输出。回调每条 onData 都会被调；renderer 自己按 id filter。 */
  onData(callback: (event: TerminalDataEvent) => void): () => void;
  /** 订阅 PTY 退出。 */
  onExit(callback: (event: TerminalExitEvent) => void): () => void;
}
