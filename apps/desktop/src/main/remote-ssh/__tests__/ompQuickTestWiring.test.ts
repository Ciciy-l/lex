import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('remote SSH OMP quick-test wiring', () => {
  it('routes OMP through the managed runtime instead of the generic shell one-shot', () => {
    const ompBranchStart = source.indexOf("if (agentKind === 'omp') {");
    const genericCommandStart = source.indexOf('const cmd = oneShotCommand(agentKind, probe.binaryPath, envBlock != null);');
    expect(ompBranchStart).toBeGreaterThan(-1);
    expect(genericCommandStart).toBeGreaterThan(ompBranchStart);
    const ompBranch = source.slice(ompBranchStart, genericCommandStart);

    expect(ompBranch).toContain('runManagedRemoteOmpQuickTest({');
    expect(ompBranch).not.toContain("statRemotePath(host, '~')");
    expect(ompBranch).not.toContain('workingDir: remoteHome.resolvedPath');
    expect(ompBranch).toContain('SSH_AGENT_NOT_INSTALLED');
    expect(ompBranch).not.toContain('oneShotCommand(');
  });
});
