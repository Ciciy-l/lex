/**
 * Lex Server managed-model state machine (Main-only, dependency-injected).
 *
 * Responsibilities:
 *   - single-flight catalog + credential fetch keyed by the active Lex service
 *     lease (origin + owner generation)
 *   - an in-memory credential that is refreshed shortly before expiry and is
 *     read synchronously on the routing hot path
 *   - a display provider row that is always present for a Lex session, and a
 *     routable provider only after both the catalog and the credential succeed
 *   - owner/generation fencing: late responses from a previous account or
 *     service are dropped without touching the new owner's state
 *
 * Credentials never leave this module's memory and are never logged.
 */

import type { Provider } from '@cindy/model-providers';

import {
  isLexServerManagedProtocol,
  LEX_SERVER_MANAGED_PROVIDER_ID,
  type LexServerManagedState,
} from '../../shared/lexServerManagedModels.js';
import {
  buildManagedProvider,
  buildManagedProviderDisplay,
  displayHostForOrigin,
  isManagedInferenceUrl,
  normalizeInferenceBaseUrl,
  type ManagedCatalogModelInput,
} from './provider.js';

export interface ManagedModelsLease {
  /** Canonical lex-server origin (scheme + host + port). */
  origin: string;
  /** Opaque owner + auth-generation key. Any change invalidates in-flight work. */
  ownerKey: string;
}

export interface ManagedCatalogPayload {
  enabled: boolean;
  budgetEnforced?: boolean;
  models: ManagedCatalogModelInput[];
}

export interface ManagedCredentialPayload {
  credential: string;
  expiresAt: number;
  baseUrl: string;
  budgetEnforced?: boolean;
}

export interface ManagedModelsServiceDeps {
  now?(): number;
  fetchCatalog(): Promise<unknown>;
  fetchCredential(): Promise<unknown>;
  /** Publish (or clear, when null) the active catalog projection. */
  publishProvider(provider: Provider | null): void;
  log?: {
    warn(message: string): void;
  };
  setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  /** Test override; production uses 5 minutes. */
  refreshAheadMs?: number;
  /** Minimum spacing between proactive credential refreshes. */
  minRefreshIntervalMs?: number;
  catalogTtlMs?: number;
  retryCooldownMs?: number;
  /** Upper bound for one catalog/credential request; prevents a hung fetch from freezing the single-flight promise. */
  requestTimeoutMs?: number;
  /**
   * Dev-only loopback HTTP allowance. Production wiring passes
   * `!app.isPackaged`; tests opt in explicitly. Packaged builds stay HTTPS-only.
   */
  allowLoopbackHttp?: boolean;
}

export interface ManagedModelsService {
  /** Apply a new auth lease; null clears everything. */
  setLease(lease: ManagedModelsLease | null): void;
  /** Retry after an empty/error state or refresh a stale catalog. */
  refresh(options?: { forceCatalog?: boolean }): Promise<void>;
  /** Provider page / empty-state refresh with a short freshness window. */
  ensureFresh(): void;
  getProvider(): Provider | null;
  /** Synchronous current credential for the provider-route key reader. */
  readCredential(providerId: string): string | null;
  /** Force a credential refresh for a 401 retry. Single-flight. */
  forceRefreshCredential(stale?: string | null): Promise<string | null>;
  /** Current authoritative credential/inference base URL. */
  getBaseUrl(): string | null;
  /** Whether a URL belongs to the current managed facade. */
  isManagedUpstream(url: string | null | undefined): boolean;
  /** Current non-secret host for display. */
  getDisplayHost(): string | null;
  dispose(): void;
}

const DEFAULT_REFRESH_AHEAD_MS = 5 * 60_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_CATALOG_TTL_MS = 60_000;
const DEFAULT_RETRY_COOLDOWN_MS = 30_000;

function parseExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readErrorCode(error: unknown): { code: string; status: number } {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    const status = (error as { statusCode?: unknown }).statusCode;
    return {
      code: typeof code === 'string' ? code : 'UNKNOWN',
      status: typeof status === 'number' ? status : 0,
    };
  }
  return { code: 'UNKNOWN', status: 0 };
}

function stateForError(error: unknown): { state: LexServerManagedState; errorCode: string } {
  const { code, status } = readErrorCode(error);
  if (
    status === 403
    || code === 'MODEL_DENIED'
    || code === 'ORG_NOT_SUPPORTED'
    || code === 'FORBIDDEN'
  ) {
    return { state: 'not-entitled', errorCode: code };
  }
  if (status === 429 || code === 'BUDGET_EXCEEDED' || code === 'MODEL_RATE_LIMITED' || code === 'RATE_LIMITED') {
    return { state: 'rate-limited', errorCode: code };
  }
  return {
    state: 'unavailable',
    errorCode: code === 'UNKNOWN' ? (status > 0 ? `HTTP_${status}` : 'NETWORK_ERROR') : code,
  };
}

function readCatalogModels(payload: unknown): ManagedCatalogModelInput[] {
  if (!payload || typeof payload !== 'object') return [];
  const rawModels = (payload as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return [];
  const seen = new Set<string>();
  const models: ManagedCatalogModelInput[] = [];
  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Record<string, unknown>;
    if (
      typeof value.modelKey !== 'string'
      || !value.modelKey.trim()
      || typeof value.channelId !== 'string'
      || !value.channelId.trim()
      || typeof value.name !== 'string'
      || !value.name.trim()
      || !isLexServerManagedProtocol(value.protocol)
      || typeof value.contextTokens !== 'number'
      || !Number.isFinite(value.contextTokens)
      || value.contextTokens <= 0
      || typeof value.outputTokens !== 'number'
      || !Number.isFinite(value.outputTokens)
      || value.outputTokens <= 0
      || typeof value.baseUrl !== 'string'
    ) {
      continue;
    }
    const channelId = value.channelId.trim();
    if (seen.has(channelId)) continue;
    seen.add(channelId);
    models.push({
      modelKey: value.modelKey.trim(),
      channelId,
      name: value.name.trim(),
      protocol: value.protocol,
      contextTokens: value.contextTokens,
      outputTokens: value.outputTokens,
      baseUrl: value.baseUrl,
      ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
      ...(typeof value.budgetEnforced === 'boolean' ? { budgetEnforced: value.budgetEnforced } : {}),
    });
  }
  return models;
}

function readCatalogPayload(payload: unknown): ManagedCatalogPayload {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('invalid managed catalog'), { code: 'INVALID_CATALOG' });
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') {
    throw Object.assign(new Error('invalid managed catalog'), { code: 'INVALID_CATALOG' });
  }
  return {
    enabled: value.enabled,
    ...(typeof value.budgetEnforced === 'boolean' ? { budgetEnforced: value.budgetEnforced } : {}),
    models: readCatalogModels(payload),
  };
}

function readCredentialPayload(
  payload: unknown,
  defaults: { refreshAheadMs: number; allowLoopbackHttp: boolean; now: number },
): ManagedCredentialPayload {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('invalid managed credential'), { code: 'INVALID_CREDENTIAL' });
  }
  const value = payload as Record<string, unknown>;
  const credential = typeof value.credential === 'string' ? value.credential.trim() : '';
  const base = normalizeInferenceBaseUrl(value.baseUrl, { allowLoopbackHttp: defaults.allowLoopbackHttp });
  const expiry = parseExpiry(value.expiresAt);
  if (!credential || !base || expiry === null) {
    throw Object.assign(new Error('invalid managed credential'), { code: 'INVALID_CREDENTIAL' });
  }
  // A response whose expiry is already in the refresh window is still usable;
  // it will schedule another refresh immediately. Reject only clearly dead ones.
  if (expiry <= defaults.now - 60_000) {
    throw Object.assign(new Error('expired managed credential'), { code: 'INVALID_CREDENTIAL' });
  }
  return {
    credential,
    expiresAt: expiry,
    baseUrl: base.baseUrl,
    ...(typeof value.budgetEnforced === 'boolean' ? { budgetEnforced: value.budgetEnforced } : {}),
  };
}

export function createManagedModelsService(
  deps: ManagedModelsServiceDeps,
): ManagedModelsService {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const refreshAheadMs = deps.refreshAheadMs ?? DEFAULT_REFRESH_AHEAD_MS;
  const minRefreshIntervalMs = deps.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
  const catalogTtlMs = deps.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  const retryCooldownMs = deps.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 20_000;
  const allowLoopbackHttp = deps.allowLoopbackHttp === true;

  let lease: ManagedModelsLease | null = null;
  let leaseGeneration = 0;
  let catalog: ManagedCatalogPayload | null = null;
  let credential: ManagedCredentialPayload | null = null;
  /**
   * Credentials issued during the current lease (most recent first, bounded).
   * A late 401 from a previous lease/account must not be allowed to reuse the
   * replacement account's current credential.
   */
  const MAX_ISSUED_CREDENTIALS = 4;
  let issuedCredentials: string[] = [];
  let state: LexServerManagedState = 'loading';
  let errorCode: string | null = null;
  let provider: Provider | null = null;
  let lastCatalogAt = 0;
  let lastCredentialAt = 0;
  let lastFailureAt = 0;
  // Credential failures have their own cooldown. `not-entitled` is a terminal
  // authorization state for the catalog, so reusing `lastFailureAt` here would
  // disturb catalog retry/refresh timing.
  let credentialFailureAt = 0;
  let catalogPromise: Promise<void> | null = null;
  let catalogPromiseGeneration = -1;
  let credentialPromise: Promise<ManagedCredentialPayload | null> | null = null;
  let credentialPromiseGeneration = -1;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimerRef(): void {
    if (refreshTimer !== null) {
      clearTimer(refreshTimer);
      refreshTimer = null;
    }
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function publish(): void {
    if (!lease) {
      provider = null;
      deps.publishProvider(null);
      return;
    }
    if (state === 'ready' && catalog && credential) {
      provider = buildManagedProvider({
        state,
        origin: lease.origin,
        baseUrl: credential.baseUrl,
        models: catalog.models,
        allowLoopbackHttp,
      });
    } else {
      provider = buildManagedProviderDisplay({
        state,
        origin: lease.origin,
        ...(errorCode ? { errorCode } : {}),
      });
    }
    deps.publishProvider(provider);
  }

  function setState(next: LexServerManagedState, nextErrorCode?: string | null): void {
    state = next;
    errorCode = nextErrorCode ?? null;
    if (next === 'unavailable' || next === 'rate-limited') lastFailureAt = now();
    publish();
  }

  function clearCredential(): void {
    credential = null;
    clearTimerRef();
  }

  function clearAll(): void {
    clearCredential();
    clearRetryTimer();
    lease = null;
    leaseGeneration += 1;
    catalog = null;
    catalogPromise = null;
    catalogPromiseGeneration = -1;
    credentialPromise = null;
    credentialPromiseGeneration = -1;
    issuedCredentials = [];
    state = 'loading';
    errorCode = null;
    provider = null;
    lastCatalogAt = 0;
    lastCredentialAt = 0;
    lastFailureAt = 0;
    credentialFailureAt = 0;
  }

  function scheduleCredentialRefresh(): void {
    clearTimerRef();
    if (!credential || !lease) return;
    const delay = Math.max(
      minRefreshIntervalMs,
      credential.expiresAt - refreshAheadMs - now(),
    );
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      if (!lease) return;
      void ensureCredential(true).catch(() => {
        // The failure path publishes state; the retry timer re-arms.
      });
    }, Math.min(delay, 24 * 60 * 60_000));
  }

  function scheduleRetry(): void {
    clearRetryTimer();
    if (!lease) return;
    const failures = lastFailureAt > 0 ? now() - lastFailureAt : retryCooldownMs;
    const delay = Math.max(retryCooldownMs, catalogTtlMs - failures);
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (!lease) return;
      void refresh({ forceCatalog: true }).catch(() => {});
    }, delay);
  }

  function withRequestTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error(`managed ${label} request timed out`), {
          code: 'MANAGED_REQUEST_TIMEOUT',
          statusCode: 0,
        }));
      }, requestTimeoutMs);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          reject(error);
        },
      );
    });
  }

  async function ensureCatalog(force: boolean, generation: number): Promise<void> {
    if (!lease) return;
    if (
      !force
      && catalog
      && now() - lastCatalogAt < catalogTtlMs
    ) {
      return;
    }
    if (catalogPromise && catalogPromiseGeneration === generation) {
      await catalogPromise;
      return;
    }
    const capturedGeneration = generation;
    const promise = (async () => {
      try {
        const payload = readCatalogPayload(
          await withRequestTimeout(deps.fetchCatalog(), 'catalog'),
        );
        if (capturedGeneration !== leaseGeneration || !lease) return;
        lastCatalogAt = now();
        catalog = payload;
        if (!payload.enabled || payload.models.length === 0) {
          clearCredential();
          setState('not-entitled');
          scheduleRetry();
          return;
        }
        // The catalog is valid; a credential is still required before the
        // provider becomes routable. A cached credential may be returned
        // without a state transition, so settle the ready state here too.
        await ensureCredential(false);
        if (
          credential
          && catalog?.enabled === true
          && catalog.models.length > 0
        ) {
          setState('ready');
        }
      } catch (error) {
        if (capturedGeneration !== leaseGeneration || !lease) return;
        clearCredential();
        const mapped = stateForError(error);
        deps.log?.warn(`managed catalog unavailable: ${mapped.errorCode}`);
        setState(mapped.state, mapped.errorCode);
        scheduleRetry();
      }
    })().finally(() => {
      if (catalogPromise === promise) {
        catalogPromise = null;
        catalogPromiseGeneration = -1;
      }
    });
    catalogPromise = promise;
    catalogPromiseGeneration = capturedGeneration;
    await promise;
  }

  async function ensureCredential(force: boolean): Promise<ManagedCredentialPayload | null> {
    if (!lease) return null;
    const generation = leaseGeneration;
    // A 401 retry must bypass the debounce: the server just rejected the value
    // even though it was locally "fresh". Proactive refresh still coalesces
    // through the minimum interval.
    const freshEnough =
      credential !== null
      && now() < credential.expiresAt - refreshAheadMs
      && (!force || now() - lastCredentialAt >= minRefreshIntervalMs);
    if (freshEnough && !force) return credential;
    if (credentialPromise && credentialPromiseGeneration === generation) {
      return credentialPromise;
    }
    const promise = (async () => {
      try {
        const payload = readCredentialPayload(
          await withRequestTimeout(deps.fetchCredential(), 'credential'),
          {
            refreshAheadMs,
            allowLoopbackHttp,
            now: now(),
          },
        );
        if (generation !== leaseGeneration || !lease) return null;
        credential = payload;
        credentialFailureAt = 0;
        issuedCredentials = [
          payload.credential,
          ...issuedCredentials.filter((value) => value !== payload.credential),
        ].slice(0, MAX_ISSUED_CREDENTIALS);
        lastCredentialAt = now();
        scheduleCredentialRefresh();
        if (catalog?.enabled === true && catalog.models.length > 0) {
          setState('ready');
        }
        return payload;
      } catch (error) {
        if (generation !== leaseGeneration || !lease) return null;
        clearCredential();
        credentialFailureAt = now();
        const mapped = stateForError(error);
        deps.log?.warn(`managed credential unavailable: ${mapped.errorCode}`);
        setState(mapped.state, mapped.errorCode);
        scheduleRetry();
        return null;
      }
    })().finally(() => {
      if (credentialPromise === promise) {
        credentialPromise = null;
        credentialPromiseGeneration = -1;
      }
    });
    credentialPromise = promise;
    credentialPromiseGeneration = generation;
    return promise;
  }

  async function refresh(options?: { forceCatalog?: boolean }): Promise<void> {
    if (!lease) return;
    const generation = leaseGeneration;
    clearRetryTimer();
    // An explicit refresh outside the ready state must bypass the catalog TTL.
    // Otherwise a not-entitled/error row would flip to loading and stay there
    // because the cached empty snapshot is still fresh.
    const forceCatalog =
      options?.forceCatalog === true
      || state !== 'ready'
      || !catalog
      || !catalog.enabled
      || catalog.models.length === 0;
    if (state !== 'ready') setState('loading');
    await ensureCatalog(forceCatalog, generation);
  }

  return {
    setLease(next) {
      if (next === null) {
        if (lease === null && provider === null) return;
        clearAll();
        deps.publishProvider(null);
        return;
      }
      if (lease && lease.ownerKey === next.ownerKey && lease.origin === next.origin) {
        // Same owner: keep the current snapshot and credential cache.
        return;
      }
      clearAll();
      lease = next;
      leaseGeneration += 1;
      state = 'loading';
      publish();
      void refresh({ forceCatalog: true }).catch(() => {});
    },

    refresh,

    ensureFresh() {
      if (!lease) return;
      const stale = now() - lastCatalogAt >= catalogTtlMs;
      const coolingDown = lastFailureAt > 0 && now() - lastFailureAt < retryCooldownMs;
      if (state === 'ready' && !stale) return;
      if (coolingDown) return;
      // Non-ready rows may hold a fresh-but-empty/error snapshot; always
      // re-fetch the catalog there so an administrator grant becomes visible.
      void refresh({ forceCatalog: state !== 'ready' || stale }).catch(() => {});
    },

    getProvider() {
      return provider;
    },

    readCredential(providerId) {
      if (providerId !== LEX_SERVER_MANAGED_PROVIDER_ID || !lease) return null;
      // Empty / not-entitled catalogs must never trigger a credential request:
      // there is nothing to route, and the derived state must stay truthful.
      if (!catalog || !catalog.enabled || catalog.models.length === 0) return null;
      // The routing hot path must not amplify a failing credential endpoint.
      // A real 401 still goes through forceRefreshCredential(), which bypasses
      // this cooldown.
      const coolingDown =
        credentialFailureAt > 0 && now() - credentialFailureAt < retryCooldownMs;
      const current = credential;
      if (!current) {
        if (!coolingDown) {
          // Kick a background fetch, but never block the synchronous router.
          void ensureCredential(true).catch(() => {});
        }
        return null;
      }
      if (current.expiresAt - refreshAheadMs <= now() && !coolingDown) {
        void ensureCredential(true).catch(() => {});
      }
      return current.credential;
    },

    async forceRefreshCredential(stale) {
      if (!lease) return null;
      if (stale) {
        // A 401 can arrive after the lease changed (same origin, different
        // account/owner). Only credentials issued within this lease may be
        // refreshed/reused; an unknown stale value fails closed.
        if (!issuedCredentials.includes(stale)) return null;
        const current = credential?.credential ?? null;
        if (current && current !== stale) {
          // Another request already rotated to a newer credential. Reuse it
          // instead of starting another refresh; concurrent 401s also share
          // the single in-flight promise inside ensureCredential(true). A
          // forced refresh intentionally bypasses the proactive throttle so a
          // genuine 401 can recover immediately.
          return current;
        }
        const refreshed = await ensureCredential(true);
        return refreshed?.credential ?? credential?.credential ?? null;
      }
      const refreshed = await ensureCredential(true);
      return refreshed?.credential ?? credential?.credential ?? null;
    },

    getBaseUrl() {
      return credential?.baseUrl ?? null;
    },

    isManagedUpstream(url) {
      if (!url || !lease || !credential) return false;
      // Accepts the proxy target (base URL) and the three exact inference
      // endpoints; every other same-origin path is rejected.
      return isManagedInferenceUrl(url, credential.baseUrl, { allowLoopbackHttp });
    },

    getDisplayHost() {
      return lease ? displayHostForOrigin(lease.origin) : null;
    },

    dispose() {
      clearAll();
    },
  };
}
