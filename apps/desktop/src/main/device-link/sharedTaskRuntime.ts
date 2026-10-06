import { SHARED_TASK_CAPABILITY, type DeviceLinkClient } from '@cindy/device-link';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import {
  closeSharedTasksInJournalForSession,
  closeOwnedSharedTasksInJournal,
  createSharedTaskJournal,
  prepareSharedTasksForSession,
  rollbackPreparedSharedTasks,
  finalizePreparedSharedTasks,
  type PreparedSharedTaskClosure,
} from '../localDb/sharedTasks.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState, getCurrentUserId, getDeviceId, getActiveAuthRealm } from '../authManager.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureSharedTaskBoundaryClose, sharedTaskApi } from './sharedTaskApi.js';
import { SharedTaskHost, type SharedTaskCreationState } from './sharedTaskHost.js';
import { setSharedTaskDispatchHost } from './sharedTaskDispatch.js';

const log = createLogger('shared-task');

interface Binding {
  host: SharedTaskHost;
  stop(): Promise<void>;
  dbEpoch: number;
  database: object;
  creationState: SharedTaskCreationState;
  ownerAccountId: string;
  region: ReturnType<typeof getActiveAuthRealm>;
  current(): boolean;
  rebindIfStable(): void;
}

let binding: Binding | null = null;
let generation = 0;

/** Bind host authority to one account, region, owner epoch and profile DB. */
export function startSharedTaskRuntime(options: {
  client: DeviceLinkClient;
  revoke(sharedTaskId: string, memberId?: string): void;
  changed(sharedTaskId: string): void;
}): void {
  const previous = binding;
  void previous?.stop().catch((error) => log.warn('sharedTask runtime disposal failed', error));
  const db = getCurrentDbClientSnapshot();
  const ownerAccountId = getCurrentUserId();
  if (!db || !ownerAccountId) return;

  const epoch = ++generation;
  const scope = activeOwnerScopeKey();
  const region = getActiveAuthRealm();
  const creationState = previous?.database === db.client && previous.dbEpoch === db.clientEpoch &&
    previous.ownerAccountId === ownerAccountId && previous.region === region
    ? previous.creationState
    : { pending: new Map(), identities: new Map() };
  let stopped = false;
  let preservePeerLinks = false;
  const current = () => !stopped && generation === epoch && getAuthState().isAuthenticated &&
    getCurrentUserId() === ownerAccountId && !isAppSessionBoundaryPending() &&
    activeOwnerScopeKey() === scope && getActiveAuthRealm() === region &&
    getCurrentDbClientSnapshot()?.clientEpoch === db.clientEpoch;
  const host = new SharedTaskHost({
    api: sharedTaskApi,
    journal: createSharedTaskJournal(db.client),
    ownerAccountId,
    hostDeviceId: getDeviceId(),
    creationState,
    isCurrent: current,
    async readSession(sessionId) {
      const rows = await db.client.query<{ id: string; title: string; status: string }>(
        'SELECT id, title, status FROM sessions WHERE id = ? LIMIT 1', [sessionId],
      );
      return rows[0] ?? null;
    },
    revoke: (sharedTaskId, memberId) => {
      // A stable same-owner projection replaces the host capture. It must not
      // manufacture a permanent relay revocation for valid guest membership.
      if (!preservePeerLinks) options.revoke(sharedTaskId, memberId);
    },
    changed: options.changed,
  });
  let refreshing = false;
  const rebindIfStable = () => {
    if (stopped || generation !== epoch || binding?.host !== host || current() ||
        isAppSessionBoundaryPending() || !getAuthState().isAuthenticated ||
        getCurrentUserId() !== ownerAccountId || getActiveAuthRealm() !== region) return;
    const active = getActiveAppSession();
    const latestDb = getCurrentDbClientSnapshot();
    if (active.mode !== 'cloud' || active.dataOwnerId !== ownerAccountId ||
        latestDb?.client !== db.client || latestDb.clientEpoch !== db.clientEpoch ||
        activeOwnerScopeKey() === scope) return;
    preservePeerLinks = true;
    startSharedTaskRuntime(options);
  };
  const refresh = async () => {
    if (!current()) {
      rebindIfStable();
      return;
    }
    if (refreshing || !current()) return;
    refreshing = true;
    try {
      // Local terminal records revoke captures even when relay/HTTP is offline.
      await host.restore(options.client.hasServerCapability(SHARED_TASK_CAPABILITY) &&
        options.client.getStatus() === 'online');
    } catch {
      if (current()) log.debug('sharedTask authority refresh unavailable; retrying on next tick');
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => { void refresh(); }, 5_000);
  timer.unref?.();
  const next: Binding = {
    host,
    dbEpoch: db.clientEpoch,
    database: db.client,
    creationState,
    ownerAccountId,
    region,
    current,
    rebindIfStable,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (binding?.host === host) setSharedTaskDispatchHost(null);
      return host.dispose();
    },
  };
  binding = next;
  setSharedTaskDispatchHost(host);
  void refresh();
}

/** Ordinary relay ownership loss invalidates live captures without closing membership. */
export function stopSharedTaskRuntime(): Promise<void> {
  return binding?.stop() ?? Promise.resolve();
}

export function requireSharedTaskHost(): SharedTaskHost {
  binding?.rebindIfStable();
  if (!binding?.current()) throwIpcError('PRECONDITION_FAILED', 'SharedTask host is unavailable');
  return binding.host;
}

/** Await local closure durability before releasing the outgoing profile DB. */
export async function closeSharedTasksBeforeLogout(): Promise<void> {
  const outgoing = binding;
  const db = getCurrentDbClientSnapshot();
  if (!db) return;
  // A stopped binding remains available while the next profile DB is being
  // opened. Never let that stale object supply the owner or region for the
  // current database: use the DbClient snapshot as the profile authority and
  // only reuse host-local state when every identity edge still matches.
  const ownerAccountId = db.userId || getCurrentUserId();
  if (!ownerAccountId) return;
  const region = getActiveAuthRealm();
  const bindingMatchesCurrentDb = Boolean(
    outgoing &&
    outgoing.database === db.client &&
    outgoing.dbEpoch === db.clientEpoch &&
    outgoing.ownerAccountId === ownerAccountId &&
    outgoing.region === region,
  );
  const close = captureSharedTaskBoundaryClose(ownerAccountId, region);
  const ids = bindingMatchesCurrentDb && outgoing
    ? await outgoing.host.closeLocallyForBoundary()
    : await closeOwnedSharedTasksInJournal(db.client, ownerAccountId, getDeviceId());
  if (bindingMatchesCurrentDb && outgoing) {
    await outgoing.stop();
  }
  if (close) {
    // The journal is authoritative; old credentials may already be offline.
    // Keep each close best effort so a network failure never discards local
    // retry state or turns logout into a false durable success.
    await Promise.allSettled(ids.map((id) => close(id)));
  }
}

/** Close a task after its local terminal state is durable; no network is required. */
export async function closeSharedTaskForTask(sessionId: string, database: unknown): Promise<void> {
  const db = getCurrentDbClientSnapshot();
  if (!db || db.client !== database) return;
  const candidate = binding;
  const ownerAccountId = db.userId || getCurrentUserId();
  const region = getActiveAuthRealm();
  const outgoing = candidate && candidate.database === db.client && candidate.dbEpoch === db.clientEpoch &&
    candidate.ownerAccountId === ownerAccountId && candidate.region === region ? candidate : null;
  const close = ownerAccountId ? captureSharedTaskBoundaryClose(ownerAccountId, region) : null;
  const localIds = outgoing ? await outgoing.host.closeLocallyForBoundary(sessionId) : [];
  const journalIds = await closeSharedTasksInJournalForSession(db.client, sessionId);
  const ids = new Set([...localIds, ...journalIds]);
  // Network failure remains represented by the terminal local journal. Never
  // revive the task or make a committed local status appear unsuccessful.
  if (close) await Promise.allSettled([...ids].map((id) => close(id)));
}

export async function prepareSharedTaskClosureForTask(
  sessionId: string,
  database: unknown,
): Promise<PreparedSharedTaskClosure | null> {
  const db = getCurrentDbClientSnapshot();
  if (!db || db.client !== database) return null;
  return prepareSharedTasksForSession(db.client, sessionId);
}

export async function rollbackPreparedSharedTaskClosure(
  database: unknown,
  prepared: PreparedSharedTaskClosure | null,
): Promise<void> {
  if (!prepared || !database || typeof (database as { exec?: unknown }).exec !== 'function') return;
  await rollbackPreparedSharedTasks(database as Parameters<typeof rollbackPreparedSharedTasks>[0], prepared);
}

export async function finalizePreparedSharedTaskClosure(
  database: unknown,
  prepared: PreparedSharedTaskClosure | null,
): Promise<void> {
  if (!prepared || !database || typeof (database as { exec?: unknown }).exec !== 'function') return;
  await finalizePreparedSharedTasks(database as Parameters<typeof finalizePreparedSharedTasks>[0], prepared);
}
