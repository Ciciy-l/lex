/**
 * Controlled command resolver for CLI workbench panes.
 *
 * The renderer chooses a profile enum only. It never supplies an executable,
 * arguments, or environment. Agent binaries are accepted only when the shared
 * binary manager reports an exact, ready, managed path.
 */

import { getCachedBinaryStatus, isVettedAgentBinaryPath } from '../agent-binaries/index.js';
import type { TerminalProfile } from '../../shared/terminal-bridge.js';

export interface ResolvedTerminalCommand {
  id: string;
  command: string;
  args: string[];
  displayName: string;
}

const AGENT_PROFILE_CONFIG = {
  claude: { kind: 'claude-code' as const, displayName: 'Claude' },
  codex: { kind: 'codex' as const, displayName: 'Codex' },
  pi: { kind: 'pi' as const, displayName: 'Pi' },
} as const;

/**
 * Resolve a profile to a PTY command. Throws a stable marker when the bundled
 * runtime has not been prepared yet; the IPC boundary maps that marker to a
 * structured error code without exposing a private path to the renderer.
 */
export function resolveTerminalCommand(profile: TerminalProfile): ResolvedTerminalCommand | null {
  if (profile === 'shell') return null;
  const config = AGENT_PROFILE_CONFIG[profile];
  const candidate = getCachedBinaryStatus(config.kind).binaryPath;
  if (!candidate || !isVettedAgentBinaryPath(config.kind, candidate)) {
    throw new Error(`TERMINAL_AGENT_NOT_READY:${profile}`);
  }
  return {
    id: profile,
    command: candidate,
    args: [],
    displayName: config.displayName,
  };
}
