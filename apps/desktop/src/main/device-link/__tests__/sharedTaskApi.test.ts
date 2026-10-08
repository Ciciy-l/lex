import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  baseUrl: '',
  owner: 'owner-a',
  scope: 'cloud:owner-a:1',
  region: 'global' as const,
  token: 'token-a',
  authenticated: true,
  refresh: vi.fn(),
  invalidate: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), getVersion: () => '0.1.96' },
  net: { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) },
}));
vi.mock('../../authManager.js', () => ({
  getAccessToken: () => h.token,
  getActiveAuthRealm: () => h.region,
  getAuthState: () => ({ isAuthenticated: h.authenticated }),
  getCurrentUserId: () => h.owner,
  refresh: h.refresh,
  invalidateSession: h.invalidate,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.scope,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => h.baseUrl,
}));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'en' }));
vi.mock('../../logger.js', () => ({ createLogger: () => h.logger }));

import { SharedTaskScopeChangedError } from '@cindy/device-link';
import { sharedTaskApi } from '../sharedTaskApi.js';

let server: Server;
let port: number;
let requestCount = 0;
let handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void;

beforeAll(async () => {
  server = createServer((request, response) => handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('shared task localhost fixture did not bind');
  port = address.port;
  h.baseUrl = 'http://127.0.0.1:' + port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  h.owner = 'owner-a';
  h.scope = 'cloud:owner-a:1';
  h.region = 'global';
  h.token = 'token-a';
  h.authenticated = true;
  h.refresh.mockReset().mockResolvedValue(false);
  h.invalidate.mockReset().mockResolvedValue(undefined);
  h.logger.error.mockReset();
  h.logger.warn.mockReset();
  requestCount = 0;
  handler = (_request, response) => {
    response.statusCode = 500;
    response.end();
  };
});

describe('desktop SharedTask API adapter over localhost HTTP', () => {
  it('uses the real serverApiFetch path for create/list and keeps credentials out of the body', async () => {
    const requests: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = [];
    handler = (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST') {
          response.end(JSON.stringify({ sharedTaskId: 'share-a', revision: 1 }));
        } else {
          response.end(JSON.stringify({ sharedTasks: [{
            sharedTaskId: 'share-a', sessionId: 'session-a', ownerAccountId: 'owner-a',
            hostDeviceId: 'desktop-a', title: 'Task', revision: 1,
          }] }));
        }
      });
    };

    await expect(sharedTaskApi.create('session-a', 'Task')).resolves.toEqual({
      sharedTaskId: 'share-a', revision: 1,
    });
    await expect(sharedTaskApi.list()).resolves.toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/device-link/shared-tasks',
      authorization: 'Bearer token-a',
      body: JSON.stringify({ sessionId: 'session-a', title: 'Task' }),
    });
    expect(requests[0].body).not.toContain('invitation');
    expect(requests[0].body).not.toContain('token');
  });

  it('rechecks scope before ACCOUNT_UNAVAILABLE invalidation after the HTTP response', async () => {
    handler = (_request, response) => {
      h.scope = 'cloud:owner-b:2';
      h.owner = 'owner-b';
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'ACCOUNT_UNAVAILABLE' } }));
    };

    await expect(sharedTaskApi.list()).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logger)).not.toContain('token-a');
  });

  it('does not retry a TOKEN_EXPIRED response into a new owner after refresh changes scope', async () => {
    handler = (_request, response) => {
      requestCount += 1;
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'TOKEN_EXPIRED' } }));
    };
    h.refresh.mockImplementation(async () => {
      h.scope = 'cloud:owner-b:2';
      h.owner = 'owner-b';
      h.token = 'token-b';
      return true;
    });

    await expect(sharedTaskApi.list()).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
    expect(requestCount).toBe(1);
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
