/**
 * Reserved-managed key-reader boundary.
 *
 * Extracted as a pure, injectable helper so the production branch can be
 * observed directly in unit tests without booting Electron. The production
 * wiring in `createDesktopProviderService` only supplies the catalog/credential
 * readers; behavior is unchanged.
 */

import type { AgentKind, ProviderWireProtocol } from '@cindy/model-providers';

import { isReservedLexServerManagedIdentity } from '../../shared/lexServerManagedModels.js';

export interface HostProviderKeyDeps {
  /** True only when the active catalog contains the host-managed provider itself. */
  hasManagedProvider(providerId: string): boolean;
  readManagedCredential(providerId: string): string | null;
  readCustomProviderKey(
    providerId: string,
    agent: AgentKind,
    protocol?: ProviderWireProtocol,
  ): string | null;
}

/**
 * Resolve a host key read.
 *
 * - Reserved identity + a real managed catalog entry: read the in-memory
 *   managed credential.
 * - Reserved identity without that managed entry (legacy alias/channel):
 *   return null and never call either reader.
 * - Any other id: the ordinary custom-provider key reader.
 */
export function resolveHostProviderKey(
  providerId: string,
  agent: AgentKind,
  protocol: ProviderWireProtocol | undefined,
  deps: HostProviderKeyDeps,
): string | null {
  if (isReservedLexServerManagedIdentity(providerId)) {
    return deps.hasManagedProvider(providerId)
      ? deps.readManagedCredential(providerId)
      : null;
  }
  return deps.readCustomProviderKey(providerId, agent, protocol);
}

/** Build the stable reader function used by production wiring. */
export function createHostProviderKeyReader(
  deps: HostProviderKeyDeps,
): (providerId: string, agent: AgentKind, protocol?: ProviderWireProtocol) => string | null {
  return (providerId, agent, protocol) =>
    resolveHostProviderKey(providerId, agent, protocol, deps);
}
