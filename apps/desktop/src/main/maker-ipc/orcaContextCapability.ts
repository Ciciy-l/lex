import type { AgentKind } from '@cindy/maker-core';

import type { OrcaWorkerContextSupport } from '../../shared/orcaContextPolicy.js';

/**
 * Pure capability projection for an explicit Orca dispatch context policy.
 *
 * `clear` deliberately does NOT depend on the harness: Desktop registers
 * `/clear` as a host command and all four engines share the same
 * INPUT_CLEAR_SESSION transaction (native retirement + DB generation boundary +
 * preserveWorkspace runtime close). Only an SSH remote session is refused in
 * this slice because its native retirement lives on another host.
 *
 * `compact` is different: it requires a proven native completion boundary.
 * Claude Code has no manualCompact capability; OMP's `{}` RPC result is not
 * proof of a native summary boundary; native terminal presentation cannot be
 * awaited by the host. Only local Codex/Pi are eligible.
 */
export function computeOrcaWorkerContextSupport(input: {
  agentKind: AgentKind;
  remoteHostId: string | null;
  nativePresentation: boolean;
  manualCompactSupported: boolean;
}): OrcaWorkerContextSupport {
  if (input.remoteHostId) {
    return {
      clear: { supported: false, reason: 'remote-session' },
      compact: { supported: false, reason: 'remote-session' },
    };
  }
  const clear = { supported: true as const };
  if (input.nativePresentation) {
    return { clear, compact: { supported: false, reason: 'native-presentation' } };
  }
  if (input.agentKind === 'claude-code') {
    return { clear, compact: { supported: false, reason: 'manual-compact-unavailable' } };
  }
  if (input.agentKind === 'omp') {
    return { clear, compact: { supported: false, reason: 'native-completion-unverified' } };
  }
  if (input.agentKind === 'codex' || input.agentKind === 'pi') {
    return {
      clear,
      compact: input.manualCompactSupported
        ? { supported: true }
        : { supported: false, reason: 'manual-compact-unavailable' },
    };
  }
  return { clear, compact: { supported: false, reason: 'host-version' } };
}
