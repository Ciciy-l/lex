/**
 * Pure projection of the host-managed provider onto Pi's native provider spec.
 *
 * The managed credential never appears here: Pi receives a placeholder API key
 * and talks to the loopback compat proxy, which injects the current credential
 * per request. Remote Pi is excluded because the loopback facade is local.
 */

import type { Provider, ProviderWireProtocol } from '@cindy/model-providers';

import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../shared/lexServerManagedModels.js';

export const MANAGED_PI_API_KEY_ENV = 'CINDY_PI_KEY_LEX_SERVER_MANAGED';

export type ManagedPiApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions';

export interface ManagedPiModel {
  id: string;
  name: string;
  api: ManagedPiApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  headers: Record<string, string>;
}

export interface ManagedPiSpec {
  id: string;
  sourceProviderId: string;
  name: string;
  baseUrl: string;
  api: ManagedPiApi;
  apiKeyEnvVar: string;
  headers: Record<string, string>;
  models: ManagedPiModel[];
}

export interface ManagedPiProjection {
  spec: ManagedPiSpec;
  env: Record<string, string>;
}

export function managedProtocolToPiApi(
  protocol: ProviderWireProtocol | undefined,
): ManagedPiApi | null {
  switch (protocol) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
      return 'openai-completions';
    default:
      return null;
  }
}

export function buildManagedPiProjection(input: {
  provider: Provider;
  isRemote: boolean;
  /** Loopback compat-proxy root; Pi appends its own protocol path. */
  localEndpoint: string;
  placeholderKey: string;
  headers: Record<string, string>;
}): ManagedPiProjection | null {
  if (input.isRemote) return null;
  const { provider } = input;
  if (
    provider.id !== LEX_SERVER_MANAGED_PROVIDER_ID
    || provider.managed?.state !== 'ready'
    || !provider.agents.includes('pi')
  ) {
    return null;
  }
  const catalogModels = provider.models.pi ?? [];
  const models: ManagedPiModel[] = [];
  for (const model of catalogModels) {
    const api = managedProtocolToPiApi(model.route?.wireProtocol ?? 'openai-chat');
    if (!api) continue;
    models.push({
      id: model.id,
      name: model.name,
      api,
      baseUrl: input.localEndpoint,
      contextWindow: model.contextWindow,
      ...(model.maxOutput !== undefined ? { maxTokens: model.maxOutput } : {}),
      headers: input.headers,
    });
  }
  if (models.length === 0) return null;
  return {
    spec: {
      id: provider.id,
      sourceProviderId: provider.id,
      name: provider.name,
      baseUrl: input.localEndpoint,
      api: models[0]!.api,
      apiKeyEnvVar: MANAGED_PI_API_KEY_ENV,
      headers: input.headers,
      models,
    },
    env: { [MANAGED_PI_API_KEY_ENV]: input.placeholderKey },
  };
}
