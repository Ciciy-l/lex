import { describe, expect, it, vi } from 'vitest';

import { logRequiredRuntimeFailure } from '../environment-check-diagnostics.js';

describe('environment check diagnostics', () => {
  it('records stable runtime identity and a safe error token', () => {
    const error = vi.fn();

    logRequiredRuntimeFailure({ error }, {
      kind: 'claude-code',
      platform: 'win32',
      stage: 'not-ready',
      runtimeError: 'asset_missing',
    });

    expect(error).toHaveBeenCalledWith('required startup runtime unavailable', {
      code: 'environment_required_runtime_unavailable',
      kind: 'claude-code',
      platform: 'win32',
      stage: 'not-ready',
      runtimeErrorCode: 'asset_missing',
    });
  });

  it('does not log arbitrary exception text, paths, or URLs', () => {
    const error = vi.fn();
    const sensitive = 'download failed at C:\\Users\\person\\runtime from https://secret.example';

    logRequiredRuntimeFailure({ error }, {
      kind: 'codex',
      platform: 'win32',
      stage: 'exception',
      runtimeError: sensitive,
    });

    expect(JSON.stringify(error.mock.calls)).not.toContain(sensitive);
    expect(error.mock.calls[0]?.[1]).not.toHaveProperty('runtimeErrorCode');
  });
});
