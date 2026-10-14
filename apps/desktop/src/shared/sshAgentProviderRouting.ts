import type { AgentKind } from '@cindy/maker-core';

/**
 * Whether an SSH runtime reaches its model provider through the controller's
 * managed compatibility proxy instead of connecting to an upstream directly.
 *
 * Remote OMP writes a session-scoped proxy route into its private `models.yml`
 * and reaches that controller endpoint through an SSH reverse forward. The
 * CC/Codex channel routes use task-scoped forwards; Pi channels reuse its
 * controller transport. Legacy/native account routes retain their restrictions.
 * Agent-only callers (including Orca policy checks) retain their existing scope.
 * This describes transport capability only: Main still validates the selected
 * provider and model before a session or Worker is started.
 */
export function usesControllerProviderProxyForSsh(agent: AgentKind | null | undefined,
  provider?: { channel?: unknown },
): boolean {
  return (
    agent === 'omp' ||
    (!!provider?.channel && (agent === 'claude-code' || agent === 'codex' || agent === 'pi'))
  );
}
