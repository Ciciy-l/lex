/**
 * One-shot 401 recovery for the managed facade.
 *
 * This module deliberately has no imports from the managed service or Electron:
 * proxy hosts import it before the main-process wiring runs. The host installs
 * the two hooks during `initLexServerManagedModels()`. Only the exact managed
 * base URL is eligible; ordinary custom providers keep their existing behavior.
 */
import type {
  UnauthorizedRefresh,
  UnauthorizedRefreshInput,
} from '@cindy/anthropic-compat-proxy';

export interface ManagedRetryHooks {
  isManagedUpstream(url: string): boolean;
  /** Single-flight inside the managed service. */
  forceRefreshCredential(stale: string | null): Promise<string | null>;
}

let hooks: ManagedRetryHooks = {
  isManagedUpstream: () => false,
  forceRefreshCredential: async () => null,
};

/** Install the host hooks once; repeated calls are idempotent. */
export function configureManagedUnauthorizedRetry(next: ManagedRetryHooks): void {
  hooks = next;
}

export function forceRefreshManagedCredential(stale: string | null): Promise<string | null> {
  return hooks.forceRefreshCredential(stale);
}

function upstreamUrl(upstream: UnauthorizedRefreshInput['upstream']): string {
  const defaultPort = upstream.protocol === 'https:' ? 443 : 80;
  return (
    `${upstream.protocol}//${upstream.hostname}`
    + (upstream.port === defaultPort ? '' : `:${upstream.port}`)
    + upstream.basePath
  );
}

function bearer(headers: Readonly<Record<string, string>>): string | null {
  const name = Object.keys(headers).find((key) => key.toLowerCase() === 'authorization');
  const value = name ? headers[name] : undefined;
  return value?.replace(/^Bearer\s+/i, '') ?? null;
}

/** Cheap gate used by the proxy before it buffers a 401 response. */
export function isManagedUnauthorizedTarget(
  input: UnauthorizedRefreshInput,
): boolean {
  return hooks.isManagedUpstream(upstreamUrl(input.upstream));
}

export const managedUnauthorizedRefresh: UnauthorizedRefresh = async (input) => {
  // `upstream` is the proxy target (protocol + host + port + basePath), not the
  // request path. The managed base URL is exactly `<origin>/v1`.
  if (!hooks.isManagedUpstream(upstreamUrl(input.upstream))) return null;
  const credential = await hooks.forceRefreshCredential(bearer(input.headers));
  if (!credential) return null;
  // Exactly one auth header leaves the host for `/messages`; the managed route
  // already deletes x-api-key. `authorization` is always present for
  // api-key-header, including Codex and bridged agents.
  return { authorization: `Bearer ${credential}` };
};

type FetchLike = typeof fetch;

function requestUrl(input: URL | RequestInfo): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input instanceof Request ? input.url : null;
}

/**
 * Wrap a local bridge fetch (Claude Chat/Responses, Codex Chat bridge).
 *
 * Retrying only happens when the input is a replayable string/URL request
 * (not a `Request` with a consumed body), the URL is the current managed
 * facade, and the status is 401. 403/429/5xx and an aborted request are
 * returned untouched.
 */
export function withManagedUnauthorizedRetry(
  fetchImpl: FetchLike,
  enabled: () => boolean,
): FetchLike {
  return async (input, init) => {
    const url = requestUrl(input);
    const managed = Boolean(url && hooks.isManagedUpstream(url));
    // A managed credential must never cross a redirect. The loopback proxy's
    // Node transport does not follow redirects; local bridges use fetch, so
    // force `error` here.
    const dispatchInit = managed
      ? { ...init, redirect: 'error' as RequestRedirect }
      : init;
    const response = await fetchImpl(input, dispatchInit);
    if (response.status !== 401 || !url || !enabled()) {
      return response;
    }
    // A `Request` object carries a single-use body; replaying it would throw
    // after the first attempt consumed it. Leave that (and any other
    // non-replayable body) on the caller's existing error path.
    if (typeof input !== 'string' && !(input instanceof URL)) {
      return response;
    }
    if (init?.body != null && typeof init.body !== 'string' && !Buffer.isBuffer(init.body)) {
      return response;
    }
    if (init?.signal?.aborted) return response;
    if (!managed) return response;
    const headers = new Headers(init?.headers);
    const stale = headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
    const credential = await hooks.forceRefreshCredential(stale);
    if (!credential) return response;
    if (init?.signal?.aborted) return response;
    // Release the rejected response before opening a second upstream request.
    // Only do this once a replacement credential exists; the original response
    // must stay readable when refresh fails and is returned to the caller.
    await response.body?.cancel().catch(() => undefined);
    headers.set('authorization', `Bearer ${credential}`);
    headers.delete('x-api-key');
    return fetchImpl(input, { ...dispatchInit, headers });
  };
}
