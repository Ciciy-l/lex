import { describe, expect, it, vi } from 'vitest';
import { authDataOwnerId, preflightLexServer } from '../authService';

const origin = 'http://127.0.0.1:3101';
const bodies: Record<string, unknown> = {
  '/health': { status: 'ok', service: 'Lex Admin Server', capabilities: ['email'] },
  '/ready': { status: 'ready' },
  '/api/auth/providers': { region: 'global', attribution: 'email', email: true, phone: false, social: [] },
};
const reply = (body: unknown, type = 'application/json') => new Response(JSON.stringify(body), { headers: { 'Content-Type': type } });

describe('Lex Server preflight and local owner boundary', () => {
  it('uses anonymous fixed-origin probes without accepting returned endpoints', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
      expect(init.headers).toEqual({ Accept: 'application/json' });
      return reply(bodies[url.slice(origin.length)]);
    });
    expect(await preflightLexServer(origin + '/', undefined, fetch as typeof globalThis.fetch)).toEqual({ kind: 'lex-server', origin });
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(Object.keys(bodies).map(route => origin + route).sort());
  });

  it.each(['html', 'wrong-json', 'too-large', 'redirect', 'certificate'])('rejects %s without a credential request', async mode => {
    const fetch = vi.fn(async () => {
      if (mode === 'certificate') throw new TypeError('synthetic certificate failure');
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://foreign.example' } });
      return mode === 'html' ? reply('<html>admin console</html>', 'text/html')
        : mode === 'too-large' ? reply('x'.repeat(65_537)) : reply({ status: 'ok' });
    });
    await expect(preflightLexServer(origin, undefined, fetch as typeof globalThis.fetch)).rejects.toThrow();
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('discards late success after cancellation even when transport ignores AbortSignal', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (url: string) => {
      await Promise.resolve();
      controller.abort();
      return reply(bodies[url.slice(origin.length)]);
    });
    await expect(preflightLexServer(origin, controller.signal, fetch as typeof globalThis.fetch)).rejects.toMatchObject({ code: 'AUTH_FLOW_SUPERSEDED' });
  });

  it('does not probe invalid origins', async () => {
    const fetch = vi.fn();
    await expect(preflightLexServer(origin + '/admin', undefined, fetch)).rejects.toMatchObject({ code: 'INVALID_SERVER_URL' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses scoped filesystem-safe owners without moving old Cindy history', () => {
    const member = 'same-member';
    const a = authDataOwnerId('lex-server:https://a.example', member);
    const b = authDataOwnerId('lex-server:https://b.example', member);
    expect(a).toMatch(/^lex-[a-f0-9]{64}$/u);
    expect(a).not.toBe(b);
    expect(a).not.toBe(authDataOwnerId('global', member));
    expect(authDataOwnerId('global', member)).toBe(member);
  });
});
