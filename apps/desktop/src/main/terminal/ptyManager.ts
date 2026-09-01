/**
 * PtyManager —— 管理一组 PTY session（一个 tab 一个 session）。
 *
 * 设计要点（对照 Codex Desktop `main-cC-d0ezP.js:60513-60647` 的 s1 + h1 class）:
 *
 *   - **session 生命周期 = tab 生命周期 = main 进程生命周期**：
 *     PTY 在 `create(id, opts)` 时 spawn，在 `dispose(id)` 时 kill；中间用户 `exit`
 *     或程序 crash 触发 onExit，session 保留在 Map 里（`exitState` 填上退出码），
 *     渲染端 overlay 显示 "Process exited with code N" + Restart 按钮。用户点 Restart
 *     就调 `restart(id)`，原地换一个新 PTY，id 不变。
 *
 *   - **input write 微任务级批处理**：xterm.js 的 onData 每个按键都 fire 一次（粘贴
 *     文本时会 fire 一长串），如果直接 IPC → pty.write 会产生 N 次系统调用 + N 次 IPC。
 *     收到的 input 先累积到 `pendingWrites[id]`，schedule 一个 microtask 一次性 flush。
 *     这是 codex L60589-60607 同款模式。
 *
 *   - **owner WebContents 绑定**：每个 session 记录它的 owner（PTY 输出 sink 的目标窗口）。
 *     webContents destroyed 时优先通过 `resolveFallbackOwner` 把 session 转移给接管者
 *     （RSB 独立子窗口销毁 → 主窗接管，PTY 保活）；解析不到活的接管者才 dispose
 *     该 owner 的所有 session（防止用户关窗后 PTY 还在跑、IPC send 又报错）。
 *     注册一次监听（per webContents）即可，复用 `trackedOwners` 去重。
 *
 *   - **OSC stripping 暂不做**：codex 的 u1 函数过滤 cursor 查询响应等。xterm.js
 *     在 renderer 端已能正确处理标准序列，先不加这一层；后续真有需要再补。
 *
 *   - **encoding**：node-pty 默认 utf8，onData 直接给 string，无需 StringDecoder。
 *     codex s1 class 同样没显式包 decoder。
 */

import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import type { WebContents } from 'electron';

import { createLogger } from '../logger.js';
import { resolveShellForCreate, type ShellId, type ResolvedShell } from './shellResolver.js';
import { defaultPtySpawn, type PtySpawnFn } from './ptyFactory.js';
import { resolveTerminalCommand, type ResolvedTerminalCommand } from './agentProfileResolver.js';
import type { TerminalProfile } from '../../shared/terminal-bridge.js';

const log = createLogger('terminal/pty-manager');

const TERMINAL_NAME = 'xterm-256color';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * 必须从父 env 删掉的变量集合。对照 Codex Desktop `buildTerminalEnv` 的做法
 * (`main-cC-d0ezP.js:61156-61172`) + 经验黑名单。
 *
 * 为什么要删:
 *   - **TERMINFO / TERMINFO_DIRS**: 父进程(dev terminal / Finder)可能指向某个
 *     非标准 termcap 目录,zsh / ncurses 应用会按它解析序列,跟 xterm.js 的处理
 *     能力不对齐,输出乱码。Codex 显式删这两个。
 *   - **TERM_PROGRAM / TERM_PROGRAM_VERSION / TERM_SESSION_ID**: macOS / Apple
 *     Terminal / iTerm / VSCode 注入的"我是什么 terminal app"标记。oh-my-zsh /
 *     P10k 看到这些会激活该 app 特有的 OSC 序列输出(iTerm shell integration、
 *     VSCode terminal integration 等),xterm.js 不解析这些 → 显示成文本残留。
 *   - **LC_TERMINAL / LC_TERMINAL_VERSION**: iTerm 二级标记(`LC_*` 走 SSH 透
 *     传也能被 detect),同理。
 *   - **ITERM_PROFILE / ITERM_SESSION_ID**: iTerm 特定。
 *   - **VSCODE_***: VSCode injected shell integration script 的入口标记,会让
 *     bashrc/zshrc 的 vscode hook 跑起来,产出 OSC 633 序列。
 *   - **COLORTERM**: 保留(`truecolor` 让 prompt 用 24-bit 色,我们 xterm.js 也支持)。
 *
 * dev 模式下父 shell 把这些都塞进了 Electron `process.env`,packaged Finder 启动
 * 时一般干净,但保险起见两种场景都剥。
 */
const ENV_KEYS_TO_STRIP: readonly string[] = [
  'TERMINFO',
  'TERMINFO_DIRS',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'ITERM_PROFILE',
  'ITERM_SESSION_ID',
  'ITERM_SHELL_INTEGRATION_INSTALLED',
  'VSCODE_INJECTION',
  'VSCODE_PID',
  'VSCODE_GIT_IPC_HANDLE',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_NLS_CONFIG',
  'VSCODE_CWD',
  'GIT_ASKPASS', // VSCode 注入的 askpass shim,装了会导致 git 走 VSCode 弹窗
];

export interface CreateOptions {
  /** PTY session id，对应 RSB tab id（1:1 关系）。 */
  id: string;
  /** 工作目录；不存在或为空时主调方应自己 fallback 到 home。 */
  cwd: string;
  cols?: number;
  rows?: number;
  /** Settings 中的用户偏好（'auto' / 具体 id / null）。 */
  shellPref?: ShellId | null;
  /** 受控 profile；省略时为普通 shell。 */
  profile?: TerminalProfile;
  /** 创建者 webContents，session destroyed 时自动 dispose 该 owner 所有 session。 */
  owner: WebContents;
  /** 额外 env 覆盖（不强制）。会跟 process.env 浅合并。 */
  env?: Record<string, string | undefined>;
}

export interface CreateResult {
  shellId: string;
  shellDisplayName: string;
  pid: number;
  profile: TerminalProfile;
  profileDisplayName: string;
  exit: ExitInfo | null;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface DataPayload {
  id: string;
  chunk: string;
}

export interface ExitPayload {
  id: string;
  exit: ExitInfo;
}

/** 主进程对外暴露的事件接收器。生产代码 → 走 webContents.send；测试 → 自定义收集。 */
export interface PtyEventSink {
  emitData: (target: WebContents, payload: DataPayload) => void;
  emitExit: (target: WebContents, payload: ExitPayload) => void;
}

interface PtySession {
  id: string;
  pty: IPty;
  resolved: ResolvedShell | ResolvedTerminalCommand;
  cwd: string;
  cols: number;
  rows: number;
  shellPref: ShellId | null;
  profile: TerminalProfile;
  exit: ExitInfo | null;
  owner: WebContents;
  /** 累积待发的 input；flush 完清空。 */
  pendingInput: string;
  /** flush 用的 microtask 是否已经 schedule。 */
  flushScheduled: boolean;
  /** node-pty IDisposable for data subscription；dispose 时手动解订阅。 */
  dataDisposer: { dispose(): void };
  exitDisposer: { dispose(): void };
  /** UTF-8 分块兜底：理论上 node-pty utf8 模式已经处理边界，但保留一份本地 decoder
   *  在收到不合法 surrogate 时仍能给出合理输出。 */
  decoder: StringDecoder;
}

export interface PtyManagerDeps {
  spawn?: PtySpawnFn;
  sink: PtyEventSink;
  /** 仅供测试注入平台；生产代码默认使用当前 Node 平台。 */
  platform?: NodeJS.Platform;
  /**
   * owner webContents destroyed 时的接管者解析(典型:主窗 webContents)。
   * 返回一个活着的、不同于 dead owner 的 webContents 时,该 owner 的 session
   * 整体转移过去(PTY 保活,输出 sink 改推新 owner);返回 null / undefined /
   * 已销毁 / 同一个 webContents 时,回落旧行为 —— dispose 该 owner 全部 session。
   *
   * 动机:RSB 独立子窗口里的终端 re-attach 会把 owner 切到子窗口,用户收起 /
   * 合并回主窗时子窗口销毁 —— 不能因此杀掉运行中的进程(内嵌形态收起侧栏
   * 不杀,两种形态语义必须一致)。主窗销毁(app 退出)时 fallback 解析不到
   * 活 webContents,仍走 dispose,不会泄漏 PTY。
   */
  resolveFallbackOwner?: (deadOwner: WebContents) => WebContents | null;
  /**
   * Explicit ownership hand-off gate for a live session. The terminal renderer
   * moves between the primary window and the registered detached RSB window,
   * but unrelated Cindy windows must not be able to claim a PTY just by
   * guessing its id.
   */
  canTransferOwner?: (
    currentOwner: WebContents,
    nextOwner: WebContents,
    sessionId: string,
  ) => boolean;
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();
  private readonly trackedOwners = new WeakSet<WebContents>();
  private readonly spawnFn: PtySpawnFn;
  private readonly sink: PtyEventSink;
  private readonly platform: NodeJS.Platform;
  private readonly resolveFallbackOwner?: (deadOwner: WebContents) => WebContents | null;
  private readonly canTransferOwner?: PtyManagerDeps['canTransferOwner'];

  constructor(deps: PtyManagerDeps) {
    this.spawnFn = deps.spawn ?? defaultPtySpawn;
    this.sink = deps.sink;
    this.platform = deps.platform ?? process.platform;
    this.resolveFallbackOwner = deps.resolveFallbackOwner;
    this.canTransferOwner = deps.canTransferOwner;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Check the renderer that currently owns a session. Terminal ids are
   * persisted and therefore guessable; every mutating operation must still be
   * tied to the WebContents that attached the PTY. The caller can distinguish
   * a missing session via has() before invoking this method.
   */
  isOwner(id: string, owner: WebContents): boolean {
    return this.sessions.get(id)?.owner === owner;
  }

  /**
   * 创建 PTY,或在同 id 已存在时返回现有 session 的元数据(幂等 / createOrAttach 语义)。
   *
   * 为什么幂等:
   *   RSB 切换 session 时,TabBody 卸载,但 main 端 PTY 是按 plugin.onBeforeClose 时
   *   才 dispose 的(切 session != 关 tab)。再切回同 session,TabBody 重新挂载,
   *   plugin.hydrateState 把 state.created 强制设回 false(防 app 重启后空指针),
   *   renderer 又会调 terminal.create(id) —— 同 id 已存在,这里若抛错就破坏体验。
   *
   *   codex `main-cC-d0ezP.js:60738` 的 createOrAttach 同款思路。
   *
   * 行为:
   *   - 同 id 已存在 → 返回现有 metadata(含 exit 状态),并在显式 ownership gate
   *     允许时更新 owner 到新 webContents(renderer 在主窗 / RSB 子窗间迁移);
   *     新传入的 cwd/cols/rows 忽略 —— PTY 内部状态已经走过了,xterm 之后会 resize 同步。
   *   - 同 id 已 exit 仍允许 re-attach;新宿主拿到 exit metadata 后继续显示 overlay,
   *     用户点 Restart 才会显式重启。否则跨窗口后的新宿主拿不到 restart ownership。
   */
  create(opts: CreateOptions): CreateResult {
    const existing = this.sessions.get(opts.id);
    if (existing) {
      const requestedProfile = opts.profile ?? 'shell';
      if (
        existing.profile !== requestedProfile ||
        !sameWorkingDirectory(existing.cwd, opts.cwd, this.platform)
      ) {
        // createOrAttach may move the output sink, but it never mutates the
        // command/cwd of an already-running process. A profile change requires
        // a fresh pane (or an explicit dispose followed by create).
        throw new Error(`TERMINAL_SESSION_MISMATCH:${opts.id}`);
      }
      if (existing.owner !== opts.owner) {
        if (!this.canTransferOwner?.(existing.owner, opts.owner, opts.id)) {
          throw new Error(`TERMINAL_OWNER_MISMATCH:${opts.id}`);
        }
        existing.owner = opts.owner;
        this.trackOwner(opts.owner);
      }
      log.info('pty attached (already exists)', {
        safe: {
          id: opts.id,
          shellId: existing.resolved.id,
          shellDisplayName: existing.resolved.displayName,
          pid: existing.pty.pid,
        },
      });
      return {
        shellId: existing.resolved.id,
        shellDisplayName: existing.resolved.displayName,
        pid: existing.pty.pid,
        profile: existing.profile,
        profileDisplayName: existing.resolved.displayName,
        exit: existing.exit,
      };
    }
    const session = this.spawnSession(opts);
    this.sessions.set(opts.id, session);
    this.trackOwner(opts.owner);
    log.info('pty created', {
      safe: {
        id: opts.id,
        shellId: session.resolved.id,
        shellDisplayName: session.resolved.displayName,
        cols: session.cols,
        rows: session.rows,
        pid: session.pty.pid,
      },
    });
    return {
      shellId: session.resolved.id,
      shellDisplayName: session.resolved.displayName,
      pid: session.pty.pid,
      profile: session.profile,
      profileDisplayName: session.resolved.displayName,
      exit: null,
    };
  }

  /** xterm.js 的 onData 透传过来的用户输入。微任务级批处理。 */
  write(id: string, data: string, owner: WebContents): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.exit) return;
    session.pendingInput += data;
    if (session.flushScheduled) return;
    session.flushScheduled = true;
    // Capture the concrete session, rather than looking it up by id when the
    // microtask runs. A dispose→create cycle can reuse the same id before the
    // microtask is flushed; looking up by id would leak bytes into the
    // replacement process.
    queueMicrotask(() => this.flushPendingInput(session));
  }

  private flushPendingInput(session: PtySession): void {
    // The session may have been disposed/replaced while the microtask was
    // queued. Identity (not just id) is the lifecycle fence.
    if (this.sessions.get(session.id) !== session) return;
    session.flushScheduled = false;
    if (session.exit || session.pendingInput.length === 0) return;
    const chunk = session.pendingInput;
    session.pendingInput = '';
    try {
      session.pty.write(chunk);
    } catch (err) {
      log.warn('pty write failed', {
        safe: { id: session.id, length: chunk.length },
        sensitive: { error: err },
      });
    }
  }

  resize(id: string, cols: number, rows: number, owner: WebContents): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.exit) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    if (session.cols === cols && session.rows === rows) return;
    try {
      session.pty.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    } catch (err) {
      log.warn('pty resize failed', {
        safe: { id, cols, rows },
        sensitive: { error: err },
      });
    }
  }

  /** 真正关闭 PTY + 移出 Map。已经 exit 的也走一遍清理（idempotent）。 */
  dispose(id: string, owner: WebContents): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return;
    this.disposeSession(session);
  }

  /** Internal owner-destruction cleanup; callers must already hold the session. */
  private disposeSession(session: PtySession): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    this.cleanupSession(session);
  }

  /** Release native subscriptions and (when still running) terminate a PTY. */
  private cleanupSession(session: PtySession): void {
    // Cancel any queued microtask payload before killing the PTY. The identity
    // fence in flushPendingInput is the hard guard; clearing eagerly also
    // releases potentially large paste buffers while a process is shutting
    // down.
    session.pendingInput = '';
    session.flushScheduled = false;
    try {
      session.dataDisposer.dispose();
      session.exitDisposer.dispose();
    } catch {
      /* swallow */
    }
    if (!session.exit) {
      try {
        session.pty.kill();
      } catch (err) {
        log.warn('pty kill failed on dispose', {
          safe: { id: session.id },
          sensitive: { error: err },
        });
      }
    }
    log.info('pty disposed', { safe: { id: session.id, alreadyExited: session.exit != null } });
  }

  /** 在已 exit 的 session 上重启；id 保留，PTY 实例替换。 */
  restart(id: string, owner: WebContents): CreateResult {
    const old = this.sessions.get(id);
    if (!old) throw new Error(`terminal session not found: ${id}`);
    if (old.owner !== owner) throw new Error(`TERMINAL_OWNER_MISMATCH:${id}`);
    if (!old.exit) throw new Error(`terminal session still running: ${id}`);

    // Spawn the replacement before retiring the exited record. If binary
    // resolution/spawn fails (for example an Agent runtime is still being
    // prepared), keeping the old exited session lets the renderer retry
    // instead of turning the pane into an unrecoverable "not found" state.
    const replacement = this.spawnSession({
      id,
      cwd: old.cwd,
      cols: old.cols,
      rows: old.rows,
      shellPref: old.shellPref,
      profile: old.profile,
      owner,
    });
    this.sessions.set(id, replacement);
    this.trackOwner(owner);
    this.cleanupSession(old);
    log.info('pty restarted', {
      safe: { id, shellId: replacement.resolved.id, pid: replacement.pty.pid },
    });
    return {
      shellId: replacement.resolved.id,
      shellDisplayName: replacement.resolved.displayName,
      pid: replacement.pty.pid,
      profile: replacement.profile,
      profileDisplayName: replacement.resolved.displayName,
      exit: null,
    };
  }

  /** 触发某 owner 的全部 session 关闭，用于 webContents destroyed。 */
  disposeOwner(owner: WebContents): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) this.disposeSession(session);
    }
  }

  /** 测试用：枚举当前 session（包含 exit 状态）。 */
  __debugListSessions(): Array<{
    id: string;
    exit: ExitInfo | null;
    shellId: string;
    shellPref: ShellId | null;
    profile: TerminalProfile;
    cols: number;
    rows: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      exit: s.exit,
      shellId: s.resolved.id,
      shellPref: s.shellPref,
      profile: s.profile,
      cols: s.cols,
      rows: s.rows,
    }));
  }

  private spawnSession(opts: CreateOptions): PtySession {
    // The PTY's cwd is supplied by the renderer, but it is still a native
    // process boundary.  Refuse empty/NUL-containing paths here as a second
    // line of defence for callers that bypass the IPC parser (tests or future
    // Main-owned call sites).
    if (!opts.cwd || opts.cwd.length > 4_096 || opts.cwd.includes('\0')) {
      throw new Error('invalid terminal working directory');
    }
    const cols = opts.cols && opts.cols > 0 ? opts.cols : DEFAULT_COLS;
    const rows = opts.rows && opts.rows > 0 ? opts.rows : DEFAULT_ROWS;
    const profile = opts.profile ?? 'shell';
    const resolved =
      resolveTerminalCommand(profile) ?? resolveShellForCreate(opts.shellPref ?? null);

    // 合并 env:先复制父进程环境,做平台兜底,再应用调用方显式覆盖。
    // ENV_KEYS_TO_STRIP 与 TERM 仍在下方强制执行,不允许 opts.env 改写。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    ensureMacTerminalUtf8Locale(env, this.platform);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (typeof v === 'string') env[k] = v;
        else if (v === undefined) delete env[k];
      }
    }
    // 剥掉父进程 inherit 来的 terminal app 标记 —— 让 shell 启动脚本以为自己跑
    // 在一个普通的 xterm-256color 终端里(对照 Codex `buildTerminalEnv`)。
    // 必须在 opts.env 之后做,这样调用方仍能显式塞回某个变量。
    for (const k of ENV_KEYS_TO_STRIP) delete env[k];
    env.TERM = TERMINAL_NAME;

    const spawnOpts: IPtyForkOptions | IWindowsPtyForkOptions = {
      name: TERMINAL_NAME,
      cols,
      rows,
      cwd: opts.cwd,
      env,
      // node-pty 默认 utf8，显式写出来更清楚
      encoding: 'utf8',
    };

    const pty = this.spawnFn(resolved.command, resolved.args, spawnOpts);
    const session: PtySession = {
      id: opts.id,
      pty,
      resolved,
      cwd: opts.cwd,
      cols,
      rows,
      shellPref: opts.shellPref ?? null,
      profile,
      exit: null,
      owner: opts.owner,
      pendingInput: '',
      flushScheduled: false,
      decoder: new StringDecoder('utf8'),
      // 占位，注册下面就替换。
      dataDisposer: { dispose() {} },
      exitDisposer: { dispose() {} },
    };

    session.dataDisposer = pty.onData((chunk: string) => {
      // node-pty 在 utf8 模式下已经按 UTF-8 边界切，再走 decoder 主要是对 Buffer
      // 兜底（极端情况下出现 surrogate pair 跨 chunk）。这里 chunk 是 string，
      // 直接转发即可，decoder.write 仅在某些异常路径上有意义。
      // A native callback can be queued after this session was replaced under
      // the same id. Fence by object identity so stale output cannot enter the
      // replacement pane.
      if (this.sessions.get(session.id) !== session) return;
      if (!session.owner.isDestroyed()) {
        this.sink.emitData(session.owner, { id: session.id, chunk });
      }
    });

    session.exitDisposer = pty.onExit(({ exitCode, signal }) => {
      // node-pty may deliver an already queued exit callback after dispose;
      // suppress it (and duplicate callbacks) at the lifecycle boundary.
      if (this.sessions.get(session.id) !== session || session.exit) return;
      const exitInfo: ExitInfo = {
        code: typeof exitCode === 'number' ? exitCode : null,
        signal: signal != null ? String(signal) : null,
      };
      session.exit = exitInfo;
      // flush 一下残留输入（exit 后写无意义，但保持状态干净）
      session.pendingInput = '';
      log.info('pty exit', {
        safe: { id: session.id, code: exitInfo.code, signal: exitInfo.signal },
      });
      if (!session.owner.isDestroyed()) {
        this.sink.emitExit(session.owner, { id: session.id, exit: exitInfo });
      }
    });

    return session;
  }

  private trackOwner(owner: WebContents): void {
    if (this.trackedOwners.has(owner)) return;
    this.trackedOwners.add(owner);
    owner.once('destroyed', () => {
      this.handleOwnerDestroyed(owner);
    });
  }

  /**
   * owner destroyed 的处理:能解析到活的 fallback owner(主窗)就整体转移
   * session(PTY 保活,sink 改推 fallback),否则 dispose(app 退出 / 主窗没了)。
   */
  private handleOwnerDestroyed(owner: WebContents): void {
    const fallback = this.resolveFallbackOwner?.(owner) ?? null;
    if (!fallback || fallback === owner || fallback.isDestroyed()) {
      this.disposeOwner(owner);
      return;
    }
    let transferred = 0;
    for (const session of this.sessions.values()) {
      if (session.owner !== owner) continue;
      // A fallback is a candidate, not blanket authority. Production allows
      // only the registered detached RSB -> primary-window hand-off; sessions
      // owned by another Cindy window are retired instead of silently moved.
      if (this.canTransferOwner && !this.canTransferOwner(owner, fallback, session.id)) {
        this.disposeSession(session);
        continue;
      }
      session.owner = fallback;
      transferred += 1;
    }
    if (transferred > 0) {
      this.trackOwner(fallback);
      log.info('pty sessions transferred to fallback owner on webContents destroy', {
        safe: { count: transferred },
      });
    }
  }
}

/**
 * macOS Finder/Dock 启动的 GUI 进程可能继承到空/C locale。zsh 的行编辑器
 * 需要 UTF-8 的 LC_CTYPE 才能正确识别中文等多字节输入；只设置 LANG 不够，
 * 因为非空 LC_CTYPE 会覆盖 LANG。非空 LC_ALL 通常表示用户主动指定，保留其
 * 语义；调用方通过 opts.env 传入的显式覆盖也在本函数之后生效。
 */
function ensureMacTerminalUtf8Locale(env: Record<string, string>, platform: NodeJS.Platform): void {
  if (platform !== 'darwin' || env.LC_ALL?.trim()) return;

  const charLocale = env.LC_CTYPE?.trim() || env.LANG?.trim() || 'C';
  const normalized = charLocale.toUpperCase();
  if (normalized !== 'C' && normalized !== 'POSIX') return;

  env.LC_CTYPE = 'UTF-8';
}

function sameWorkingDirectory(
  current: string,
  requested: string,
  platform: NodeJS.Platform,
): boolean {
  const left = path.resolve(current);
  const right = path.resolve(requested);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
