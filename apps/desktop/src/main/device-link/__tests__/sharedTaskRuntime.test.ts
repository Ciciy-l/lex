import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as { client: object; userId: string; clientEpoch: number } | null,
  owner: 'owner-a',
  device: 'device-a',
  region: 'global' as const,
  scope: 'cloud:owner-a:1',
  authenticated: true,
  token: 'token-a' as string | null,
  hosts: [] as Array<{
    closeLocallyForBoundary: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  closeOwned: vi.fn(),
  closeSession: vi.fn(),
  captured: [] as Array<{ owner: string; region: string }>,
  closed: [] as Array<{ owner: string; region: string; sharedTaskId: string }>,
}));

vi.mock('@cindy/device-link', () => ({ SHARED_TASK_CAPABILITY: 'shared-task-v2' }));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => h.db,
}));
vi.mock('../../localDb/sharedTasks.js', () => ({
  closeSharedTasksInJournalForSession: vi.fn().mockResolvedValue([]),
  closeOwnedSharedTasksInJournal: h.closeOwned,
  createSharedTaskJournal: vi.fn(() => ({})),
  prepareSharedTasksForSession: vi.fn(),
  rollbackPreparedSharedTasks: vi.fn(),
  finalizePreparedSharedTasks: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.scope,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: h.owner, generation: 1 }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: h.authenticated }),
  getCurrentUserId: () => h.owner,
  getDeviceId: () => h.device,
  getActiveAuthRealm: () => h.region,
  getAccessToken: () => h.token,
}));
vi.mock('../sharedTaskApi.js', () => ({
  sharedTaskApi: {},
  captureSharedTaskBoundaryClose: (owner: string, region: string) => {
    h.captured.push({ owner, region });
    return h.token
      ? (sharedTaskId: string) => {
          h.closed.push({ owner, region, sharedTaskId });
          return Promise.resolve();
        }
      : null;
  },
}));
vi.mock('../sharedTaskHost.js', () => ({
  SharedTaskHost: class {
    closeLocallyForBoundary = vi.fn(async () => ['share-a']);
    restore = vi.fn(async () => undefined);
    dispose = vi.fn(async () => undefined);
    constructor() {
      h.hosts.push(this as unknown as typeof h.hosts[number]);
    }
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: (code: string, message: string) => {
  throw Object.assign(new Error(message), { code });
} }));

import type { DeviceLinkClient } from '@cindy/device-link';
import {
  closeSharedTasksBeforeLogout,
  startSharedTaskRuntime,
  stopSharedTaskRuntime,
} from '../sharedTaskRuntime.js';

const client = {
  hasServerCapability: () => false,
  getStatus: () => 'offline',
} as unknown as DeviceLinkClient;

beforeEach(() => {
  h.db = null;
  h.owner = 'owner-a';
  h.device = 'device-a';
  h.region = 'global';
  h.scope = 'cloud:owner-a:1';
  h.authenticated = true;
  h.token = 'token-a';
  h.hosts.length = 0;
  h.captured.length = 0;
  h.closed.length = 0;
  h.closeOwned.mockReset().mockResolvedValue(['share-b']);
});

afterEach(async () => {
  await stopSharedTaskRuntime();
});

describe('profile-bound SharedTask runtime', () => {
  it('uses the current profile journal after A runtime stops before B DB logout', async () => {
    const dbA = {};
    const dbB = {};
    h.db = { client: dbA, userId: 'owner-a', clientEpoch: 1 };
    startSharedTaskRuntime({ client, revoke: vi.fn(), changed: vi.fn() });
    const oldHost = h.hosts[0];
    await stopSharedTaskRuntime();

    h.db = { client: dbB, userId: 'owner-b', clientEpoch: 2 };
    h.owner = 'owner-b';
    h.device = 'device-b';
    h.scope = 'cloud:owner-b:2';
    h.token = 'token-b';
    await closeSharedTasksBeforeLogout();

    expect(h.closeOwned).toHaveBeenCalledExactlyOnceWith(dbB, 'owner-b', 'device-b');
    expect(oldHost.closeLocallyForBoundary).not.toHaveBeenCalled();
    expect(h.captured).toContainEqual({ owner: 'owner-b', region: 'global' });
    expect(h.closed).toContainEqual({ owner: 'owner-b', region: 'global', sharedTaskId: 'share-b' });
    expect(h.captured).not.toContainEqual({ owner: 'owner-a', region: 'global' });
  });

  it('prioritizes durable local journal closure while offline and does not synthesize relay success', async () => {
    h.db = { client: {}, userId: 'owner-a', clientEpoch: 1 };
    h.token = null;
    startSharedTaskRuntime({ client, revoke: vi.fn(), changed: vi.fn() });

    await closeSharedTasksBeforeLogout();

    expect(h.hosts[0].closeLocallyForBoundary).toHaveBeenCalledOnce();
    expect(h.closeOwned).not.toHaveBeenCalled();
    expect(h.captured).toHaveLength(1);
    expect(h.closed).toHaveLength(0);
  });
});
