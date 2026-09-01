import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCachedBinaryStatus: vi.fn(),
  isVettedAgentBinaryPath: vi.fn(),
}));

vi.mock('../../agent-binaries/index.js', () => ({
  getCachedBinaryStatus: mocks.getCachedBinaryStatus,
  isVettedAgentBinaryPath: mocks.isVettedAgentBinaryPath,
}));

import { resolveTerminalCommand } from '../agentProfileResolver';

describe('resolveTerminalCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCachedBinaryStatus.mockReturnValue({ binaryPath: 'C:\\managed\\agent.exe' });
    mocks.isVettedAgentBinaryPath.mockReturnValue(true);
  });

  it('returns null for a regular shell without consulting Agent binaries', () => {
    expect(resolveTerminalCommand('shell')).toBeNull();
    expect(mocks.getCachedBinaryStatus).not.toHaveBeenCalled();
    expect(mocks.isVettedAgentBinaryPath).not.toHaveBeenCalled();
  });

  it.each([
    ['claude', 'claude-code', 'Claude'],
    ['codex', 'codex', 'Codex'],
    ['pi', 'pi', 'Pi'],
  ] as const)('maps %s to its Cindy-managed %s runtime', (profile, kind, displayName) => {
    const result = resolveTerminalCommand(profile);

    expect(mocks.getCachedBinaryStatus).toHaveBeenCalledWith(kind);
    expect(mocks.isVettedAgentBinaryPath).toHaveBeenCalledWith(kind, 'C:\\managed\\agent.exe');
    expect(result).toEqual({
      id: profile,
      command: 'C:\\managed\\agent.exe',
      args: [],
      displayName,
    });
  });

  it('fails with a stable marker when the managed binary is missing', () => {
    mocks.getCachedBinaryStatus.mockReturnValue({ binaryPath: null });

    expect(() => resolveTerminalCommand('codex')).toThrow('TERMINAL_AGENT_NOT_READY:codex');
    expect(mocks.isVettedAgentBinaryPath).not.toHaveBeenCalled();
  });

  it('rejects a cached path that is outside the vetted managed location', () => {
    mocks.isVettedAgentBinaryPath.mockReturnValue(false);

    expect(() => resolveTerminalCommand('claude')).toThrow('TERMINAL_AGENT_NOT_READY:claude');
  });
});
