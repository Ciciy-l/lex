import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OMP_PROBE_CONFIG_DIR_NAME,
  OMP_PROBE_SETTINGS_FILE,
  createOmpIsolatedProbeLaunchPlan,
  isOmpCompatibilityBaseline,
  parseOmpVersionOutput,
} from './launch-plan.js';

function expectInside(root: string, candidate: string, implementation: typeof path): void {
  const relative = implementation.relative(root, candidate);
  expect(relative).not.toBe('');
  expect(relative.startsWith('..')).toBe(false);
  expect(implementation.isAbsolute(relative)).toBe(false);
}

function roots(sandboxRoot: string) {
  return process.platform === 'win32'
    ? { sandboxRoot, windowsSystemRoot: 'C:\\Windows' }
    : { sandboxRoot };
}

describe('OMP isolated probe launch plan', () => {
  it('accepts only the fixed-tag version wire shape and compatibility baseline', () => {
    expect(parseOmpVersionOutput('omp/18.1.18\n')).toBe('18.1.18');
    expect(parseOmpVersionOutput('omp/18.1.18\r\n')).toBe('18.1.18');
    expect(isOmpCompatibilityBaseline('omp/18.1.18\n')).toBe(true);
    expect(isOmpCompatibilityBaseline('omp/18.1.19\n')).toBe(false);
    expect(parseOmpVersionOutput('v18.1.18\n')).toBeUndefined();
    expect(parseOmpVersionOutput('omp/18.1.18\nwarning\n')).toBeUndefined();
    expect(parseOmpVersionOutput('omp/18.1.18')).toBeUndefined();
  });

  it('uses fresh roots and a non-inherited environment for a no-prompt probe', () => {
    const root = process.platform === 'win32' ? 'C:\\sandbox\\omp-123' : '/sandbox/omp-123';
    const plan = createOmpIsolatedProbeLaunchPlan(roots(root));
    const implementation = process.platform === 'win32' ? path.win32 : path.posix;
    const resolved = implementation.resolve(root);

    expect(plan.roots.sandboxRoot).toBe(resolved);
    for (const value of Object.values(plan.roots).filter(
      (entry) => entry !== plan.roots.sandboxRoot,
    ))
      expectInside(resolved, value, implementation);
    expect(plan.roots.settingsFile).toBe(implementation.join(resolved, OMP_PROBE_SETTINGS_FILE));
    expect(plan.environment).toMatchObject({
      HOME: plan.roots.home,
      PI_CONFIG_DIR: OMP_PROBE_CONFIG_DIR_NAME,
      PI_CODING_AGENT_DIR: plan.roots.agent,
      TMPDIR: plan.roots.temporary,
      TMP: plan.roots.temporary,
      TEMP: plan.roots.temporary,
    });
    expect(plan.environment).not.toHaveProperty('PATH');
    expect(plan.environment).not.toHaveProperty('PI_CONFIG_FILES');
    expect(plan.environment).not.toHaveProperty('PI_PROFILE');
    expect(plan.environment).not.toHaveProperty('OMP_PROFILE');
    expect(plan.roots.config).toBe(implementation.join(plan.roots.home, OMP_PROBE_CONFIG_DIR_NAME));
    // v18.1.18 stops its project-plugin ancestor walk at HOME. Starting the
    // probe below that fresh directory must keep the walk out of the parent
    // system temp directory, where a host-side project registry could exist.
    expect(plan.roots.workingDirectory).toBe(implementation.join(plan.roots.home, 'workdir'));
    expectInside(plan.roots.home, plan.roots.workingDirectory, implementation);
    expect(plan.arguments).toEqual([
      '--mode',
      'rpc',
      '--config',
      plan.roots.settingsFile,
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--no-pty',
      '--no-title',
      '--approval-mode',
      'always-ask',
    ]);
    expect(plan.settingsYaml).toBe(
      'startup:\n' +
        '  setupWizard: false\n' +
        '  checkUpdate: false\n' +
        'mcp:\n' +
        '  enableProjectConfig: false\n' +
        'tools:\n' +
        '  approvalMode: always-ask\n' +
        'enabledProviders: []\n',
    );
  });

  it('adds only validated explicit model selection', () => {
    const root = process.platform === 'win32' ? 'C:\\sandbox\\omp-123' : '/sandbox/omp-123';
    const plan = createOmpIsolatedProbeLaunchPlan(roots(root), {
      provider: 'example-provider',
      model: 'example-model',
    });

    expect(plan.arguments.slice(-4)).toEqual([
      '--provider',
      'example-provider',
      '--model',
      'example-model',
    ]);
    expect(() =>
      createOmpIsolatedProbeLaunchPlan(roots(root), {
        provider: '--yolo',
        model: 'example-model',
      }),
    ).toThrow('Invalid OMP probe provider');
    expect(() =>
      createOmpIsolatedProbeLaunchPlan(roots(root), {
        provider: 'example-provider',
        model: '\0',
      }),
    ).toThrow('Invalid OMP probe model');
  });

  it('constructs Windows-only home and app-data redirects without parent env values', () => {
    const plan = createOmpIsolatedProbeLaunchPlan({
      sandboxRoot: 'C:\\sandbox\\omp-123',
      platform: 'win32',
      windowsSystemRoot: 'C:\\Windows',
    });

    expect(plan.environment).toMatchObject({
      HOME: 'C:\\sandbox\\omp-123\\home',
      USERPROFILE: 'C:\\sandbox\\omp-123\\home',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\sandbox\\omp-123\\home',
      APPDATA: 'C:\\sandbox\\omp-123\\appdata',
      LOCALAPPDATA: 'C:\\sandbox\\omp-123\\localappdata',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    });
    expect(plan.environment).not.toHaveProperty('APPDATA', process.env.APPDATA);
  });

  it.each(['', '\0', process.platform === 'win32' ? 'C:\\' : '/'])(
    'rejects an unsafe sandbox root %j',
    (sandboxRoot) => {
      expect(() => createOmpIsolatedProbeLaunchPlan(roots(sandboxRoot))).toThrow();
    },
  );

  it('returns immutable snapshots so later callers cannot add unsafe flags or env', () => {
    const root = process.platform === 'win32' ? 'C:\\sandbox\\omp-123' : '/sandbox/omp-123';
    const plan = createOmpIsolatedProbeLaunchPlan(roots(root));

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.roots)).toBe(true);
    expect(Object.isFrozen(plan.arguments)).toBe(true);
    expect(Object.isFrozen(plan.environment)).toBe(true);
    expect(() => (plan.arguments as string[]).push('--yolo')).toThrow();
  });

  it('requires an explicit host system root for Windows', () => {
    expect(() =>
      createOmpIsolatedProbeLaunchPlan({
        sandboxRoot: 'C:\\sandbox\\omp-123',
        platform: 'win32',
      }),
    ).toThrow('valid Windows system root');
    expect(() =>
      createOmpIsolatedProbeLaunchPlan({
        sandboxRoot: 'C:\\sandbox\\omp-123',
        platform: 'win32',
        windowsSystemRoot: 'relative',
      }),
    ).toThrow('valid Windows system root');
  });
});
