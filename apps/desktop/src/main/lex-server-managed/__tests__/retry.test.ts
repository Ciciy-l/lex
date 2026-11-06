import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureManagedUnauthorizedRetry,
  managedUnauthorizedRefresh,
  withManagedUnauthorizedRetry,
} from '../retry.js';
import { createManagedModelsService } from '../service.js';
import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../../shared/lexServerManagedModels.js';

const BASE = 'https://lex.example.com/v1';

afterEach(() => {
  configureManagedUnauthorizedRetry({
    isManagedUpstream: () => false,
    forceRefreshCredential: async () => null,
  });
});

function installHooks(options: {
  managed?: boolean;
  credential?: string | null;
} = {}) {
  const forceRefreshCredential = vi.fn(async () => options.credential ?? null);
  configureManagedUnauthorizedRetry({
    isManagedUpstream: (url) => options.managed !== false && url.startsWith(BASE),
    forceRefreshCredential,
  });
  return { forceRefreshCredential };
}

describe('managedUnauthorizedRefresh', () => {
  it('refreshes only for the managed target and returns one Bearer header', async () => {
    const hooks = installHooks({ managed: true, credential: 'cred-2' });
    await expect(
      managedUnauthorizedRefresh({
        upstream: { protocol: 'https:', hostname: 'lex.example.com', port: 443, basePath: '/v1' },
        headers: { authorization: 'Bearer cred-1', 'x-api-key': 'cred-1' },
        status: 401,
      }),
    ).resolves.toEqual({ authorization: 'Bearer cred-2' });
    expect(hooks.forceRefreshCredential).toHaveBeenCalledWith('cred-1');
  });

  it('does not refresh a non-managed upstream', async () => {
    const hooks = installHooks({ managed: false, credential: 'cred-2' });
    await expect(
      managedUnauthorizedRefresh({
        upstream: { protocol: 'https:', hostname: 'api.example.com', port: 443, basePath: '/v1' },
        headers: { authorization: 'Bearer cred-1' },
        status: 401,
      }),
    ).resolves.toBeNull();
    expect(hooks.forceRefreshCredential).not.toHaveBeenCalled();
  });

  it('returns null when the refresh yields no credential', async () => {
    installHooks({ managed: true, credential: null });
    await expect(
      managedUnauthorizedRefresh({
        upstream: { protocol: 'https:', hostname: 'lex.example.com', port: 443, basePath: '/v1' },
        headers: { authorization: 'Bearer cred-1' },
        status: 401,
      }),
    ).resolves.toBeNull();
  });
});

describe('withManagedUnauthorizedRetry', () => {
  it('replays exactly once on 401 and removes x-api-key', async () => {
    installHooks({ managed: true, credential: 'cred-2' });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => true);
    const response = await wrapped(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer cred-1', 'x-api-key': 'cred-1' },
      body: JSON.stringify({ model: 'm' }),
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Managed requests never follow redirects, on either attempt.
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error' });
    const retryInit = fetchImpl.mock.calls[1]?.[1];
    const headers = new Headers(retryInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer cred-2');
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('never replays 403 / 429 / 5xx', async () => {
    for (const status of [403, 429, 500]) {
      installHooks({ managed: true, credential: 'cred-2' });
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status }));
      const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => true);
      await wrapped(`${BASE}/responses`, { method: 'POST', body: '{}' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('does not replay a non-managed URL or a disabled caller', async () => {
    for (const [enabled, url] of [
      [true, 'https://api.example.com/v1/responses'],
      [false, `${BASE}/responses`],
    ] as const) {
      installHooks({ managed: true, credential: 'cred-2' });
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 401 }));
      const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => enabled);
      await wrapped(url, { method: 'POST', body: '{}' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels the rejected response body before replaying', async () => {
    installHooks({ managed: true, credential: 'cred-2' });
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('expired'));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(body, { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => true);
    await wrapped(`${BASE}/messages`, { method: 'POST', body: '{}' });
    expect(canceled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns the original readable 401 when refresh fails', async () => {
    installHooks({ managed: true, credential: null });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }));
    const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => true);
    const response = await wrapped(`${BASE}/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('expired');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('hits the production matcher for a full inference URL and replays once', async () => {
    const fetchCatalog = vi.fn(async () => ({
      enabled: true,
      models: [{
        modelKey: 'm1',
        channelId: '11111111-1111-4111-8111-111111111111',
        name: 'Managed One',
        protocol: 'openai-chat',
        contextTokens: 128_000,
        outputTokens: 8_192,
        baseUrl: 'http://127.0.0.1:3101/v1',
      }],
    }));
    const fetchCredential = vi
      .fn()
      .mockResolvedValueOnce({
        credential: 'cred-1',
        expiresAt: Date.now() + 15 * 60_000,
        baseUrl: 'http://127.0.0.1:3101/v1',
      })
      .mockResolvedValueOnce({
        credential: 'cred-2',
        expiresAt: Date.now() + 15 * 60_000,
        baseUrl: 'http://127.0.0.1:3101/v1',
      });
    const service = createManagedModelsService({
      fetchCatalog,
      fetchCredential,
      publishProvider: () => {},
      allowLoopbackHttp: true,
    });
    service.setLease({ origin: 'http://127.0.0.1:3101', ownerKey: 'owner' });
    await service.refresh({ forceCatalog: true });
    expect(service.readCredential(LEX_SERVER_MANAGED_PROVIDER_ID)).toBe('cred-1');
    configureManagedUnauthorizedRetry({
      isManagedUpstream: (url) => service.isManagedUpstream(url),
      forceRefreshCredential: (stale) => service.forceRefreshCredential(stale),
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => true);
    const response = await wrapped('http://127.0.0.1:3101/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer cred-1', 'x-api-key': 'cred-1' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchCredential).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(retryHeaders.get('authorization')).toBe('Bearer cred-2');
    expect(retryHeaders.get('x-api-key')).toBeNull();
  });

  it('does not replay a Request object with a single-use body', async () => {
    installHooks({ managed: true, credential: 'cred-2' });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }));
    const wrapped = withManagedUnauthorizedRetry(fetchImpl, () => true);
    const request = new Request(`${BASE}/messages`, { method: 'POST', body: '{}' });
    const response = await wrapped(request);
    expect(response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
