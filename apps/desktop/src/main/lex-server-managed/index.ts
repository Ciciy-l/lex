/**
 * Production wiring for Lex Server managed models.
 *
 * The module owns the only in-memory copy of the 15-minute managed credential.
 * It is never persisted, serialized to a renderer, or included in logs.
 */

import { app, BrowserWindow } from 'electron';

import * as authManager from '../authManager.js';
import { getActiveAppSession, onAppSessionInvalidated } from '../appSessionState.js';
import { setManagedProviders } from '../maker-host/active-catalog.js';
import { createLogger } from '../logger.js';
import { serverApiFetch } from '../serverApiClient.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import {
  isReservedLexServerManagedProviderId,
  LEX_SERVER_MANAGED_PROVIDER_ID,
} from '../../shared/lexServerManagedModels.js';
import { createManagedModelsService, type ManagedModelsService, type ManagedModelsLease } from './service.js';
import { configureManagedUnauthorizedRetry } from './retry.js';

const log = createLogger('lex-server-managed');

let service: ManagedModelsService | null = null;
let unsubscribeAuth: (() => void) | null = null;
let unsubscribeInvalidation: (() => void) | null = null;

function broadcastProviderChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MAKER_PUSH.PROVIDER_CHANGED, {});
    }
  }
}

function currentLease(): ManagedModelsLease | null {
  const state = authManager.getAuthState();
  const active = getActiveAppSession();
  const authService = authManager.getActiveAuthService();
  if (
    !state.isAuthenticated
    || state.mode !== 'cloud'
    || authService.kind !== 'lex-server'
    || !active.dataOwnerId
  ) {
    return null;
  }
  return {
    origin: authService.origin,
    ownerKey: [
      authService.origin,
      active.dataOwnerId,
      active.generation,
      state.ownerGeneration,
    ].join('|'),
  };
}

function lexOrigin(): string {
  const authService = authManager.getActiveAuthService();
  return authService.kind === 'lex-server' ? authService.origin : '';
}

function readManagedPath(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  return serverApiFetch(path, {
    baseUrl: () => lexOrigin(),
    method: init?.method,
    body: init?.body,
    redactErrorDetails: true,
    // Only the stable business codes cross the redacted boundary so the UI can
    // map them to localized copy; upstream messages/bodies stay hidden.
    allowedRedactedErrorCodes: [
      'INVALID_MODEL_CREDENTIAL',
      'MODEL_DENIED',
      'BUDGET_EXCEEDED',
      'MODEL_RATE_LIMITED',
      'MODEL_UNAVAILABLE',
    ],
    logLabel: '/api/managed-models',
    // A hung catalog/credential request must not freeze the single-flight
    // promise; the service also enforces this bound before parsing.
    timeoutMs: 20_000,
  });
}

/**
 * Ensure the module is initialized. Safe to call repeatedly (startup plus
 * tests / lazy callers); subscriptions are installed once per process.
 */
export function initLexServerManagedModels(): ManagedModelsService {
  if (service) return service;
  service = createManagedModelsService({
    fetchCatalog: () => readManagedPath('/api/managed-models/catalog'),
    fetchCredential: () =>
      readManagedPath('/api/managed-models/credentials', { method: 'POST', body: {} }),
    publishProvider: (provider) => {
      setManagedProviders(provider ? [provider] : []);
      broadcastProviderChanged();
    },
    // Match normalizeLexServerOrigin: loopback HTTP is a dev convenience only.
    allowLoopbackHttp: !app.isPackaged,
    log: {
      warn: (message) => log.warn(message),
    },
  });
  configureManagedUnauthorizedRetry({
    isManagedUpstream: (url) => service?.isManagedUpstream(url) ?? false,
    forceRefreshCredential: (stale) =>
      service?.forceRefreshCredential(stale) ?? Promise.resolve(null),
  });
  const applyLease = (): void => {
    try {
      service?.setLease(currentLease());
    } catch (error) {
      log.warn('managed models lease update failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  };
  unsubscribeAuth = authManager.onAuthStateChange(applyLease);
  unsubscribeInvalidation = onAppSessionInvalidated(() => {
    service?.setLease(null);
  });
  applyLease();
  return service;
}

export function getLexServerManagedModelsService(): ManagedModelsService | null {
  return service;
}

/** Key reader branch for provider-route; exact reserved id only. */
export function readLexServerManagedCredential(providerId: string): string | null {
  if (!isReservedLexServerManagedProviderId(providerId)) return null;
  return service?.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID) ?? null;
}

/** Force-refresh hook for a managed-facade 401 retry. */
export async function forceRefreshLexServerManagedCredential(
  stale?: string | null,
): Promise<string | null> {
  return service?.forceRefreshCredential(stale) ?? null;
}

/** Whether an upstream URL belongs to the current managed facade. */
export function isLexServerManagedUpstream(url: string | null | undefined): boolean {
  return service?.isManagedUpstream(url) ?? false;
}

/** Renderer/provider-page refresh path. */
export function refreshLexServerManagedModels(): Promise<void> {
  return service?.refresh({ forceCatalog: true }) ?? Promise.resolve();
}

/** Provider-page open / empty-state freshness check. */
export function ensureLexServerManagedModelsFresh(): void {
  service?.ensureFresh();
}

export function __testingResetLexServerManagedModels(): void {
  unsubscribeAuth?.();
  unsubscribeInvalidation?.();
  unsubscribeAuth = null;
  unsubscribeInvalidation = null;
  service?.dispose();
  service = null;
}
