import { describe, expect, it } from 'vitest';
import {
  createOmpSessionLaunchPlan,
  isOmpCompatibilityBaseline,
  OMP_CONFIG_DIR_NAME,
  OMP_SETTINGS_FILE_NAME,
  parseOmpVersionOutput,
  validateOmpLaunchModel,
} from './launch-plan.js';
import {
  OMP_CINDY_API_KEY_ENV,
  OMP_CINDY_SESSION_ID_ENV,
  OMP_CINDY_SESSION_TOKEN_ENV,
} from './models-config.js';

function plan(
  overrides: Partial<Parameters<typeof createOmpSessionLaunchPlan>[0]> = {},
) {
  return createOmpSessionLaunchPlan({
    roots: { home: '/lex/omp-agent-home', workingDir: '/projects/app', platform: 'linux' },
    permissionMode: 'ask',
    ...overrides,
  });
}

describe('parseOmpVersionOutput', () => {
  it('accepts the pinned v18.1.18 banner and nothing looser', () => {
    expect(parseOmpVersionOutput('omp/18.1.18\n')).toBe('18.1.18');
    expect(parseOmpVersionOutput('omp/18.1.18\r\n')).toBe('18.1.18');
    expect(isOmpCompatibilityBaseline('omp/18.1.18\n')).toBe(true);
    expect(isOmpCompatibilityBaseline('omp/18.1.19\n')).toBe(false);
    expect(parseOmpVersionOutput('omp 18.1.18')).toBeUndefined();
    expect(parseOmpVersionOutput('omp/18.1.18\nnoise')).toBeUndefined();
  });
});

describe('createOmpSessionLaunchPlan', () => {
  it('uses the real working directory instead of a sandbox home', () => {
    const result = plan();
    expect(result.roots.workingDir).toBe('/projects/app');
    expect(result.roots.home).toBe('/lex/omp-agent-home');
    expect(result.roots.workingDir.startsWith(result.roots.home)).toBe(false);
  });

  it('keeps every managed root inside the persistent OMP home', () => {
    const result = plan();
    expect(result.roots.config).toBe(`/lex/omp-agent-home/${OMP_CONFIG_DIR_NAME}`);
    expect(result.roots.agent).toBe('/lex/omp-agent-home/.omp/agent');
    expect(result.roots.sessions).toBe('/lex/omp-agent-home/.omp/agent/sessions');
    expect(result.roots.temporary).toBe('/lex/omp-agent-home/tmp');
    expect(result.roots.settingsFile).toBe(
      `/lex/omp-agent-home/.omp/agent/${OMP_SETTINGS_FILE_NAME}`,
    );
    expect(result.roots.modelsFile).toBe('/lex/omp-agent-home/.omp/agent/models.yml');
    expect(result.roots.globalSkillsDirectory).toBe('/lex/omp-agent-home/.agents/skills');
  });

  it('keeps Lex title ownership while enabling native project capabilities', () => {
    const result = plan();
    expect(result.arguments.slice(0, 4)).toEqual([
      '--mode',
      'rpc',
      '--config',
      result.roots.settingsFile,
    ]);
    expect(result.arguments).not.toContain('--no-session');
    expect(result.arguments).not.toContain('--no-tools');
    expect(result.arguments).toContain('--no-title');
    for (const flag of ['--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty']) {
      expect(result.arguments).not.toContain(flag);
    }
  });

  it('maps each exposed permission tier to the OMP approval mode', () => {
    expect(plan({ permissionMode: 'ask' }).approvalMode).toBe('always-ask');
    expect(plan({ permissionMode: 'auto' }).approvalMode).toBe('write');
    expect(plan({ permissionMode: 'bypassPermissions' }).approvalMode).toBe('yolo');
  });

  it('fails closed to always-ask for unexposed or unknown modes', () => {
    expect(plan({ permissionMode: 'acceptEdits' }).approvalMode).toBe('always-ask');
    expect(plan({ permissionMode: 'default' }).approvalMode).toBe('always-ask');
    expect(plan({ permissionMode: 'plan' }).approvalMode).toBe('always-ask');
    expect(plan({ permissionMode: 'nope' }).approvalMode).toBe('always-ask');
    expect(plan({ permissionMode: undefined }).approvalMode).toBe('always-ask');
  });

  it('double-writes the approval mode into argv and the settings YAML', () => {
    const result = plan({ permissionMode: 'auto' });
    expect(result.arguments).toContain('--approval-mode');
    expect(result.arguments[result.arguments.indexOf('--approval-mode') + 1]).toBe('write');
    expect(result.settingsYaml).toContain('approvalMode: write');
    // 上游默认 yolo,必须显式关掉启动向导 / 更新检查。项目 MCP 配置
    // 则与其他本地引擎一样由原生项目发现路径处理，不在启动计划里封死。
    expect(result.settingsYaml).toContain('setupWizard: false');
    expect(result.settingsYaml).toContain('checkUpdate: false');
    expect(result.settingsYaml).not.toContain('enableProjectConfig: false');
    expect(result.settingsYaml).toContain('- "cindy"');
  });

  it('passes provider and model only when they are present', () => {
    expect(plan().arguments).not.toContain('--provider');
    const result = plan({ model: { provider: 'cindy', model: 'MiniMax-M2' } });
    expect(result.arguments).toContain('--provider');
    expect(result.arguments).toContain('cindy');
    expect(result.arguments).toContain('MiniMax-M2');
  });

  it('keeps the native provider list fixed to the managed Cindy proxy', () => {
    const result = plan({ model: { provider: 'minimax' } });
    expect(result.settingsYaml).not.toContain('minimax');
    expect(result.settingsYaml).toContain('- "cindy"');
  });

  it('never inherits the parent process environment', () => {
    const result = plan();
    expect(Object.keys(result.environment)).not.toContain('PATH');
    expect(result.environment.HOME).toBe('/lex/omp-agent-home');
    expect(result.environment.PI_CONFIG_DIR).toBe(OMP_CONFIG_DIR_NAME);
    expect(result.environment.PI_CODING_AGENT_DIR).toBe('/lex/omp-agent-home/.omp/agent');
  });

  it('adds only the host-approved executable environment values', () => {
    const result = plan({
      executableEnvironment: {
        path: '/usr/local/bin:/usr/bin',
        shell: '/bin/zsh',
        term: 'xterm-256color',
        colorTerm: 'truecolor',
        lang: 'en_US.UTF-8',
        lcCtype: 'en_US.UTF-8',
      },
    });
    expect(result.environment).toMatchObject({
      PATH: '/usr/local/bin:/usr/bin',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    });
    expect(result.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.environment.NODE_OPTIONS).toBeUndefined();
  });

  it('expresses disabled Skills through OMP native extension settings', () => {
    const result = plan({ disabledSkillNames: ['zeta', 'alpha', 'alpha'] });
    expect(result.settingsYaml).toContain('disabledExtensions:');
    expect(result.settingsYaml).toContain('- "skill:alpha"');
    expect(result.settingsYaml).toContain('- "skill:zeta"');
    expect(result.settingsYaml.indexOf('skill:alpha')).toBeLessThan(result.settingsYaml.indexOf('skill:zeta'));
  });

  it('injects credentials only into the child env snapshot', () => {
    const result = plan({
      credentials: { proxyKey: 'placeholder', sessionId: 's-1', sessionToken: 't-1' },
    });
    expect(result.environment[OMP_CINDY_API_KEY_ENV]).toBe('placeholder');
    expect(result.environment[OMP_CINDY_SESSION_ID_ENV]).toBe('s-1');
    expect(result.environment[OMP_CINDY_SESSION_TOKEN_ENV]).toBe('t-1');
    expect(result.settingsYaml).not.toContain('placeholder');
  });

  it('omits credential env entries when no credentials are supplied', () => {
    const result = plan();
    expect(result.environment[OMP_CINDY_API_KEY_ENV]).toBeUndefined();
    expect(result.environment[OMP_CINDY_SESSION_ID_ENV]).toBeUndefined();
  });

  it('requires a Windows system root on win32 and keeps the OS paths', () => {
    expect(() =>
      createOmpSessionLaunchPlan({
        roots: { home: 'C:/lex/omp', workingDir: 'C:/work', platform: 'win32' },
        permissionMode: 'ask',
      }),
    ).toThrow(/system root/);
    const result = createOmpSessionLaunchPlan({
      roots: {
        home: 'C:/lex/omp',
        workingDir: 'C:/work',
        platform: 'win32',
        windowsSystemRoot: 'C:/Windows',
      },
      permissionMode: 'ask',
    });
    expect(result.environment.SystemRoot).toBe('C:\\Windows');
    expect(result.environment.WINDIR).toBe('C:\\Windows');
    expect(result.environment.USERPROFILE).toBe('C:\\lex\\omp');
    expect(result.roots.agent).toBe('C:\\lex\\omp\\.omp\\agent');
  });

  it('opts into --session-dir only when the caller pins a session directory', () => {
    expect(plan().arguments).not.toContain('--session-dir');
    const result = plan({ sessionDir: '/lex/omp-agent-home/.omp/agent/sessions' });
    expect(result.arguments).toContain('--session-dir');
    expect(result.arguments).toContain('/lex/omp-agent-home/.omp/agent/sessions');
  });

  it('rejects non-absolute roots', () => {
    expect(() =>
      createOmpSessionLaunchPlan({
        roots: { home: 'relative', workingDir: '/work', platform: 'linux' },
      }),
    ).toThrow(/home/);
    expect(() =>
      createOmpSessionLaunchPlan({
        roots: { home: '/lex/omp', workingDir: 'relative', platform: 'linux' },
      }),
    ).toThrow(/working directory/);
  });
});

describe('validateOmpLaunchModel', () => {
  it('accepts a partial selector and rejects hostile values', () => {
    expect(validateOmpLaunchModel(undefined)).toBeUndefined();
    expect(validateOmpLaunchModel({ model: 'MiniMax-M2' })).toEqual({ model: 'MiniMax-M2' });
    expect(validateOmpLaunchModel({ provider: 'cindy' })).toEqual({ provider: 'cindy' });
    expect(() => validateOmpLaunchModel({})).toThrow(/launch model/);
    expect(() => validateOmpLaunchModel({ model: '-x' })).toThrow(/model/);
    expect(() => validateOmpLaunchModel({ model: 'a'.repeat(513) })).toThrow(/model/);
    expect(() => validateOmpLaunchModel('x')).toThrow(/launch model/);
  });
});
