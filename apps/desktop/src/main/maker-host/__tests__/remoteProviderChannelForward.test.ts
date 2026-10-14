import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

const state = vi.hoisted(() => ({
  generation: 1,
  pending: false,
  status: 'ready',
  selected: 'channel',
  mutating: false,
  listeners: new Set<() => void>(),
  forward: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ generation: state.generation }),
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [{ id: 'channel', channel: { supplierId: 'supplier' } }] }),
}));
vi.mock('../session-provider-store.js', () => ({ getSessionProvider: () => state.selected }));
vi.mock('../provider-route.js', () => ({
  getProviderRoutingDescriptor: () => ({}),
  isProviderRouteMutationInProgress: () => state.mutating,
}));
vi.mock('../../remote-ssh/index.js', () => {
  const host = {
    getStatus: () => state.status,
    onStatus: (listener: () => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    ensureRemoteForward: state.forward,
  };
  return { getRemoteSshPool: () => ({ get: () => host }) };
});
import {
  openRemoteProviderChannelRoute,
  resetRemoteProviderChannelRoutes,
} from '../remote-provider-channel-forward.js';
import {
  consumeRemoteChannelSession,
  REMOTE_CHANNEL_TOKEN_HEADER,
} from '../remote-provider-channel-auth.js';

const options = {
  remoteHostId: 'host',
  sessionId: 'task',
  providerId: 'channel',
  model: 'm',
  agent: 'codex' as const,
};
const releases: (() => Promise<void>)[] = [];
let upstream: Server;
let endpoint: string;
let received: { url?: string; headers: Record<string, unknown> }[];
beforeEach(async () => {
  state.generation = 1;
  state.pending = false;
  state.status = 'ready';
  state.selected = 'channel';
  state.mutating = false;
  state.listeners.clear();
  state.forward.mockReset();
  received = [];
  state.forward.mockImplementation(async ({ localPort }) => ({
    remotePort: localPort,
    close: vi.fn(async () => undefined),
  }));
  upstream = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    req.resume();
    res.end('{}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to bind');
  endpoint = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  resetRemoteProviderChannelRoutes();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
async function open() {
  const route = await openRemoteProviderChannelRoute(options, endpoint);
  if (!route) throw new Error('expected channel');
  releases.push(route.release);
  return route;
}
describe('SSH task channel forward lifecycle', () => {
  it('allows only authenticated engine paths and never forwards remote account or route headers', async () => {
    const route = await open();
    const response = await fetch(route.endpoint + '/responses', {
      method: 'POST',
      headers: {
        ...route.headers,
        'content-type': 'application/json',
        authorization: 'Bearer remote-account',
        'x-cindy-pi-session-id': 'other-task',
        'x-cindy-omp-session-id': 'other-task',
        'thread-id': 'other-thread',
      },
      body: JSON.stringify({ model: 'm' }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(received).toHaveLength(1);
    expect(received[0].headers[REMOTE_CHANNEL_TOKEN_HEADER]).toBe(
      route.headers[REMOTE_CHANNEL_TOKEN_HEADER],
    );
    for (const header of [
      'authorization',
      'thread-id',
      'x-cindy-pi-session-id',
      'x-cindy-omp-session-id',
    ])
      expect(received[0].headers[header]).toBeUndefined();
    for (const path of ['/models', '/v1/messages', '/responses?key=not-allowed']) {
      const rejected = await fetch(route.endpoint + path, {
        method: 'POST',
        headers: route.headers,
      });
      expect(rejected.status).toBe(403);
      await rejected.text();
    }
    const forged = await fetch(route.endpoint + '/responses', { method: 'POST' });
    expect(forged.status).toBe(403);
    await forged.text();
    expect(received).toHaveLength(1);
  });
  it('revokes the previous task lease on replacement, disconnect and owner transition', async () => {
    const first = await open();
    const second = await open();
    expect(consumeRemoteChannelSession({ ...first.headers }, 'codex')).toBe(false);
    expect(consumeRemoteChannelSession({ ...second.headers }, 'codex')).toBe('task');
    state.generation++;
    expect(consumeRemoteChannelSession({ ...second.headers }, 'codex')).toBe(false);
    state.status = 'disconnected';
    for (const listener of [...state.listeners]) listener();
    expect(state.listeners.size).toBe(0);
    state.generation--;
    state.status = 'ready';
    expect(consumeRemoteChannelSession({ ...second.headers }, 'codex')).toBe(false);
  });
  it('closes a forward that resolves after host reset instead of publishing a stale token', async () => {
    let resolveForward!: (forward: { remotePort: number; close: () => Promise<void> }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.forward.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveForward = resolve;
          entered();
        }),
    );
    const opening = openRemoteProviderChannelRoute(options, endpoint);
    const rejected = expect(opening).rejects.toThrow('startup became stale');
    await started;
    resetRemoteProviderChannelRoutes();
    const close = vi.fn(async () => undefined);
    resolveForward({ remotePort: 34567, close });
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(state.listeners.size).toBe(0);
  });
  it('releases its listener when establishing the SSH forward fails', async () => {
    state.forward.mockRejectedValue(new Error('SSH disconnected'));
    await expect(open()).rejects.toThrow('SSH disconnected');
    expect(state.listeners.size).toBe(0);
  });
  it('revokes the token and finishes cleanup even if the disconnected forward cannot close', async () => {
    state.forward.mockImplementation(async ({ localPort }) => ({
      remotePort: localPort,
      close: async () => {
        throw new Error('transport closed');
      },
    }));
    const route = await open();
    await expect(route.release()).resolves.toBeUndefined();
    expect(consumeRemoteChannelSession({ ...route.headers }, 'codex')).toBe(false);
    expect(state.listeners.size).toBe(0);
  });
});
