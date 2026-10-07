import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceLinkClient,
  PROTOCOL_VERSION,
  SHARED_TASK_CAPABILITY,
  SHARED_TASK_RELAY_CAPABILITY,
  parseSharedTaskPeer,
  sharedTaskGuestPeer,
  type Envelope,
  type SharedTaskDetail,
  type WsLike,
} from '@cindy/device-link';

import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../localDb/__tests__/dbWorkerTestUtils.js';
import { WorkerThreadTransport } from '../../localDb/client/WorkerThreadTransport.js';
import { __testing as invokeRegistry } from '../invoke-registry.js';
import {
  setSharedTaskDispatchHost,
} from '../sharedTaskDispatch.js';
import { SharedTaskHost } from '../sharedTaskHost.js';
import { getDeviceLinkInvokeContext } from '../invoke-context.js';
import { stampSharedTaskInput } from '../../maker-ipc/sharedTaskInput.js';
import { runInvoke, wireInboundDispatch, __testing as dispatchTesting } from '../dispatch.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

// Keep this fixture on the production dispatch path while replacing only the
// Electron/relay edges. No maker handler is mocked: the registered handler
// stamps host authority and writes the real worker-backed queue below.
let remoteControlEnabled = true;
let revokedControllers: string[] = [];
vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled, revokedControllers }),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getVersion: () => '0.1.96-test' },
  net: { fetch: globalThis.fetch },
}));
vi.mock('../../remote-desktop/iceConfig', () => ({ loadDesktopIceServers: vi.fn(async () => []) }));
vi.mock('../mediaFetch', () => ({ fetchLocalMediaToOss: vi.fn() }));
vi.mock('../voiceTranscribe', () => ({ transcribeRemoteVoiceInput: vi.fn() }));
vi.mock('../../voice-input/index.js', () => ({
  adviseAndRecordVoiceInputDictionaryLearning: vi.fn(),
}));

class RelaySocket implements WsLike {
  readonly sent: Envelope[] = [];
  bufferedAmount = 0;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Envelope);
  }
  close(code = 1000, reason = ''): void {
    this.emit('close', code, reason);
  }
  terminate(): void {
    this.emit('close', 1006, 'terminated');
  }
  on(event: string, callback: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback as (...args: unknown[]) => void);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(event) ?? []) callback(...args);
  }
  push(envelope: Envelope): void {
    this.emit('message', { toString: () => JSON.stringify(envelope) });
  }
  acknowledgeHello(): void {
    this.push({
      v: PROTOCOL_VERSION,
      kind: 'hello-ack',
      payload: {
        serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'desktop', userId: 'owner',
        capabilities: [SHARED_TASK_RELAY_CAPABILITY],
      },
    });
  }
}

type QueueRow = {
  task_id: string;
  scope_id: string;
  account_id: string;
  member_id: string;
  client_id: string;
  payload: string;
  durable_delivery: number;
};

function detailFor(sharedTaskId: string, sessionId: string, memberId: string, accountId: string): SharedTaskDetail {
  return {
    sharedTaskId, sessionId, ownerAccountId: 'owner', hostDeviceId: 'desktop', revision: 1, status: 'active',
    title: sessionId,
    guests: [{ memberId, accountId, deviceIds: ['phone-shared'], version: 1 }],
    memberLabels: [{ memberId, displayName: accountId, joinedAt: 1 }],
  };
}

function queueItem(member: string): AgentInputQueuedMessage {
  return {
    clientId: 'same-client-id',
    text: `input-${member}`,
    persistedContent: `input-${member}`,
    durableDelivery: true,
    fromDeviceLinkClient: true,
    fromMobileClient: true,
    origin: { kind: 'orca', senderLabel: 'renderer-forged' },
    permissionMode: 'bypassPermissions',
    workingDir: '/guest/forged',
    model: 'guest-forged-model',
    effort: 'guest-forged-effort',
    createOpts: {
      agentKind: 'omp', workingDir: '/guest/forged', model: 'guest-forged-model',
      permissionMode: 'bypassPermissions', vendorOptions: { secret: 'must-not-survive' },
    },
    chatMessage: { clientId: 'same-client-id', role: 'user', content: `input-${member}` },
  } as AgentInputQueuedMessage;
}

describe('shared-task production dispatch to scoped worker queue', () => {
  let rootDir: string;
  let workerScriptPath: string;
  let dbPath: string;
  let drizzleDir: string;
  let worker: WorkerThreadTransport;
  let auditWorker: WorkerThreadTransport;
  let socket: RelaySocket;
  let client: DeviceLinkClient;
  let unwire: (() => void) | undefined;
  let host: SharedTaskHost;
  let details: Map<string, SharedTaskDetail>;
  let journalRows: Map<string, { sharedTaskId: string; sessionId: string; terminal: boolean; snapshot: SharedTaskDetail | null }>;

  const peerOptions = () => ({
    workerScriptPath, dbPath, drizzleDir, betterSqliteModulePath: require.resolve('better-sqlite3'),
  });

  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-shared-task-dispatch-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(rootDir, 'worker'));
    dbPath = path.join(rootDir, 'shared-task.db');
    drizzleDir = path.join(rootDir, 'drizzle');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
      'utf8',
    );
    createMigratedSmokeDb(dbPath);
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(`
      CREATE TABLE shared_task_queue (
        task_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        durable_delivery INTEGER NOT NULL,
        PRIMARY KEY (task_id, scope_id, client_id)
      );
      CREATE TABLE shared_task_settings (
        task_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        engine TEXT NOT NULL
      );
    `);
    seed.close();

    // Production default is 128. Readiness is intentionally sequential to
    // avoid manufacturing startup migration lock races in this task fixture.
    worker = new WorkerThreadTransport(peerOptions());
    await worker.send('query', { sql: 'SELECT 1' });
    auditWorker = new WorkerThreadTransport(peerOptions());
    await auditWorker.send('query', { sql: 'SELECT 1' });

    details = new Map([
      ['share-a', detailFor('share-a', 'task-a', 'member-a', 'guest-a')],
      ['share-b', detailFor('share-b', 'task-b', 'member-b', 'guest-b')],
    ]);
    journalRows = new Map();
    const api = {
      async create(sessionId: string, _title: string, observe?: (id: string) => void) {
        const sharedTaskId = sessionId === 'task-a' ? 'share-a' : 'share-b';
        observe?.(sharedTaskId);
        return { sharedTaskId, revision: 1 };
      },
      async list() { return [...details.values()]; },
      async get(sharedTaskId: string) {
        const value = details.get(sharedTaskId);
        if (!value) throw new Error('missing shared task');
        return value;
      },
      async invite() { return { sharedTaskId: 'share-a', invitation: 'A'.repeat(43) }; },
      async join() { return { sharedTaskId: 'share-a', memberId: 'member-c', status: 'joined' as const, created: false }; },
      async remove() { return { memberId: 'member-a', status: 'removed' as const }; },
      async leave() { return { memberId: 'member-a', status: 'left' as const }; },
      async close(sharedTaskId: string) { return { sharedTaskId, status: 'closed' as const }; },
    };
    const journal = {
      async latest() { return [...journalRows.values()]; },
      async recordAuthority(snapshot: SharedTaskDetail) {
        const previous = journalRows.get(snapshot.sharedTaskId);
        if (previous?.terminal || previous?.snapshot?.revision === snapshot.revision) return false;
        journalRows.set(snapshot.sharedTaskId, {
          sharedTaskId: snapshot.sharedTaskId, sessionId: snapshot.sessionId, terminal: false, snapshot,
        });
        return true;
      },
      async close(identity: { sharedTaskId: string; sessionId: string }) {
        journalRows.set(identity.sharedTaskId, {
          sharedTaskId: identity.sharedTaskId, sessionId: identity.sessionId, terminal: true, snapshot: null,
        });
      },
    };
    host = new SharedTaskHost({
      api, journal, ownerAccountId: 'owner', hostDeviceId: 'desktop',
      isCurrent: () => true,
      readSession: async (sessionId) => ({ id: sessionId, title: sessionId, status: 'active' }),
      revoke: () => undefined, changed: () => undefined,
    });
    await host.open('task-a');
    await host.open('task-b');
    setSharedTaskDispatchHost(host);

    invokeRegistry.reset();
    invokeRegistry.register('maker:input:enqueue', async (_event, sessionId: unknown, rawItem: unknown) => {
      if (typeof sessionId !== 'string') throw new Error('[INVALID_PARAMS] sessionId required');
      const context = getDeviceLinkInvokeContext();
      const capture = context?.sharedTask;
      const item = rawItem as AgentInputQueuedMessage;
      const stamped = capture
        ? stampSharedTaskInput(item, capture, {
          agentKind: 'omp', workingDir: `/task/${sessionId}`, model: 'host-model',
          permissionMode: 'ask', effort: 'medium',
        })
        : item;
      const scopeId = capture?.author.memberId ?? 'owner';
      const accountId = capture?.author.accountId ?? 'owner';
      const memberId = capture?.author.memberId ?? 'owner';
      const beforeDispatch = capture
        ? () => {
          if (!capture.isCurrent() || !capture.authorize('input.send')) {
            throw new Error('[PERMISSION_DENIED] Shared task queue mutation denied');
          }
        }
        : undefined;
      await worker.send('exec', {
        sql: `INSERT INTO shared_task_queue
          (task_id, scope_id, account_id, member_id, client_id, payload, durable_delivery)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id, scope_id, client_id) DO NOTHING`,
        params: [sessionId, scopeId, accountId, memberId, stamped.clientId, JSON.stringify(stamped), stamped.durableDelivery === true ? 1 : 0],
      }, undefined, beforeDispatch);
      return { accepted: true, clientId: stamped.clientId, scopeId };
    });

    socket = new RelaySocket();
    client = new DeviceLinkClient({
      getWsUrl: () => 'ws://synthetic-relay/api/device-link/ws',
      getToken: async () => 'synthetic-token',
      getHello: () => ({ deviceName: 'desktop', platform: 'win32', appVersion: '0.1.96-test', remoteControlEnabled: true, busy: false }),
      // A real WebSocket emits `open` after the client has attached handlers;
      // keep that transport boundary explicit instead of making the synthetic
      // hello acknowledgement double as the TCP upgrade event.
      createWebSocket: () => {
        setTimeout(() => socket.emit('open'), 0);
        return socket;
      },
      timing: { reconnectBaseMs: 1, reconnectMaxMs: 2, pingIntervalMs: 60_000, requestTimeoutMs: 1_000 },
    });
    unwire = wireInboundDispatch(client);
    client.start();
    await vi.waitFor(() => expect(socket.sent.some((frame) => frame.kind === 'hello')).toBe(true), { timeout: 5_000 });
    socket.acknowledgeHello();
  });

  beforeEach(async () => {
    remoteControlEnabled = true;
    revokedControllers = [];
    await worker.send('exec', { sql: 'DELETE FROM shared_task_queue' });
  });

  afterAll(async () => {
    unwire?.();
    client?.stop();
    setSharedTaskDispatchHost(null);
    dispatchTesting.reset();
    invokeRegistry.reset();
    await Promise.all([worker?.close(), auditWorker?.close()]);
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  async function openGuest(taskId: string, memberId: string, requestId: string): Promise<string> {
    const source = sharedTaskGuestPeer(taskId, memberId, 'phone-shared');
    socket.push({
      v: PROTOCOL_VERSION, kind: 'link-open', id: requestId, src: 'phone-shared', dst: 'desktop',
      sharedTask: {
        sharedTaskId: taskId,
        source: { role: 'guest', memberId: memberId },
        target: { role: 'host' },
      },
      payload: { controllerName: memberId, protocolVersion: 1, appVersion: '0.1.96-test', capabilities: [SHARED_TASK_CAPABILITY] },
    });
    await vi.waitFor(() => expect(socket.sent.some((frame) =>
      frame.kind === 'link-accept' && frame.id === requestId && frame.dst === 'phone-shared'
      && frame.sharedTask?.sharedTaskId === taskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === memberId)).toBe(true), { timeout: 5_000 });
    return source;
  }

  async function invokeFrom(source: string, requestId: string, sessionId: string, item = queueItem(source)): Promise<Envelope> {
    const peer = parseSharedTaskPeer(source);
    if (!peer || peer.role !== 'guest') throw new Error('expected scoped guest source');
    socket.push({
      v: PROTOCOL_VERSION, kind: 'invoke', id: requestId, src: 'phone-shared', dst: 'desktop',
      sharedTask: {
        sharedTaskId: peer.sharedTaskId,
        source: { role: 'guest', memberId: peer.memberId },
        target: { role: 'host' },
      },
      payload: { channel: 'maker:input:enqueue', args: [sessionId, item, { sendAtMs: 1 }] },
    });
    await vi.waitFor(() => expect(socket.sent.some((frame) =>
      frame.kind === 'invoke-result' && frame.id === requestId && frame.dst === 'phone-shared'
      && frame.sharedTask?.sharedTaskId === peer.sharedTaskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === peer.memberId)).toBe(true), { timeout: 5_000 });
    return socket.sent.find((frame) => frame.kind === 'invoke-result' && frame.id === requestId
      && frame.dst === 'phone-shared'
      && frame.sharedTask?.sharedTaskId === peer.sharedTaskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === peer.memberId)!;
  }

  it('routes two scoped guests through real DeviceLink dispatch and worker-backed durable queues', async () => {
    const guestA = await openGuest('share-a', 'member-a', 'open-a');
    const guestB = await openGuest('share-b', 'member-b', 'open-b');

    const firstA = await invokeFrom(guestA, 'a-1', 'task-a', queueItem('member-a'));
    const firstB = await invokeFrom(guestB, 'b-1', 'task-b', queueItem('member-b'));
    expect(firstA).toMatchObject({ kind: 'invoke-result', payload: { ok: true } });
    expect(firstB).toMatchObject({ kind: 'invoke-result', payload: { ok: true } });

    // ACK loss/replay: the production request-id cache replays the result and
    // never invokes the SQLite queue handler a second time.
    socket.push({
      v: PROTOCOL_VERSION, kind: 'invoke', id: 'b-1', src: 'phone-shared', dst: 'desktop',
      sharedTask: {
        sharedTaskId: 'share-b',
        source: { role: 'guest', memberId: 'member-b' },
        target: { role: 'host' },
      },
      payload: { channel: 'maker:input:enqueue', args: ['task-b', queueItem('member-b'), { sendAtMs: 1 }] },
    });
    await vi.waitFor(() => expect(socket.sent.filter((frame) => frame.kind === 'invoke-result' && frame.id === 'b-1').length).toBeGreaterThan(1));

    const rows = await auditWorker.send<QueueRow[]>('query', {
      sql: 'SELECT task_id, scope_id, account_id, member_id, client_id, payload, durable_delivery FROM shared_task_queue ORDER BY task_id',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.task_id).toBe('task-a');
    expect(rows[1]?.task_id).toBe('task-b');
    expect(rows[0]?.client_id).not.toBe(rows[1]?.client_id);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      createOpts: { agentKind: 'omp', workingDir: '/task/task-a', model: 'host-model', permissionMode: 'ask' },
      durableDelivery: true,
    });
    expect(JSON.parse(rows[0]!.payload)).not.toHaveProperty('fromDeviceLinkClient');
    expect(JSON.parse(rows[0]!.payload)).not.toHaveProperty('fromMobileClient');
    expect(rows[0]?.durable_delivery).toBe(1);

    const owner = await runInvoke('owner-device', {
      channel: 'maker:input:enqueue', args: ['owner-task', queueItem('owner')],
    });
    expect(owner).toMatchObject({ ok: true, result: { accepted: true, scopeId: 'owner' } });
    await expect(auditWorker.send<{ count: number }[]>('query', {
      sql: "SELECT COUNT(*) AS count FROM shared_task_queue WHERE account_id = 'owner'",
    })).resolves.toEqual([{ count: 1 }]);

    // A guest cannot use a valid peer identity to cross into another task.
    const crossScope = await invokeFrom(guestA, 'a-cross', 'task-b', queueItem('member-a'));
    expect(crossScope).toMatchObject({ payload: { ok: false } });
    await expect(auditWorker.send<{ count: number }[]>('query', {
      sql: "SELECT COUNT(*) AS count FROM shared_task_queue WHERE task_id = 'task-b'",
    })).resolves.toEqual([{ count: 1 }]);
  });

  it('keeps a guarded queue mutation behind default-128 outstanding RPCs after revoke', async () => {
    const guestA = await openGuest('share-a', 'member-a', 'open-barrier');
    const blockers = Array.from({ length: 128 }, () => worker.send('sleep', { ms: 120 }));
    await vi.waitFor(() => expect((worker as unknown as { outstanding: Map<unknown, unknown> }).outstanding.size).toBe(128));

    const pending = invokeFrom(guestA, 'a-revoked', 'task-a', queueItem('member-a'));
    await vi.waitFor(() => expect((worker as unknown as { queued: unknown[] }).queued.length).toBeGreaterThan(0));
    await host.close('share-a');
    const result = await pending;
    expect(result).toMatchObject({ payload: { ok: false, error: { code: 'ACCESS_REVOKED' } } });
    await Promise.all(blockers);

    await expect(auditWorker.send<{ count: number }[]>('query', {
      sql: "SELECT COUNT(*) AS count FROM shared_task_queue WHERE task_id = 'task-a'",
    })).resolves.toEqual([{ count: 0 }]);
    const guestB = await openGuest('share-b', 'member-b', 'open-after-revoke');
    const unaffected = await invokeFrom(guestB, 'b-after-revoke', 'task-b', queueItem('member-b'));
    expect(unaffected).toMatchObject({ payload: { ok: true } });
    await expect(auditWorker.send<{ count: number }[]>('query', {
      sql: "SELECT COUNT(*) AS count FROM shared_task_queue WHERE task_id = 'task-b'",
    })).resolves.toEqual([{ count: 1 }]);
  }, 30_000);
});
