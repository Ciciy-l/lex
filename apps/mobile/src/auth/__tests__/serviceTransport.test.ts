import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
const build = vi.hoisted(() => ({ development: false }));
vi.mock('../mobileBuild', () => ({ get IS_MOBILE_DEVELOPMENT() { return build.development; } }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
import { mobileServiceFetch, preflightMobileLexServer } from '../serviceTransport';

const providers = { region: 'global', attribution: 'email', email: true, phone: false, social: [] };
const valid = (url: string) => url.endsWith('/health') ? { status: 'ok', service: 'Lex Admin Server', capabilities: ['device-link'] }
  : url.endsWith('/ready') ? { status: 'ready' } : providers;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const servers: Server[] = [];
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test address');
  return 'http://127.0.0.1:' + address.port;
}
afterEach(async () => { build.development = false; vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

describe('mobile Lex anonymous preflight', () => {
  it('canonicalizes the root and checks three bounded anonymous JSON contracts', async () => {
    const transport = vi.fn<typeof mobileServiceFetch>(async url => json(valid(url)));
    await expect(preflightMobileLexServer(' https://SERVER.test:443/ ', undefined, transport)).resolves.toEqual({ kind: 'lex-server', origin: 'https://server.test' });
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [url, init] of transport.mock.calls) {
      expect(url.startsWith('https://server.test/')).toBe(true);
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'GET', headers: { Accept: 'application/json' } });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });
  it.each(['https://server.test/admin', 'https://server.test/api', 'https://u:p@server.test', 'https://server.test?x=1', 'http://192.168.1.1', 'https://server.test/#a'])('rejects invalid destinations before fetching %s', async value => {
    const transport = vi.fn(); await expect(preflightMobileLexServer(value, undefined, transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  });
  it.each(['html', 'oversized', 'wrong-ready', 'redirected-origin'])('rejects %s responses', async failure => {
    const transport = async (url: string) => {
      if (!url.endsWith('/health')) return json(failure === 'wrong-ready' && url.endsWith('/ready') ? { status: 'ok' } : valid(url));
      if (failure === 'html') return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      if (failure === 'oversized') return new Response(' '.repeat(65537), { headers: { 'content-type': 'application/json' } });
      const response = json(valid(url)); if (failure === 'redirected-origin') Object.defineProperty(response, 'url', { value: 'https://other.test/health' }); return response;
    };
    await expect(preflightMobileLexServer('https://server.test', undefined, transport)).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' });
  });
  it('cancels late probes without returning a selectable service', async () => {
    let finish!: () => void; const controller = new AbortController();
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const request = preflightMobileLexServer('https://server.test', controller.signal, async url => { await waiting; return json(valid(url)); });
    controller.abort(); finish(); await expect(request).rejects.toMatchObject({ code: 'AUTH_FLOW_SUPERSEDED' });
  });
  it('aborts all probes at the shared ten second deadline', async () => {
    vi.useFakeTimers(); const seen: AbortSignal[] = [];
    const operation = preflightMobileLexServer('https://server.test', undefined, async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!; seen.push(signal); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const result = expect(operation).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(10_000); await result; expect(seen).toHaveLength(3); expect(seen.every(signal => signal.aborted)).toBe(true);
  });
  it('configures a real HTTP transport to reject cross-origin redirects with zero target requests', async () => {
    build.development = true;
    let sourceRequests = 0, targetRequests = 0;
    const target = await listen((_request, response) => { targetRequests++; response.end('unexpected'); });
    const source = await listen((_request, response) => { sourceRequests++; response.writeHead(302, { location: target + '/capture' }); response.end(); });
    await expect(mobileServiceFetch(source + '/api/auth/refresh', { method: 'POST', headers: { Authorization: 'Bearer test-only-invalid' }, body: '{}' })).rejects.toThrow();
    expect(targetRequests).toBe(0);
    expect(sourceRequests).toBe(1);
  });
  it('rejects release loopback before anonymous probing and physical credential requests', async () => {
    const transport = vi.fn();
    await expect(preflightMobileLexServer('http://127.0.0.1:3101', undefined, transport)).rejects.toThrow('INVALID_SERVICE_ORIGIN');
    expect(transport).not.toHaveBeenCalled();
    let requests = 0;
    const source = await listen((_request, response) => { requests++; response.end(); });
    await expect(mobileServiceFetch(source + '/api/auth/refresh', { headers: { Authorization: 'Bearer invalid-fixture' } })).rejects.toThrow('INVALID_SERVICE_ORIGIN');
    expect(requests).toBe(0);
  });
  it('accepts loopback only in development and keeps HTTPS with custom ports in release', async () => {
    const transport = vi.fn<typeof mobileServiceFetch>(async url => json(valid(url)));
    build.development = true;
    await expect(preflightMobileLexServer('http://127.0.0.1:3101', undefined, transport)).resolves.toMatchObject({ origin: 'http://127.0.0.1:3101' });
    build.development = false;
    await expect(preflightMobileLexServer('https://server.test:7443', undefined, transport)).resolves.toMatchObject({ origin: 'https://server.test:7443' });
  });
});
