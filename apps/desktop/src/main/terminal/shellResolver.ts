/**
 * 跨平台 shell 检测 + 可用 shell 列表 probe（对照 Codex Desktop
 * `main-cC-d0ezP.js:29968-30040` 的 Windows 检测逻辑）。
 *
 * - `resolveAutoDetectShell()`：当前平台默认 shell 选择，永远返回一个可用 shell
 *   （Windows 兜底到 `cmd.exe`，*nix 兜底到 `/bin/sh`）。
 * - `resolveShellById(id)`：用户在 Settings 选了具体 shell 时按 id 解析；找不到回 null。
 * - `resolveShellForCreate(pref)`：业务方唯一入口，pref `null`/`'auto'` 走 auto-detect；
 *   选了具体 id 但当下已经不可用（卸了 pwsh 等）也回退 auto-detect，保证终端永远能开起来。
 * - `probeAvailableShells()`：Settings 下拉打开时调，返回当前平台 + 当前机器装了的 shell。
 *   进程级 memo —— 重启 app 才重新 probe（用户期间装新 shell 自动感知不是产品诉求）。
 *
 * 跨平台细节：
 *   * Windows 必须用 `process.env.COMSPEC` 兜底（不能假设 `cmd.exe` 在 PATH）
 *   * macOS GUI 启动的 Electron 里 `process.env.SHELL` 可能不存在（不是 login shell 拉起的）
 *   * Git Bash 探测复用 codex `PP()` 思路（PATH / `Program Files\Git\bin\bash.exe` /
 *     `(dirname git.exe)/../bin/bash.exe`）
 *   * 无 PATH 走子进程的额外依赖 —— 简单 PATH 步进即可，不引 `which` npm 包
 */

import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AvailableShell, ShellId } from '../../shared/terminal-bridge';
export type { AvailableShell, ShellId } from '../../shared/terminal-bridge';

/**
 * 显式按目标平台拼路径——不用 `path.join`（它在 Mac 测试 host 上跑 win32 分支
 * 会用 posix 分隔符，跟真实 Windows 行为对不上，单测会假阴）。生产代码在真实
 * Windows / *nix 上行为完全一致。
 */
function joinForPlatform(dir: string, basename: string): string {
  return process.platform === 'win32'
    ? path.win32.join(dir, basename)
    : path.posix.join(dir, basename);
}

/** 具体到二进制的解析结果，PtyManager spawn 用。 */
export interface ResolvedShell {
  id: Exclude<ShellId, 'auto'>;
  /** 二进制绝对路径。Windows `cmd` 兜底时可能是裸 `cmd.exe`（仍靠 PATH 解析）。 */
  command: string;
  /** 启动参数。Git Bash 必须 `['--login', '-i']` 才会跑 `.bash_profile`；其它通常为空。 */
  args: string[];
  /** UI 显示名（"zsh" / "PowerShell" / "Command Prompt" / "Git Bash"）。 */
  displayName: string;
}

const WIN_PATHEXT_DEFAULT = '.EXE;.CMD;.BAT';
const GIT_BASH_ARGS = ['--login', '-i'];

function windowsEnv(name: string): string | undefined {
  return (
    process.env[name] ??
    Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  );
}

function windowsPathDirs(): string[] {
  return (windowsEnv('PATH') ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function isFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 在 PATH 里找一个可执行文件。Windows 自动按 PATHEXT 追加扩展名（若 bin 已带匹配扩展则不重复追）。
 * 找到返回绝对路径，找不到回 null。不抛错（权限拒绝静默跳过）。
 */
function whichSync(bin: string): string | null {
  if (process.platform === 'win32') {
    const pathext = (windowsEnv('PATHEXT') ?? WIN_PATHEXT_DEFAULT)
      .split(';')
      .map((e) => e.toLowerCase())
      .filter(Boolean);
    const lowerBin = bin.toLowerCase();
    const hasExt = pathext.some((e) => lowerBin.endsWith(e));
    const exts = hasExt ? [''] : ['', ...pathext];
    for (const dir of windowsPathDirs()) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = joinForPlatform(dir, bin + ext);
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        } catch {
          /* 权限拒绝跳过 */
        }
      }
    }
    return null;
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = joinForPlatform(dir, bin);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* 权限拒绝跳过 */
    }
  }
  return null;
}

function findGitBashOnWindows(): string | null {
  // Follow Orca's Git/PortableGit candidate strategy. git-bash.exe is a GUI
  // launcher, never the executable attached to a PTY; use the real bash.exe.
  const candidates = new Set<string>();
  const addRoot = (root: string) => {
    candidates.add(path.win32.join(root, 'bin', 'bash.exe'));
    candidates.add(path.win32.join(root, 'usr', 'bin', 'bash.exe'));
  };
  const launcher = whichSync('git-bash.exe');
  if (launcher) addRoot(path.win32.dirname(launcher));
  const git = whichSync('git.exe');
  if (git) {
    const gitDir = path.win32.dirname(git);
    candidates.add(path.win32.join(gitDir, 'bash.exe'));
    addRoot(path.win32.dirname(gitDir));
  }
  for (const dir of windowsPathDirs()) {
    const direct = path.win32.join(dir, 'bash.exe');
    if (/(?:^|\\)(?:git|portablegit)(?:\\usr)?\\bin\\bash\.exe$/i.test(direct)) {
      candidates.add(direct);
    }
    const base = path.win32.basename(dir).toLowerCase();
    if (base === 'git' || base === 'portablegit') addRoot(dir);
    const parent = path.win32.dirname(dir);
    if (base === 'cmd' && /^(git|portablegit)$/i.test(path.win32.basename(parent))) addRoot(parent);
  }
  for (const envKey of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LocalAppData']) {
    const root = windowsEnv(envKey);
    if (!root) continue;
    addRoot(path.win32.join(root, 'Git'));
    addRoot(path.win32.join(root, 'Programs', 'Git'));
  }
  return [...candidates].find(isFile) ?? null;
}

function resolveAutoDetectShellWin(): ResolvedShell {
  // 优先级: pwsh.exe → powershell.exe → COMSPEC → cmd.exe（兜底，cmd.exe 一定存在）
  const pwsh = whichSync('pwsh.exe');
  if (pwsh) return { id: 'pwsh', command: pwsh, args: [], displayName: 'PowerShell' };

  const powershell = whichSync('powershell.exe');
  if (powershell)
    return {
      id: 'powershell',
      command: powershell,
      args: [],
      displayName: 'Windows PowerShell',
    };

  const cmd = windowsEnv('COMSPEC')?.trim() || 'cmd.exe';
  return { id: 'cmd', command: cmd, args: [], displayName: 'Command Prompt' };
}

function displayNameFromNixBinary(binary: string): string {
  const base = path.basename(binary).toLowerCase();
  const map: Record<string, string> = {
    zsh: 'zsh',
    bash: 'bash',
    fish: 'fish',
    sh: 'sh',
  };
  return map[base] ?? base;
}

function idFromNixBinary(binary: string): Exclude<ShellId, 'auto'> {
  const base = path.basename(binary).toLowerCase();
  if (base === 'zsh') return 'zsh';
  if (base === 'bash') return 'bash';
  if (base === 'fish') return 'fish';
  return 'sh';
}

function resolveAutoDetectShellNix(): ResolvedShell {
  // 1) $SHELL 优先（用户改过 chsh 的就尊重）
  const shellEnv = process.env.SHELL?.trim();
  if (shellEnv) {
    try {
      if (existsSync(shellEnv)) {
        return {
          id: idFromNixBinary(shellEnv),
          command: shellEnv,
          args: [],
          displayName: displayNameFromNixBinary(shellEnv),
        };
      }
    } catch {
      /* skip */
    }
  }

  // 2) /bin/zsh (macOS 10.15+ 默认) → /bin/bash → /bin/sh 兜底
  for (const [bin, id, name] of [
    ['/bin/zsh', 'zsh', 'zsh'],
    ['/bin/bash', 'bash', 'bash'],
    ['/bin/sh', 'sh', 'sh'],
  ] as const) {
    try {
      if (existsSync(bin)) {
        return { id, command: bin, args: [], displayName: name };
      }
    } catch {
      /* skip */
    }
  }

  // 3) 极端 fallback：理论上 /bin/sh 一定存在，到这只是为类型安全。
  return { id: 'sh', command: '/bin/sh', args: [], displayName: 'sh' };
}

/** 不依赖用户偏好的自动检测。永远返回一个 ResolvedShell（兜底链保证不抛错）。 */
export function resolveAutoDetectShell(): ResolvedShell {
  return process.platform === 'win32' ? resolveAutoDetectShellWin() : resolveAutoDetectShellNix();
}

/** 按 id 解析具体 shell。当前机器不可用（卸了 pwsh / 没装 fish 等）返回 null。 */
export function resolveShellById(id: Exclude<ShellId, 'auto'>): ResolvedShell | null {
  if (process.platform === 'win32') {
    switch (id) {
      case 'pwsh': {
        const p = whichSync('pwsh.exe');
        return p ? { id, command: p, args: [], displayName: 'PowerShell' } : null;
      }
      case 'powershell': {
        const p = whichSync('powershell.exe');
        return p ? { id, command: p, args: [], displayName: 'Windows PowerShell' } : null;
      }
      case 'cmd': {
        const p = windowsEnv('COMSPEC')?.trim() || 'cmd.exe';
        return { id, command: p, args: [], displayName: 'Command Prompt' };
      }
      case 'gitbash': {
        const p = findGitBashOnWindows();
        return p ? { id, command: p, args: [...GIT_BASH_ARGS], displayName: 'Git Bash' } : null;
      }
      case 'wsl': {
        const p = whichSync('wsl.exe');
        return p ? { id, command: p, args: [], displayName: 'WSL' } : null;
      }
      default:
        // *nix shell id 在 Windows 上一律不可用
        return null;
    }
  }
  // *nix（darwin / linux）
  switch (id) {
    case 'zsh': {
      const p = whichSync('zsh') ?? '/bin/zsh';
      return existsSync(p) ? { id, command: p, args: [], displayName: 'zsh' } : null;
    }
    case 'bash': {
      const p = whichSync('bash') ?? '/bin/bash';
      return existsSync(p) ? { id, command: p, args: [], displayName: 'bash' } : null;
    }
    case 'fish': {
      const p = whichSync('fish');
      return p ? { id, command: p, args: [], displayName: 'fish' } : null;
    }
    case 'sh': {
      const p = whichSync('sh') ?? '/bin/sh';
      return existsSync(p) ? { id, command: p, args: [], displayName: 'sh' } : null;
    }
    default:
      // win-only shell id 在 *nix 上一律不可用
      return null;
  }
}

/**
 * 业务方唯一入口。
 * - pref = `null` / `undefined` / `'auto'` → auto-detect
 * - pref = 具体 id 但已经不可用（用户卸了对应 shell）→ 回退 auto-detect，不让终端开不起来
 */
export function resolveShellForCreate(pref: ShellId | null | undefined): ResolvedShell {
  if (pref == null || pref === 'auto') return resolveAutoDetectShell();
  return resolveShellById(pref) ?? resolveAutoDetectShell();
}

// ---------- 可用 shell 列表 probe ----------

const NIX_CANDIDATES = ['zsh', 'bash', 'fish', 'sh'] as const;
const WIN_CANDIDATES = ['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl'] as const;

let cachedAvailable: AvailableShell[] | null = null;
let cachedUntil = 0;
let probeInFlight: Promise<AvailableShell[]> | null = null;

function probeWsl(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Like Orca's async capability probe: do not block Main/PTY traffic while
    // an uninitialised Windows WSL stub is starting or timing out.
    execFile(command, ['--status'], { timeout: 5000, windowsHide: true }, (error) =>
      resolve(!error),
    );
  });
}

/**
 * 探测当前机器上所有装了的 shell。结果在进程内存里 memo，避免 Settings 下拉反复打开时
 * 重复走 fs / PATH 步进。用户期间装新 shell 不会自动出现，但重启 app 即重新 probe。
 */
export function probeAvailableShells(): Promise<AvailableShell[]> {
  if (cachedAvailable && Date.now() < cachedUntil) return Promise.resolve(cachedAvailable);
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    const autoTarget = resolveAutoDetectShell().id;
    const candidates = process.platform === 'win32' ? WIN_CANDIDATES : NIX_CANDIDATES;
    const result: AvailableShell[] = [];
    let retryWsl = false;
    for (const id of candidates) {
      const r = resolveShellById(id);
      if (!r) continue;
      if (id === 'wsl' && !(await probeWsl(r.command))) {
        retryWsl = true;
        continue;
      }
      result.push({
        id: r.id,
        command: r.command,
        displayName: r.displayName,
        isAutoDetectTarget: r.id === autoTarget,
      });
    }
    cachedAvailable = result;
    // Failed WSL probes may be transient; reopening after backoff can discover it.
    cachedUntil = retryWsl ? Date.now() + 30_000 : Infinity;
    return result;
  })().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

/** 仅供单测：清缓存让下次 probe 重新走 fs 探测。 */
export function __resetShellProbeCacheForTesting(): void {
  cachedAvailable = null;
  cachedUntil = 0;
  probeInFlight = null;
}
