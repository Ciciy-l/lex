import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnthropicCompatProxy } from './server.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import type { ProxyHandle, UnauthorizedRefresh } from './types.js';

interface FakeUpstream {
  url: string;
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}

async function startUpstream(
  statuses: number[],
): Promise<FakeUpstream> {
  const authorizations: Array<string | undefined> = [];
  let index = 0;
  const server: Server = createServer((req, res) => {
    authorizations.push(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );
    req.resume();
    req.on('end', () => {
      const status = statuses[Math.min(index++, statuses.length - 1)] ?? 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status }));
    });
  });
  const port = await listenOnAvailableLoopbackPort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let proxy: ProxyHandle | null = null;
let upstream: FakeUpstream | null = null;

afterEach(async () => {
  if (proxy) {
    await proxy.dispose();
    proxy = null;
  }
  if (upstream) {
    await upstream.close();
    upstream = null;
  }
});

async function startProxy(
  refresh: UnauthorizedRefresh,
): Promise<string> {
  upstream = await startUpstream([401, 200]);
  proxy = await createAnthropicCompatProxy({
    upstream: upstream.url,
    transformRequest: [],
    routingTransform: () => ({
      upstreamOverride: upstream!.url,
      headerOverride: { authorization: 'Bearer old' },
    }),
    refreshHeadersOnUnauthorized: refresh,
  });
  return proxy.url;
}

async function post(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }),
  });
  return { status: response.status, text: await response.text() };
}

describe('managed 401 replay', () => {
  it('re-forwards exactly once with refreshed headers', async () => {
    const refresh = vi.fn(async () => ({ authorization: 'Bearer new' }));
    const url = await startProxy(refresh);
    const result = await post(url);
    expect(result.status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
    expect(upstream?.authorizations).toEqual(['Bearer old', 'Bearer new']);
  });

  it('does not replay 403', async () => {
    const refresh = vi.fn(async () => ({ authorization: 'Bearer new' }));
    upstream = await startUpstream([403, 200]);
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      routingTransform: () => ({ upstreamOverride: upstream!.url }),
      refreshHeadersOnUnauthorized: refresh,
    });
    const result = await post(proxy.url);
    expect(result.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
    expect(upstream.authorizations).toHaveLength(1);
  });

  it('keeps a non-managed 401 on the normal path without buffering or refresh', async () => {
    const refresh = vi.fn(async () => ({ authorization: 'Bearer new' }));
    const observed: number[] = [];
    upstream = await startUpstream([401, 200]);
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      routingTransform: () => ({ upstreamOverride: upstream!.url }),
      refreshHeadersOnUnauthorized: refresh,
      shouldRefreshHeadersOnUnauthorized: () => false,
      responseObserver: (ctx) => {
        observed.push(ctx.status);
        return null;
      },
    });
    const result = await post(proxy.url);
    expect(result.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
    expect(observed).toEqual([401]);
    expect(upstream.authorizations).toHaveLength(1);
  });

  it('passes the original 401 through when no replacement is available', async () => {
    const refresh = vi.fn(async () => null);
    const url = await startProxy(refresh);
    const result = await post(url);
    expect(result.status).toBe(401);
    expect(refresh).toHaveBeenCalledOnce();
    expect(upstream?.authorizations).toEqual(['Bearer old']);
  });
});
