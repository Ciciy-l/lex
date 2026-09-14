import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOmpIsolatedProbeLaunchPlan,
  isOmpCompatibilityBaseline,
  parseOmpVersionOutput,
} from './launch-plan.js';

const isWin = process.platform === 'win32';
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

function probeRoot(root: string, overrides: Record<string, unknown> = {}) {
  return {
    sandboxRoot: root,
    ...(isWin ? { windowsSystemRoot: 'C:\\Windows' } : {}),
    ...overrides,
  };
}

const VERSION_OUTPUT_LF = 'omp/18.1.18' + LF;
const VERSION_OUTPUT_CRLF = 'omp/18.1.18' + CRLF;
const VERSION_OUTPUT_RC = 'omp/18.1.18-rc.1' + LF;
const VERSION_OUTPUT_META = 'omp/18.1.18+meta' + LF;

describe('OMP isolated probe launch plan adversarial', () => {
  it('rejects sandbox roots that are filesystem roots or contain NUL', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const implementation = platform === 'win32' ? path.win32 : path.posix;
      const rootDir = implementation.parse(implementation.sep).root;
      const platformInput = { sandboxRoot: rootDir, platform } as never;
      expect(() => createOmpIsolatedProbeLaunchPlan(platformInput)).toThrow(
        /absolute non-root directory/,
      );
    }
    for (const bad of ['', 'safe' + NUL + 'null']) {
      expect(() => createOmpIsolatedProbeLaunchPlan(probeRoot(bad) as never)).toThrow();
    }
  });
  it('normalises an absolute but non-canonical root without leaking the parent', () => {
    const root = isWin ? 'C:\\sandbox\\..\\sandbox\\omp-1' : '/sandbox/../sandbox/omp-1';
    const plan = createOmpIsolatedProbeLaunchPlan(probeRoot(root));
    const implementation = isWin ? path.win32 : path.posix;
    expect(plan.roots.sandboxRoot).toBe(implementation.resolve(implementation.resolve(root)));
    for (const value of Object.values(plan.roots)) {
      if (value === plan.roots.sandboxRoot) continue;
      const relative = implementation.relative(plan.roots.sandboxRoot, value);
      expect(relative).not.toBe('');
      expect(relative.startsWith('..')).toBe(false);
      expect(implementation.isAbsolute(relative)).toBe(false);
    }
  });
  it('rejects model fields with leading dash, NUL, empty, or >512 chars', () => {
    const probe = probeRoot(isWin ? 'C:\\sandbox\\omp-1' : '/sandbox/omp-1');
    for (const bad of ['--yolo', '-x', 'a' + NUL + 'b', '']) {
      expect(() =>
        createOmpIsolatedProbeLaunchPlan(probe, { provider: bad, model: 'ok' } as never),
      ).toThrow(/Invalid OMP probe provider/);
      expect(() =>
        createOmpIsolatedProbeLaunchPlan(probe, { provider: 'ok', model: bad } as never),
      ).toThrow(/Invalid OMP probe model/);
    }
    expect(() =>
      createOmpIsolatedProbeLaunchPlan(probe, {
        provider: 'ok',
        model: 'x'.repeat(513),
      } as never),
    ).toThrow(/Invalid OMP probe model/);
    expect(() =>
      createOmpIsolatedProbeLaunchPlan(probe, {
        provider: 'x'.repeat(513),
        model: 'ok',
      } as never),
    ).toThrow(/Invalid OMP probe provider/);
  });
  it('rejects unsupported platforms and non-object input', () => {
    expect(() =>
      createOmpIsolatedProbeLaunchPlan(probeRoot('/x', { platform: 'freebsd' as never })),
    ).toThrow(/Unsupported OMP platform/);
    expect(() => createOmpIsolatedProbeLaunchPlan(null as never)).toThrow();
    expect(() => createOmpIsolatedProbeLaunchPlan([] as never)).toThrow();
  });
  it('Windows plan uses host-supplied SystemRoot verbatim and never inherits parent env', () => {
    const plan = createOmpIsolatedProbeLaunchPlan({
      sandboxRoot: 'C:\\sandbox\\omp-1',
      platform: 'win32',
      windowsSystemRoot: 'D:\\Tools\\Win',
    });
    expect(plan.environment.SystemRoot).toBe('D:\\Tools\\Win');
    expect(plan.environment.WINDIR).toBe('D:\\Tools\\Win');
    expect(plan.environment).not.toHaveProperty('PATH');
    if (process.env.APPDATA) {
      expect(plan.environment).not.toHaveProperty('APPDATA', process.env.APPDATA);
    }
    expect(plan.environment.USERPROFILE).toBe(plan.roots.home);
    expect(plan.environment.HOMEDRIVE.startsWith(plan.roots.home.charAt(0))).toBe(true);
    expect(plan.environment.HOMEPATH.endsWith('home')).toBe(true);
  });
  it('rejects an explicit but invalid Windows system root', () => {
    for (const bad of ['', NUL, 'relative-root', 'x'.repeat(5000)]) {
      expect(() =>
        createOmpIsolatedProbeLaunchPlan({
          sandboxRoot: 'C:\\sandbox\\omp-1',
          platform: 'win32',
          windowsSystemRoot: bad,
        }),
      ).toThrow(/valid Windows system root/);
    }
  });
  it('Windows probe arguments set rpc mode and disable every prompt-touching surface', () => {
    const plan = createOmpIsolatedProbeLaunchPlan({
      sandboxRoot: 'C:\\sandbox\\omp-1',
      platform: 'win32',
      windowsSystemRoot: 'C:\\Windows',
    });
    expect(plan.arguments).toContain('--mode');
    expect(plan.arguments).toContain('rpc');
    expect(plan.arguments).toContain('--no-tools');
    expect(plan.arguments).toContain('--no-extensions');
    expect(plan.arguments).toContain('--no-skills');
    expect(plan.arguments).toContain('--no-rules');
    expect(plan.arguments).toContain('--no-lsp');
    expect(plan.arguments).toContain('--no-pty');
    expect(plan.arguments).toContain('--no-title');
    expect(plan.arguments).toContain('--approval-mode');
    expect(plan.arguments).toContain('always-ask');
    expect(new Set(plan.arguments).has('--yolo')).toBe(false);
    expect(plan.environment).not.toHaveProperty('PATH');
    expect(plan.environment).not.toHaveProperty('PI_CONFIG_FILES');
    expect(plan.environment).not.toHaveProperty('PI_PROFILE');
    expect(plan.environment).not.toHaveProperty('OMP_PROFILE');
  });
  it('settings YAML never embeds env values, real secrets, or provider lists', () => {
    const plan = createOmpIsolatedProbeLaunchPlan(
      probeRoot(isWin ? 'C:\\sandbox\\omp-1' : '/sandbox/omp-1'),
    );
    expect(plan.settingsYaml).not.toMatch(/process\\.env/);
    expect(plan.settingsYaml).not.toMatch(/API_KEY/);
    expect(plan.settingsYaml).toContain('setupWizard: false');
    expect(plan.settingsYaml).toContain('checkUpdate: false');
    expect(plan.settingsYaml).toContain('enableProjectConfig: false');
    expect(plan.settingsYaml).toContain('approvalMode: always-ask');
    expect(plan.settingsYaml).toContain('enabledProviders: []');
  });
  it('parseOmpVersionOutput only accepts the documented wire shape', () => {
    expect(parseOmpVersionOutput(VERSION_OUTPUT_LF)).toBe('18.1.18');
    expect(parseOmpVersionOutput(VERSION_OUTPUT_CRLF)).toBe('18.1.18');
    expect(parseOmpVersionOutput(VERSION_OUTPUT_RC)).toBe('18.1.18-rc.1');
    expect(parseOmpVersionOutput(VERSION_OUTPUT_META)).toBe('18.1.18+meta');
    expect(isOmpCompatibilityBaseline(VERSION_OUTPUT_LF)).toBe(true);
    expect(isOmpCompatibilityBaseline(VERSION_OUTPUT_RC)).toBe(false);
    const OMP_CAPS_LF = 'OMP/18.1.18' + LF;
    const OMP_BARE = 'omp/18.1.18';
    const OMP_TRAILING_SPACE = 'omp/18.1.18 ' + LF;
    const OMP_TRAILING_TEXT = 'omp/18.1.18' + LF + 'extra';
    const OMP_TOO_MANY = 'omp/18.1.18.0' + LF;
    for (const bad of [
      OMP_CAPS_LF,
      OMP_BARE,
      OMP_TRAILING_SPACE,
      OMP_TRAILING_TEXT,
      OMP_TOO_MANY,
      '',
      'x'.repeat(300),
      null as unknown as string,
      undefined as unknown as string,
      42 as unknown as string,
    ]) {
      expect(parseOmpVersionOutput(bad)).toBeUndefined();
    }
  });
  it('Windows HOME split reassembles into the sandboxed home path', () => {
    const plan = createOmpIsolatedProbeLaunchPlan({
      sandboxRoot: 'C:\\sandbox\\omp-1',
      platform: 'win32',
      windowsSystemRoot: 'C:\\Windows',
    });
    const drive = plan.environment.HOMEDRIVE;
    const pathSuffix = plan.environment.HOMEPATH;
    expect(drive).toBe('C:');
    expect(pathSuffix.startsWith('\\')).toBe(true);
    expect(`${drive}${pathSuffix}`).toBe(plan.environment.HOME);
    expect(plan.environment.HOME.startsWith('C:\\sandbox\\omp-1\\home')).toBe(true);
  });
  it('never returns a plan that escapes the sandbox root after path normalisation', () => {
    for (const root of [
      isWin ? 'C:\\sandbox\\.\\omp-1' : '/sandbox/./omp-1',
      isWin ? 'C:\\sandbox\\a\\..\\b\\omp-2' : '/sandbox/a/../b/omp-2',
      isWin ? 'C:\\sandbox\\omp-3\\.' : '/sandbox/omp-3/.',
    ]) {
      const plan = createOmpIsolatedProbeLaunchPlan(probeRoot(root));
      const implementation = isWin ? path.win32 : path.posix;
      for (const [name, value] of Object.entries(plan.roots)) {
        if (name === 'sandboxRoot') continue;
        const rel = implementation.relative(plan.roots.sandboxRoot, value);
        expect(rel.startsWith('..')).toBe(false);
        expect(implementation.isAbsolute(rel)).toBe(false);
        expect(rel).not.toBe('');
      }
      expect(plan.roots.home).toContain('home');
      expect(plan.roots.workingDirectory).toContain('workdir');
      expect(plan.roots.temporary).toContain('tmp');
    }
  });
});
