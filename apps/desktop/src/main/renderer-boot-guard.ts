/**
 * apps/desktop/src/main/renderer-boot-guard.ts
 *
 * dev-only 的 renderer 启动看门狗。
 *
 * 背景:dev 模式主窗 loadURL 后,若 renderer 在模块求值阶段就挂掉(典型:stale Vite
 * prebundle 的 `does not provide an export named X`,或 dev server 竞态),页面不会触发
 * did-fail-load、renderer 端 logger 也没机会初始化 —— 主进程日志零痕迹,窗口永远黑屏,
 * 且没有任何自愈路径。
 *
 * 判据:以「renderer 首个存活信号」为准(renderer:log IPC 或 check-environment invoke,
 * 由 bootstrap-electron 在对应 handler 里调 markAlive())。超时未收到 → 记 ERROR 日志并
 * reloadIgnoringCache() 自愈;有限次重试后放弃,在日志里给出人工处置指引。
 *
 * 一旦收到过存活信号,看门狗永久解除 —— 不会在正常运行中误触发 reload。
 */

/** 看门狗操作的窗口面(仅取所需方法,便于单测注入 fake)。 */
export interface BootGuardTarget {
  isDestroyed(): boolean;
  reloadIgnoringCache(): void;
}

export interface RendererBootGuardOptions {
  /** 每轮等待 renderer 存活信号的毫秒数。默认 30s(覆盖冷启动全量 transform 的最坏耗时)。 */
  timeoutMs?: number;
  /** 自动 reload 的最大次数,超过后放弃并留终局日志。默认 2。 */
  maxReloads?: number;
  logError: (msg: string) => void;
  logInfo: (msg: string) => void;
  /** 定时器注入点(单测用 fake timer)。默认走全局 setTimeout / clearTimeout。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RELOADS = 2;

/**
 * The dispatcher can log an entry-import failure before React or the main
 * renderer has started. That report is diagnostic evidence, not a boot-ready
 * signal; otherwise it would disarm the very guard meant to recover it.
 */
export function shouldMarkRendererBootAliveFromLog(scope: string): boolean {
  return scope !== 'renderer/entry';
}

export class RendererBootGuard {
  private alive = false;
  private disposed = false;
  private reloads = 0;
  private timer: unknown = null;

  private readonly timeoutMs: number;
  private readonly maxReloads: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(
    private readonly target: BootGuardTarget,
    private readonly opts: RendererBootGuardOptions,
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReloads = opts.maxReloads ?? DEFAULT_MAX_RELOADS;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** loadURL 之后调用,开始一轮存活等待。幂等:已存活 / 已 dispose 时 no-op。 */
  start(): void {
    if (this.alive || this.disposed || this.timer !== null) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.onTimeout();
    }, this.timeoutMs);
  }

  /** renderer 发来首个存活信号时调用。永久解除看门狗。 */
  markAlive(): void {
    if (this.alive) return;
    this.alive = true;
    this.clearTimer();
    if (this.reloads > 0) {
      this.opts.logInfo(
        `renderer recovered after ${this.reloads} auto-reload(s) — boot guard disarmed`,
      );
    }
  }

  /** 窗口销毁时调用,停止一切后续动作。 */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  private onTimeout(): void {
    if (this.alive || this.disposed || this.target.isDestroyed()) return;
    if (this.reloads < this.maxReloads) {
      this.reloads += 1;
      this.opts.logError(
        `renderer produced no activity within ${this.timeoutMs}ms after load — ` +
          `likely dead at module evaluation (stale Vite prebundle / dev server race). ` +
          `Auto-reloading (attempt ${this.reloads}/${this.maxReloads})`,
      );
      this.target.reloadIgnoringCache();
      this.start();
    } else {
      this.opts.logError(
        `renderer still dead after ${this.maxReloads} auto-reload(s) — giving up. ` +
          `Manual fix: quit dev, run "rm -rf apps/desktop/node_modules/.vite" then restart ` +
          `(pnpm restart:desktop:remote); check this log for renderer-console errors above.`,
      );
    }
  }
}
