import crypto from 'node:crypto';
import { net } from 'electron';
import { z } from 'zod';
import { AuthApiError, normalizeLexServerOrigin, providerConfigSchema, type AuthServiceScope } from '@cindy/auth-client';

/** Keep old Cindy databases untouched; new deployments get filesystem-safe, disjoint owners. */
export function authDataOwnerId(scope: AuthServiceScope, membershipId: string): string {
  return scope === 'cn' || scope === 'global' ? membershipId
    : `lex-${crypto.createHash('sha256').update(JSON.stringify([scope, membershipId])).digest('hex')}`;
}

const healthSchema = z.object({ status: z.literal('ok'), service: z.literal('Lex Admin Server'), capabilities: z.array(z.string()) });
const readySchema = z.object({ status: z.literal('ready') });
const MAX_PREFLIGHT_BYTES = 64 * 1024;

/** Anonymous, bounded probes. Endpoints are fixed locally, never supplied by a response. */
export async function preflightLexServer(
  input: string,
  signal?: AbortSignal,
  fetch: typeof globalThis.fetch = (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
): Promise<{ kind: 'lex-server'; origin: string }> {
  let origin: string;
  try { origin = normalizeLexServerOrigin(input); } catch (error) {
    throw new AuthApiError(error instanceof Error ? error.message : 'INVALID_SERVER_URL', 400, 'Invalid server address');
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const values = await Promise.all(['/health', '/ready', '/api/auth/providers'].map(async (route) => {
      const response = await fetch(origin + route, { method: 'GET', redirect: 'error',
        credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json') ||
          response.redirected || (response.url && new URL(response.url).origin !== origin)) {
        throw new AuthApiError('INVALID_SERVER_RESPONSE', response.status, 'Server probe failed');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AuthApiError('INVALID_SERVER_RESPONSE', 502, 'Empty server response');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_PREFLIGHT_BYTES) throw new Error('Oversized probe');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    }));
    healthSchema.parse(values[0]);
    readySchema.parse(values[1]);
    const providers = providerConfigSchema.parse(values[2]);
    if (providers.region !== 'global' || !providers.email || providers.phone || providers.social.length > 0) {
      throw new AuthApiError('UNSUPPORTED_SERVER_AUTH', 400, 'Server email authentication is unavailable');
    }
    if (controller.signal.aborted) throw new Error('Cancelled');
    return { kind: 'lex-server', origin };
  } catch (error) {
    if (signal?.aborted) throw new AuthApiError('AUTH_FLOW_SUPERSEDED', 409, 'Server selection cancelled');
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError('SERVER_UNAVAILABLE', 503, 'Could not verify the server');
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', forwardAbort);
  }
}
