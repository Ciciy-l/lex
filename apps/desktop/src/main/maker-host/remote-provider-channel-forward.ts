import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import type { AgentDeps } from '@cindy/maker-core';
import { getRemoteSshPool } from '../remote-ssh/index.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getActiveCatalog } from './active-catalog.js';
import { getSessionProvider } from './session-provider-store.js';
import {
  getProviderRoutingDescriptor,
  isProviderRouteMutationInProgress,
} from './provider-route.js';
import {
  authenticateRemoteChannelToken,
  registerRemoteChannelSession,
  REMOTE_CHANNEL_TOKEN_HEADER,
} from './remote-provider-channel-auth.js';

type Options = Parameters<NonNullable<AgentDeps['openRemoteProviderChannelRoute']>>[0];
const leases = new Map<string, () => Promise<void>>();

export function resetRemoteProviderChannelRoutes(): void {
  // release invalidates tokens synchronously, before closing the SSH forwards.
  void Promise.allSettled([...leases.values()].map((release) => release()));
}

/** A separate authenticated listener per task prevents an SSH peer from dropping
 * route headers and reaching the shared proxy's default/account routes. */
export async function openRemoteProviderChannelRoute(opts: Options, localEndpoint: string) {
  const initial = getActiveCatalog().providers.find((provider) => provider.id === opts.providerId);
  if (!initial?.channel) {
    if (opts.providerId && opts.providerId !== 'openai')
      throw new Error('Selected SSH provider channel is unavailable');
    return null;
  }
  if (!opts.sessionId) throw new Error('SSH provider channel requires a task identity');
  const host = getRemoteSshPool().get(opts.remoteHostId);
  if (!host || host.getStatus() !== 'ready') throw new Error('SSH host is not ready');
  const endpoint = new URL(localEndpoint);
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('Provider proxy is not ready');
  if (!getProviderRoutingDescriptor(initial.id, opts.agent, opts.model))
    throw new Error('Selected channel model is unavailable');
  const owner = getActiveAppSession().generation;
  const leaseKey = JSON.stringify([opts.remoteHostId, opts.sessionId]);
  await leases.get(leaseKey)?.();
  let alive = true;
  const current = () => {
    const providerId = getSessionProvider(opts.sessionId);
    return (
      alive &&
      leases.get(leaseKey) === release &&
      !isAppSessionBoundaryPending() &&
      getActiveAppSession().generation === owner &&
      getRemoteSshPool().get(opts.remoteHostId) === host &&
      host.getStatus() === 'ready' &&
      !!providerId &&
      !isProviderRouteMutationInProgress(providerId) &&
      getActiveCatalog().providers.some(
        (provider) => provider.id === providerId && !!provider.channel,
      )
    );
  };
  const registration = registerRemoteChannelSession(opts.sessionId, opts.agent, current);
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url?.split('?', 1)[0];
    const allowed =
      opts.agent === 'claude-code'
        ? path === '/v1/messages' || path === '/v1/messages/count_tokens'
        : path === '/responses' || path === '/responses/compact';
    if (
      !current() ||
      !authenticateRemoteChannelToken(
        incoming.headers[REMOTE_CHANNEL_TOKEN_HEADER],
        registration.token,
      ) ||
      incoming.method !== 'POST' ||
      !allowed ||
      incoming.url?.includes('?')
    ) {
      outgoing.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end('{"error":{"code":"remote_channel_unavailable"}}');
      return;
    }
    // Do not let a remote process claim Pi/OMP/another thread's route. Only the
    // authenticated business session is used by the shared protocol adapters.
    const headers = Object.fromEntries(
      Object.entries(incoming.headers).filter(([name]) =>
        [
          'content-type',
          'content-length',
          'accept',
          'anthropic-version',
          'anthropic-beta',
        ].includes(name),
      ),
    );
    headers[REMOTE_CHANNEL_TOKEN_HEADER] = registration.token;
    const upstream = request(new URL(path!, endpoint), { method: 'POST', headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  let forward: Awaited<ReturnType<typeof host.ensureRemoteForward>> | undefined;
  let stopStatus: (() => void) | undefined;
  const release = async () => {
    if (!alive) return;
    alive = false;
    registration.release();
    stopStatus?.();
    if (leases.get(leaseKey) === release) leases.delete(leaseKey);
    for (const socket of sockets) socket.destroy();
    server.close(() => undefined);
    // Token and local sockets are already revoked. A disconnected SSH transport
    // must not prevent the caller from cleaning its thread/MCP resources too.
    await forward?.close().catch(() => undefined);
  };
  leases.set(leaseKey, release);
  stopStatus = host.onStatus(() => {
    if (host.getStatus() !== 'ready') void release().catch(() => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Provider relay did not bind');
    forward = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: address.port });
    if (!alive) await forward.close().catch(() => undefined);
    if (!current()) throw new Error('Provider channel startup became stale');
    return {
      endpoint: 'http://127.0.0.1:' + forward.remotePort,
      headers: { [REMOTE_CHANNEL_TOKEN_HEADER]: registration.token },
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}
