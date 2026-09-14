import { describe, expect, it } from 'vitest';
import {
  createOmpSessionLaunchPlan,
  type OmpSessionRoots,
} from './launch-plan.js';

const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);

function roots(overrides: Partial<OmpSessionRoots> = {}): OmpSessionRoots {
  return {
    home: '/lex/omp-agent-home',
    workingDir: '/projects/app',
    platform: 'linux',
    ...overrides,
  };
}

// JSON 往返模拟宿主侧未校验的输入：让 hostile 值以"线上真实形态"进入启动计划。
function build(input: unknown) {
  return createOmpSessionLaunchPlan(JSON.parse(JSON.stringify(input)));
}

describe('createOmpSessionLaunchPlan adversarial input', () => {
  it('rejects non-object input of every shape', () => {
    for (const value of [null, 0, 'x', [], true]) {
      expect(() => build(value)).toThrow(/launch input|roots/);
    }
  });

  it('rejects hostile roots', () => {
    expect(() => build({ roots: null })).toThrow(/roots/);
    expect(() => build({ roots: [] })).toThrow(/roots/);
    expect(() => build({ roots: { ...roots(), home: `/lex/${NUL}` } })).toThrow(/home/);
    expect(() => build({ roots: { ...roots(), home: '' } })).toThrow(/home/);
    expect(() => build({ roots: { ...roots(), home: '/' } })).toThrow(/home/);
    expect(() => build({ roots: { ...roots(), workingDir: `/work${NUL}` } })).toThrow(
      /working directory/,
    );
    expect(() => build({ roots: { ...roots(), platform: 'haiku' } })).toThrow(
      /Unsupported OMP platform/,
    );
  });

  it('rejects credentials carrying control characters', () => {
    expect(() =>
      build({ roots: roots(), credentials: { proxyKey: `key${LF}` } }),
    ).toThrow(/proxy key/);
    expect(() =>
      build({ roots: roots(), credentials: { sessionToken: 'x'.repeat(4097) } }),
    ).toThrow(/session token/);
    expect(() => build({ roots: roots(), credentials: [] })).toThrow(/credentials/);
  });

  it('rejects model selectors that could smuggle extra flags', () => {
    expect(() => build({ roots: roots(), model: { model: '--mode' } })).toThrow(/model/);
    expect(() => build({ roots: roots(), model: { provider: 'cindy', model: NUL } })).toThrow(
      /model/,
    );
    expect(() => build({ roots: roots(), model: null })).toThrow(/launch model/);
  });

  it('rejects a session directory that is a filesystem root', () => {
    expect(() => build({ roots: roots(), sessionDir: '/' })).toThrow(/session directory/);
    expect(() => build({ roots: roots(), sessionDir: '' })).toThrow(/session directory/);
  });

  it('never leaks the ambient environment into the child snapshot', () => {
    const plan = createOmpSessionLaunchPlan({ roots: roots(), permissionMode: 'ask' });
    const keys = Object.keys(plan.environment);
    expect(keys).not.toContain('PATH');
    expect(keys).not.toContain('ANTHROPIC_API_KEY');
    expect(keys).not.toContain('OPENAI_API_KEY');
    for (const [, value] of Object.entries(plan.environment)) {
      expect(value.includes(NUL)).toBe(false);
      expect(value.includes(LF)).toBe(false);
    }
  });

  it('keeps argv free of NUL bytes and unvalidated paths', () => {
    const plan = createOmpSessionLaunchPlan({
      roots: roots(),
      permissionMode: 'bypassPermissions',
      model: { provider: 'cindy', model: 'MiniMax-M2' },
    });
    for (const argument of plan.arguments) expect(argument.includes(NUL)).toBe(false);
    expect(plan.arguments).toContain('yolo');
    expect(plan.arguments.filter((argument) => argument === '--mode').length).toBe(1);
  });
});
