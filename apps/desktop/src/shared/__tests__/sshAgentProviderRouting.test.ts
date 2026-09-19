import { describe, expect, it } from 'vitest';

import { usesControllerProviderProxyForSsh } from '../sshAgentProviderRouting';

describe('SSH agent provider routing', () => {
  it('marks only OMP as using the controller-managed provider proxy', () => {
    expect(usesControllerProviderProxyForSsh('claude-code')).toBe(false);
    expect(usesControllerProviderProxyForSsh('codex')).toBe(false);
    expect(usesControllerProviderProxyForSsh('pi')).toBe(false);
    expect(usesControllerProviderProxyForSsh('omp')).toBe(true);
  });
});
