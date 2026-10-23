import { fetch as expoFetch } from 'expo/fetch';
import { AuthApiError, providerConfigSchema, type AuthService } from '@cindy/auth-client';
import { assertMobileServiceRequestUrl, normalizeMobileLexServerOrigin } from './mobileServerOrigin';

/** Native HTTP must neither forward bearer credentials on redirects nor use cookies. */
export const mobileServiceFetch: (input: string, init?: RequestInit) => Promise<Response> = async (input, init) => {
  assertMobileServiceRequestUrl(input);
  return expoFetch(input, { ...init, credentials: 'omit', redirect: 'error' });
};

/** Anonymous probes share one deadline; response content can never supply an endpoint. */
export async function preflightMobileLexServer(
  input: string, signal?: AbortSignal, transport: typeof mobileServiceFetch = mobileServiceFetch,
): Promise<Extract<AuthService, { kind: 'lex-server' }>> {
  const origin = normalizeMobileLexServerOrigin(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 10_000);
  try {
    const values = await Promise.all(['/health', '/ready', '/api/auth/providers'].map(async path => {
      const response = await transport(origin + path, { method: 'GET', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== origin)
        || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new Error('INVALID_SERVER_RESPONSE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('INVALID_SERVER_RESPONSE');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 64 * 1024) throw new Error('INVALID_SERVER_RESPONSE');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    }));
    const health = values[0] as { status?: unknown; service?: unknown; capabilities?: unknown };
    const ready = values[1] as { status?: unknown };
    if (health?.status !== 'ok' || health.service !== 'Lex Admin Server' || !Array.isArray(health.capabilities)
      || !health.capabilities.every(value => typeof value === 'string') || ready?.status !== 'ready') {
      throw new Error('INVALID_SERVER_RESPONSE');
    }
    const providers = providerConfigSchema.parse(values[2]);
    if (providers.region !== 'global' || !providers.email || providers.phone || providers.social.length) {
      throw new Error('UNSUPPORTED_SERVER_AUTH');
    }
    if (controller.signal.aborted) throw new Error('AUTH_FLOW_SUPERSEDED');
    return { kind: 'lex-server', origin };
  } catch (error) {
    const code = signal?.aborted ? 'AUTH_FLOW_SUPERSEDED'
      : error instanceof Error && ['INVALID_SERVER_RESPONSE', 'UNSUPPORTED_SERVER_AUTH'].includes(error.message)
        ? error.message : 'SERVER_UNAVAILABLE';
    throw new AuthApiError(code, 503, code);
  } finally { clearTimeout(timer); abort(); signal?.removeEventListener('abort', abort); }
}
