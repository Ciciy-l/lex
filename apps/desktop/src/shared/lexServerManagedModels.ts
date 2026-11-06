/**
 * Shared contract for the Lex Server managed-model provider.
 *
 * The provider is synthesized in Main from `GET /api/managed-models/catalog`.
 * It is deliberately NOT a user custom provider: no configuration or credential
 * is ever persisted, and every custom-provider mutation channel must reject its
 * reserved id. Renderer code only consumes the non-secret `ProviderView` fields
 * (`managed`) and never receives a credential.
 */

/** Reserved provider id. Custom-provider create/update/delete/rename must reject it. */
export const LEX_SERVER_MANAGED_PROVIDER_ID = 'lex-server-managed';

/** Display name shown in the provider list. Renames are not allowed. */
export const LEX_SERVER_MANAGED_PROVIDER_NAME = 'Lex Server';

/** Only protocols the Desktop can reliably bridge for at least one agent. */
export const LEX_SERVER_MANAGED_PROTOCOLS = [
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
] as const;

export type LexServerManagedProtocol = (typeof LEX_SERVER_MANAGED_PROTOCOLS)[number];

export function isLexServerManagedProtocol(value: unknown): value is LexServerManagedProtocol {
  return (
    value === 'anthropic-messages'
    || value === 'openai-chat'
    || value === 'openai-responses'
  );
}

export function isReservedLexServerManagedProviderId(
  value: unknown,
): value is typeof LEX_SERVER_MANAGED_PROVIDER_ID {
  return typeof value === 'string' && value.trim() === LEX_SERVER_MANAGED_PROVIDER_ID;
}

/**
 * Reserved identity namespace, including derived channel/protocol ids
 * (`lex-server-managed--<protocol>`) and the managed channel id
 * (`lex-server-managed-channel`). Custom suppliers/channels must not claim it.
 */
export function isReservedLexServerManagedIdentity(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return (
    normalized === LEX_SERVER_MANAGED_PROVIDER_ID
    || normalized.startsWith(`${LEX_SERVER_MANAGED_PROVIDER_ID}--`)
    || normalized.startsWith(`${LEX_SERVER_MANAGED_PROVIDER_ID}-`)
  );
}

/**
 * Non-secret provider state surfaced to every renderer.
 *
 * - `loading`     : Lex session exists, catalog/credential not settled yet
 * - `ready`       : catalog and credential are usable
 * - `not-entitled`: server explicitly reports no managed models for this member
 * - `rate-limited`: server budget/rate limit
 * - `unavailable` : network / 5xx / malformed response; retryable
 */
export type LexServerManagedState =
  | 'loading'
  | 'ready'
  | 'not-entitled'
  | 'rate-limited'
  | 'unavailable';

export interface LexServerManagedInfo {
  /** Stable discriminator for renderer branching. */
  provider: 'lex-server';
  /** Server host (no credentials/path) for display. */
  host: string;
  state: LexServerManagedState;
  /** Non-secret reason code; renderer must map it to localized copy. */
  errorCode?: string;
}

/** Request paths allowed on the lex-server origin by `serverApiClient`. */
export const LEX_SERVER_MANAGED_API_PATHS = [
  '/api/managed-models/catalog',
  '/api/managed-models/credentials',
  '/api/managed-models/usage',
] as const;

/** Whether a lex-server allowlisted path may pass the serverApiClient origin gate. */
export function isLexServerManagedApiPath(apiPath: string): boolean {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/managed-models/')) {
    return false;
  }
  // Managed calls never carry a query/fragment; rejecting them keeps the
  // allowlist exact and avoids URL-normalization ambiguity.
  if (apiPath.includes('?') || apiPath.includes('#')) return false;
  const pathname = apiPath;
  // URL normalization could otherwise turn `/catalog/../models` into an
  // unrelated route on the same origin.
  if (
    pathname.includes('\\')
    || pathname.includes('//')
    || /(^|\/)\.{1,2}($|\/)/.test(pathname)
    || /%(?:2e|2f|5c)/i.test(pathname)
  ) {
    return false;
  }
  return (LEX_SERVER_MANAGED_API_PATHS as readonly string[]).includes(pathname);
}

/** Renderer-facing status text keys, kept out of the raw server error codes. */
export function lexServerManagedErrorKey(
  info: { state?: LexServerManagedState | string } | null | undefined,
): string {
  if (!info) return 'settings.providers.lexManaged.state.unavailable';
  switch (info.state) {
    case 'ready':
      return 'settings.providers.lexManaged.state.ready';
    case 'loading':
      return 'settings.providers.lexManaged.state.loading';
    case 'not-entitled':
      return 'settings.providers.lexManaged.state.notEntitled';
    case 'rate-limited':
      return 'settings.providers.lexManaged.state.rateLimited';
    default:
      return 'settings.providers.lexManaged.state.unavailable';
  }
}
