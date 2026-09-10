import { describe, expect, it } from 'vitest';

import { resolveGitWorkspaceView } from '../gitWorkspaceView';

describe('resolveGitWorkspaceView', () => {
  it.each([null, undefined, 'corrupt', [], 0])(
    'uses Graph for a new or invalid raw state %#',
    (raw) => {
      expect(resolveGitWorkspaceView(raw)).toBe('graph');
    },
  );

  it('keeps legacy object state in Review and honors both accepted persisted view fields', () => {
    expect(resolveGitWorkspaceView({})).toBe('review');
    expect(resolveGitWorkspaceView({ activeView: 'graph' })).toBe('graph');
    expect(resolveGitWorkspaceView({ activeView: 'review' })).toBe('review');
    expect(resolveGitWorkspaceView({ view: 'graph' })).toBe('graph');
  });
});
