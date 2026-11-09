/**
 * Pure projection from the Lex Server managed-model catalog to a `Provider`.
 *
 * Main-only. This module never touches credentials, Electron or the network so
 * the routing/agent matrix and URL validation stay unit-testable.
 */

import type {
  AgentKind,
  CatalogModel,
  Provider,
  ProviderWireProtocol,
  RoutingDescriptor,
} from '@cindy/model-providers';

import {
  LEX_SERVER_MANAGED_PROVIDER_ID,
  LEX_SERVER_MANAGED_PROVIDER_NAME,
  type LexServerManagedProtocol,
  type LexServerManagedState,
} from '../../shared/lexServerManagedModels.js';

/** Managed models are exposed only to agents with a proven desktop bridge. */
const AGENT_PROTOCOLS: Partial<Record<AgentKind, readonly LexServerManagedProtocol[]>> = {
  'claude-code': ['anthropic-messages', 'openai-chat', 'openai-responses'],
  codex: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  pi: ['anthropic-messages', 'openai-chat', 'openai-responses'],
};

const DEFAULT_PROTOCOL: Partial<Record<AgentKind, ProviderWireProtocol>> = {
  'claude-code': 'anthropic-messages',
  codex: 'openai-responses',
  pi: 'openai-chat',
};

export interface ManagedCatalogModelInput {
  modelKey: string;
  channelId: string;
  name: string;
  protocol: LexServerManagedProtocol;
  revision?: string;
  contextTokens: number;
  outputTokens: number;
  budgetEnforced?: boolean;
  baseUrl: string;
}

export interface ManagedProviderBuildInput {
  state: LexServerManagedState;
  errorCode?: string;
  /** Server origin for display; credentials path. */
  origin: string;
  /** Authoritative inference base URL (from the credential response). */
  baseUrl?: string | null;
  models?: readonly ManagedCatalogModelInput[];
  /** Dev only: loopback HTTP is allowed; packaged builds stay HTTPS-only. */
  allowLoopbackHttp?: boolean;
}

export interface NormalizedInferenceBaseUrl {
  /** Base URL without a trailing slash; always ends in `/v1`. */
  baseUrl: string;
  /** Scheme + host + port only. Cross-origin credentials are rejected. */
  origin: string;
}

/**
 * Validate a server-provided inference base URL.
 *
 * HTTPS is required except for loopback development endpoints. User-info,
 * query strings, fragments and non-`/v1` paths are rejected so a credential
 * can never be re-targeted by catalog data.
 */
export function normalizeInferenceBaseUrl(
  raw: unknown,
  options: { allowLoopbackHttp?: boolean } = {},
): NormalizedInferenceBaseUrl | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:') {
    const loopback =
      url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === '::1'
      || url.hostname === '[::1]';
    if (!(options.allowLoopbackHttp === true && url.protocol === 'http:' && loopback)) {
      return null;
    }
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '/v1') return null;
  return {
    baseUrl: `${url.protocol}//${url.host}/v1`,
    origin: `${url.protocol}//${url.host}`,
  };
}

/**
 * Exact inference URLs the managed facade accepts.
 *
 * The base itself is also valid (proxy target / control-plane); the three
 * protocol endpoints are the only request paths allowed to carry the
 * credential.
 */
const MANAGED_INFERENCE_PATHS = new Set([
  '/v1',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
]);

/**
 * Whether a full URL is the managed base URL or one of its three exact
 * inference endpoints.
 *
 * Deliberately strict: same scheme/host/port as the authoritative base, no
 * userinfo/query/fragment, no extra path segments. An arbitrary path on the
 * same origin must not receive the credential.
 */
export function isManagedInferenceUrl(
  raw: unknown,
  baseUrl: unknown,
  options: { allowLoopbackHttp?: boolean } = {},
): boolean {
  if (typeof raw !== 'string' || typeof baseUrl !== 'string') return false;
  const base = normalizeInferenceBaseUrl(baseUrl, options);
  if (!base) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (`${url.protocol}//${url.host}` !== base.origin) return false;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return MANAGED_INFERENCE_PATHS.has(pathname);
}

/** Host label for display, never including user-info or path. */
export function displayHostForOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  }
}

function modelRoute(
  baseUrl: string,
  protocol: LexServerManagedProtocol,
): CatalogModel['route'] {
  return {
    baseUrl,
    wireProtocol: protocol,
    // The proxy appends the route path to the upstream `/v1` basePath. The
    // Anthropic client sends `/v1/messages`; use the relative path so the
    // forwarded URL is exactly `/v1/messages` (never `/v1/v1/messages`).
    ...(protocol === 'anthropic-messages' ? { requestPath: '/messages' } : {}),
  };
}

function catalogModel(
  model: ManagedCatalogModelInput,
  baseUrl: string,
): CatalogModel {
  return {
    id: model.channelId,
    name: model.name,
    contextWindow: Math.max(1, Math.floor(model.contextTokens)),
    maxOutput: Math.max(1, Math.floor(model.outputTokens)),
    contextWindowVerified: true,
    // The server does not declare reasoning tiers. An empty list is a
    // placeholder, not an explicit "no reasoning" claim.
    efforts: [],
    defaultEffort: null,
    effortsUnknown: true,
    route: modelRoute(baseUrl, model.protocol),
  };
}

function routingForAgent(
  agent: AgentKind,
  baseUrl: string,
): RoutingDescriptor {
  const wireProtocol = DEFAULT_PROTOCOL[agent] ?? 'openai-responses';
  return {
    upstream: baseUrl,
    authStrategy: 'api-key-header',
    wireProtocol,
    // The managed facade accepts `Authorization: Bearer` everywhere and forbids
    // sending both auth headers to `/messages`. buildRouteDecision writes both
    // for non-codex agents; delete the extra one so exactly one leaves the host.
    headerDelete: ['x-api-key'],
    ...(agent === 'codex' && wireProtocol === 'openai-responses'
      ? { supportsResponsesCustomTools: false }
      : {}),
  };
}

/** Build the display-only row used while loading / after a retryable failure. */
export function buildManagedProviderDisplay(
  input: Pick<ManagedProviderBuildInput, 'state' | 'errorCode' | 'origin'>,
): Provider {
  return {
    id: LEX_SERVER_MANAGED_PROVIDER_ID,
    name: LEX_SERVER_MANAGED_PROVIDER_NAME,
    // `source: 'user'` only reuses the existing per-session user-provider
    // routing/key-reader/bridge plumbing. This row is never persisted:
    // custom-provider CRUD/rename/OAuth/refresh channels reject the reserved
    // identity, and active-catalog projection filters legacy collisions. Do not
    // add a customConfig or credential-store path for it.
    source: 'user',
    agents: [],
    auth: { method: 'managed' },
    access: { kind: 'managed' },
    routing: {},
    models: {},
    // Even the display-only row carries the managed channel identity so an
    // in-flight session bound to this provider fails closed (503) instead of
    // falling through to an unrelated default upstream while credentials or
    // the catalog are unavailable.
    channel: {
      supplierId: LEX_SERVER_MANAGED_PROVIDER_ID,
      id: `${LEX_SERVER_MANAGED_PROVIDER_ID}-channel`,
      name: LEX_SERVER_MANAGED_PROVIDER_NAME,
      protocols: [],
    },
    managed: {
      provider: 'lex-server',
      host: displayHostForOrigin(input.origin),
      state: input.state,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    },
  };
}

/**
 * Build the routable managed provider.
 *
 * `baseUrl` is the credential response's authoritative inference base URL.
 * Every catalog model must stay on that exact origin; models on another origin
 * are dropped instead of letting a credential leak to a second host.
 */
export function buildManagedProvider(input: ManagedProviderBuildInput): Provider {
  const display = buildManagedProviderDisplay(input);
  const allowLoopbackHttp = input.allowLoopbackHttp === true;
  const normalized = normalizeInferenceBaseUrl(input.baseUrl, { allowLoopbackHttp });
  if (!normalized || !input.models || input.models.length === 0) {
    return display;
  }
  const models = input.models.filter((model) => {
    const modelBase = normalizeInferenceBaseUrl(model.baseUrl, { allowLoopbackHttp });
    return modelBase !== null && modelBase.origin === normalized.origin;
  });
  if (models.length === 0) return display;

  const routing: Provider['routing'] = {};
  const byAgent: Provider['models'] = {};
  const agents: AgentKind[] = [];
  for (const agent of Object.keys(AGENT_PROTOCOLS) as AgentKind[]) {
    const supported = new Set(AGENT_PROTOCOLS[agent] ?? []);
    const agentModels = models
      .filter((model) => supported.has(model.protocol))
      .map((model) => catalogModel(model, normalized.baseUrl))
      .filter((model, index, list) => list.findIndex((m) => m.id === model.id) === index);
    if (agentModels.length === 0) continue;
    agents.push(agent);
    byAgent[agent] = agentModels;
    routing[agent] = routingForAgent(agent, normalized.baseUrl);
  }
  if (agents.length === 0) return display;

  return {
    ...display,
    agents,
    routing,
    models: byAgent,
    channel: {
      supplierId: LEX_SERVER_MANAGED_PROVIDER_ID,
      id: `${LEX_SERVER_MANAGED_PROVIDER_ID}-channel`,
      name: LEX_SERVER_MANAGED_PROVIDER_NAME,
      protocols: [...new Set(models.map((model) => model.protocol))] as ProviderWireProtocol[],
    },
  };
}

/** Protocol set available to one agent; exported for tests and Pi projection. */
export function managedProtocolsForAgent(agent: AgentKind): readonly LexServerManagedProtocol[] {
  return AGENT_PROTOCOLS[agent] ?? [];
}
