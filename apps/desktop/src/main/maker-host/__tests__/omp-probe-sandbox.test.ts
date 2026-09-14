import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOmpProbeSandbox } from '../omp-probe-sandbox.js';

const temporaryParents: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryParents.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lex-omp-probe-test-'));
  temporaryParents.push(temporaryRoot);
  return { temporaryRoot };
}

describe('OMP isolated probe sandbox', () => {
  it('uses a unique system-temp child and materializes only controlled roots', async () => {
    const { temporaryRoot } = await fixture();
    const sandbox = await createOmpProbeSandbox({ temporaryRoot });
    const { plan } = sandbox;

    expect(plan.roots.sandboxRoot.startsWith(temporaryRoot + path.sep)).toBe(true);
    await expect(readFile(plan.roots.settingsFile, 'utf8')).resolves.toBe(plan.settingsYaml);
    await Promise.all(
      [
        plan.roots.home,
        plan.roots.config,
        plan.roots.agent,
        plan.roots.workingDirectory,
        plan.roots.temporary,
        plan.environment.XDG_CONFIG_HOME,
        plan.environment.XDG_DATA_HOME,
        plan.environment.XDG_STATE_HOME,
        plan.environment.XDG_CACHE_HOME,
      ].map(async (directory) => expect((await stat(directory)).isDirectory()).toBe(true)),
    );
    expect(plan.environment.HOME).toBe(plan.roots.home);
    expect(plan.environment.PI_CONFIG_DIR).toBe('.omp');
    expect(plan.environment.PI_CODING_AGENT_DIR).toBe(plan.roots.agent);
    expect(path.dirname(plan.roots.workingDirectory)).toBe(plan.roots.home);
    expect(plan.environment).not.toHaveProperty('PATH');
    expect(plan.environment).not.toHaveProperty('PI_CONFIG_FILES');

    await sandbox.dispose();
    await sandbox.dispose();
    await expect(access(plan.roots.sandboxRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(temporaryRoot)).resolves.toBeDefined();
  });

  it('does not treat a relative or missing host directory as an isolation root', async () => {
    await expect(createOmpProbeSandbox({ temporaryRoot: 'relative-temp-root' })).rejects.toThrow(
      'absolute host temporary directory',
    );
    const missing = path.join(os.tmpdir(), `lex-omp-probe-missing-${Date.now()}`);
    await expect(createOmpProbeSandbox({ temporaryRoot: missing })).rejects.toThrow();
  });
});
