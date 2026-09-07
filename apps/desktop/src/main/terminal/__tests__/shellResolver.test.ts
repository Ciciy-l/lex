/**
 * shellResolver 单测 —— mock process.platform / env / fs.existsSync 覆盖：
 *   1. macOS：$SHELL 有效 / $SHELL 缺失走 /bin/zsh / 全部缺只剩 /bin/sh
 *   2. Linux：$SHELL = /bin/bash 命中
 *   3. Windows：pwsh > powershell > COMSPEC > cmd.exe 优先级
 *   4. resolveShellById：当前平台不可用回 null（卸了 pwsh、Windows 上选 zsh 等）
 *   5. resolveShellForCreate：pref 不可用回退 auto
 *   6. probeAvailableShells：进程级 memo 命中
 *   7. Git Bash：从 Program Files\Git\bin\bash.exe 探测
 *
 * 没有用真 fs / 真 PATH，全部依赖 vi.mock，避免开发机本地装了什么 shell 干扰结果。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';

// Mock fs 必须在 shellResolver 被加载之前；用 vi.hoisted 拿一个共享的 fixture handle。
const fixture = vi.hoisted(() => ({
  existing: new Set<string>(),
  files: new Set<string>(),
}));

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

vi.mock('node:fs', () => {
  return {
    existsSync: (p: string) => fixture.existing.has(p),
    statSync: (p: string) => {
      if (fixture.files.has(p)) return { isFile: () => true } as { isFile: () => boolean };
      return { isFile: () => false } as { isFile: () => boolean };
    },
  };
});

// 导入必须在 vi.mock 之后。
import {
  __resetShellProbeCacheForTesting,
  probeAvailableShells,
  resolveAutoDetectShell,
  resolveShellById,
  resolveShellForCreate,
} from '../shellResolver';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setExistingFiles(paths: string[]): void {
  fixture.existing.clear();
  fixture.files.clear();
  for (const p of paths) {
    fixture.existing.add(p);
    fixture.files.add(p);
  }
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  __resetShellProbeCacheForTesting();
  // 清干净，每个 case 自己组装需要的 env
  for (const k of Object.keys(process.env)) delete process.env[k];
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  setExistingFiles([]);
});

describe('resolveAutoDetectShell — macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  it('$SHELL = /bin/zsh 时 auto 命中 zsh', () => {
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh', '/bin/bash', '/bin/sh']);
    expect(resolveAutoDetectShell()).toEqual({
      id: 'zsh',
      command: '/bin/zsh',
      args: [],
      displayName: 'zsh',
    });
  });

  it('$SHELL 缺失但 /bin/zsh 存在 → fallback 到 /bin/zsh', () => {
    setExistingFiles(['/bin/zsh', '/bin/bash', '/bin/sh']);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'zsh', command: '/bin/zsh' });
  });

  it('$SHELL 指向不存在的二进制 → fallback 链', () => {
    process.env.SHELL = '/opt/homebrew/bin/zsh'; // 用户改过但二进制被删了
    setExistingFiles(['/bin/bash', '/bin/sh']); // 只剩 bash 和 sh
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'bash', command: '/bin/bash' });
  });

  it('全都没有只剩 /bin/sh', () => {
    setExistingFiles(['/bin/sh']);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'sh', command: '/bin/sh' });
  });

  it('$SHELL 是 /opt/homebrew/bin/fish 且存在', () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    setExistingFiles(['/opt/homebrew/bin/fish']);
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'fish',
      command: '/opt/homebrew/bin/fish',
      displayName: 'fish',
    });
  });
});

describe('resolveAutoDetectShell — Linux', () => {
  beforeEach(() => setPlatform('linux'));

  it('$SHELL = /bin/bash', () => {
    process.env.SHELL = '/bin/bash';
    setExistingFiles(['/bin/bash', '/bin/sh']);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'bash', command: '/bin/bash' });
  });
});

describe('resolveAutoDetectShell — Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('PATH 里有 pwsh.exe 优先', () => {
    process.env.PATH = 'C:\\Program Files\\PowerShell\\7';
    process.env.PATHEXT = '.EXE;.CMD';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    setExistingFiles(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']);
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'pwsh',
      displayName: 'PowerShell',
    });
  });

  it('没 pwsh 但有 powershell.exe', () => {
    process.env.PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    process.env.PATHEXT = '.EXE';
    setExistingFiles(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'powershell',
      displayName: 'Windows PowerShell',
    });
  });

  it('两者都没 fallback COMSPEC', () => {
    process.env.PATH = 'C:\\Windows';
    process.env.PATHEXT = '.EXE';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    setExistingFiles([]); // 啥都不在
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'cmd',
      command: 'C:\\Windows\\System32\\cmd.exe',
    });
  });

  it('COMSPEC 也没 → 兜底裸 cmd.exe', () => {
    process.env.PATH = '';
    setExistingFiles([]);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'cmd', command: 'cmd.exe' });
  });
});

describe('resolveShellById', () => {
  it('macOS 选 pwsh → null（跨平台 id 不允许）', () => {
    setPlatform('darwin');
    setExistingFiles(['/bin/zsh']);
    expect(resolveShellById('pwsh')).toBeNull();
  });

  it('Windows 选 zsh → null', () => {
    setPlatform('win32');
    process.env.PATH = '';
    expect(resolveShellById('zsh')).toBeNull();
  });

  it('macOS 选 fish 但没装 → null', () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/usr/local/bin';
    setExistingFiles([]);
    expect(resolveShellById('fish')).toBeNull();
  });

  it('Windows Git Bash 探测命中 Program Files\\Git\\bin\\bash.exe', () => {
    setPlatform('win32');
    process.env.PATH = '';
    process.env.PATHEXT = '.EXE';
    process.env.ProgramFiles = 'C:\\Program Files';
    setExistingFiles(['C:\\Program Files\\Git\\bin\\bash.exe']);
    expect(resolveShellById('gitbash')).toMatchObject({
      id: 'gitbash',
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      displayName: 'Git Bash',
    });
  });
});

describe('resolveShellForCreate', () => {
  it('pref 为 auto 走 auto-detect', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    expect(resolveShellForCreate('auto')).toMatchObject({ id: 'zsh' });
  });

  it('pref 为 null 也走 auto-detect', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    expect(resolveShellForCreate(null)).toMatchObject({ id: 'zsh' });
  });

  it('pref 是具体 id 但当前机器没装 → 回退 auto-detect', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']); // 没 fish
    // 用户偏好 fish，但卸了 —— 不应该让终端开不起来
    expect(resolveShellForCreate('fish')).toMatchObject({ id: 'zsh' });
  });

  it('pref 是具体可用 id → 走它', () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/bin';
    setExistingFiles(['/bin/bash']);
    expect(resolveShellForCreate('bash')).toMatchObject({ id: 'bash', command: '/bin/bash' });
  });
});

describe('probeAvailableShells', () => {
  it('macOS：列出装了的 shell + 标注 auto target', async () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh', '/bin/bash', '/bin/sh']); // 没 fish
    const list = await probeAvailableShells();
    expect(list.map((s) => s.id)).toEqual(['zsh', 'bash', 'sh']);
    expect(list.find((s) => s.id === 'zsh')?.isAutoDetectTarget).toBe(true);
    expect(list.find((s) => s.id === 'bash')?.isAutoDetectTarget).toBe(false);
  });

  it('memo：第二次调用不重新走 fs（改文件集合也不变结果）', async () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    const first = await probeAvailableShells();
    setExistingFiles(['/bin/zsh', '/bin/bash']); // 模拟用户后装了 bash
    const second = await probeAvailableShells();
    expect(second).toBe(first); // 同引用
  });

  it('__resetShellProbeCacheForTesting 后重新探测', async () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    await probeAvailableShells();
    setExistingFiles(['/bin/zsh', '/bin/bash']);
    __resetShellProbeCacheForTesting();
    const list = await probeAvailableShells();
    expect(list.map((s) => s.id)).toEqual(['zsh', 'bash']);
  });

  it('Windows：只列当前装了的子集', async () => {
    setPlatform('win32');
    process.env.PATH = 'C:\\Windows\\System32';
    process.env.PATHEXT = '.EXE';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ProgramFiles = 'C:\\Program Files';
    setExistingFiles([
      'C:\\Windows\\System32\\powershell.exe', // 有
      'C:\\Program Files\\Git\\bin\\bash.exe', // 有
      // 没 pwsh，没 wsl
    ]);
    const list = await probeAvailableShells();
    expect(list.map((s) => s.id).sort()).toEqual(['cmd', 'gitbash', 'powershell'].sort());
  });

  it.each([false, true])('only lists functional WSL, available=%s', async (available) => {
    setPlatform('win32');
    process.env.PATH = 'C:\\Windows\\System32';
    setExistingFiles(['C:\\Windows\\System32\\wsl.exe']);
    const pending = probeAvailableShells();
    expect(probeAvailableShells()).toBe(pending);
    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\wsl.exe',
      ['--status'],
      { timeout: 5000, windowsHide: true },
      expect.any(Function),
    );
    const callback = vi.mocked(execFile).mock.calls[0][3] as (error: Error | null) => void;
    callback(available ? null : new Error('WSL is not installed'));
    expect((await pending).some((s) => s.id === 'wsl')).toBe(available);
    await probeAvailableShells();
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

describe('Git Bash PATH candidates', () => {
  beforeEach(() => setPlatform('win32'));

  it('resolves the real bash next to a GUI launcher on another drive', () => {
    process.env.Path = '"D:\\Tools\\Git"';
    setExistingFiles(['D:\\Tools\\Git\\git-bash.exe', 'D:\\Tools\\Git\\bin\\bash.exe']);
    expect(resolveShellById('gitbash')?.command).toBe('D:\\Tools\\Git\\bin\\bash.exe');
  });

  it('never returns the git-bash.exe GUI wrapper or the Windows bash stub', () => {
    process.env.PATH = 'D:\\Tools\\Git;C:\\Windows\\System32';
    setExistingFiles(['D:\\Tools\\Git\\git-bash.exe', 'C:\\Windows\\System32\\bash.exe']);
    expect(resolveShellById('gitbash')).toBeNull();
  });

  it.each(['cmd', 'usr\\bin'])('discovers PortableGit from its %s PATH entry', (segment) => {
    process.env.Path = 'E:\\PortableGit\\' + segment;
    setExistingFiles(['E:\\PortableGit\\usr\\bin\\bash.exe']);
    expect(resolveShellById('gitbash')?.command).toBe('E:\\PortableGit\\usr\\bin\\bash.exe');
  });

  it('accepts uppercase LOCALAPPDATA and a per-user Git install', () => {
    process.env.LOCALAPPDATA = 'D:\\User\\AppData\\Local';
    setExistingFiles(['D:\\User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe']);
    expect(resolveShellById('gitbash')?.command).toBe(
      'D:\\User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    );
  });
});
