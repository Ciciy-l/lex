import type { AgentKind } from '@cindy/maker-core';

/**
 * Whether an SSH runtime reaches its model provider through the controller's
 * managed compatibility proxy instead of connecting to an upstream directly.
 *
 * Remote OMP writes a session-scoped proxy route into its private `models.yml`
 * and reaches that controller endpoint through an SSH reverse forward. The
 * other native SSH adapters retain their existing direct/native provider
 * routes, so their local-only provider restrictions must remain in force.
 * This describes transport capability only: Main still validates the selected
 * provider and model before a session or Worker is started.
 */
export function usesControllerProviderProxyForSsh(agent: AgentKind | null | undefined): boolean {
  return agent === 'omp';
}
