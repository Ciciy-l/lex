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
  type SharedTaskQueueItem,
  type WsLike,
} from '@cindy/device-link';

import { buildDbWorkerBundle } from '../../localDb/__tests__/dbWorkerTestUtils.js';
import { runMigrationReplay } from '../../localDb/migrationRunner.js';
import { createDrizzleProxy } from '../../localDb/client/drizzleProxy.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { hasInputDeliveryCancellation, saveAgentInputQueueSnapshot, loadAgentInputQueueSnapshot, readInputDeliveryReceipts, saveCancelledInputDelivery } from '../../localDb/agentInputQueueSnapshots.js';
import { WorkerThreadTransport } from '../../localDb/client/WorkerThreadTransport.js';
import { AgentInputCoordinator } from '../../maker-ipc/agent-input-coordinator.js';
import { createMessage as createDbMessage } from '../../localDb/ipc/messages.js';
import { __testing as invokeRegistry } from '../invoke-registry.js';
import {
  captureSharedTaskPeer,
  setSharedTaskDispatchHost,
  setSharedTaskQueueReader,
  sharedTaskScopedClientId,
  type SharedTaskPeerCapture,
} from '../sharedTaskDispatch.js';
import { SharedTaskHost } from '../sharedTaskHost.js';
import { getDeviceLinkInvokeContext } from '../invoke-context.js';
import { stampSharedTaskInput } from '../../maker-ipc/sharedTaskInput.js';
import { runInvoke, wireInboundDispatch, __testing as dispatchTesting } from '../dispatch.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

// Keep this fixture on the production dispatch/coordinator path while replacing
// only the Electron/relay/vendor edges. The narrow invoke registrations below
// are test adapters around production stamp/coordinator functions; queue
// snapshots, delivery receipts and messages are the real worker-backed SQLite
// tables. This is not a claim that the full Electron registerMakerIpc graph or
// a real backend is running in this fixture.
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
  app: { getVersion: () => '0.1.96-test', getPath: () => 'C:/tmp/xdt-shared-task', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
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

type MessageRow = {
  session_id: string;
  role: string;
  client_id: string;
  content: string;
  agent_meta: string | null;
};

function detailFor(sharedTaskId: string, sessionId: string, memberId: string, accountId: string): SharedTaskDetail {
  return {
    sharedTaskId, sessionId, ownerAccountId: 'owner', hostDeviceId: 'desktop', revision: 1, status: 'active',
    title: sessionId,
    guests: [{ memberId, accountId, deviceIds: ['phone-shared'], version: 1 }],
    memberLabels: [{ memberId, displayName: accountId, joinedAt: 1 }],
  };
}

function queueItem(member: string, clientId = 'same-client-id'): AgentInputQueuedMessage {
  return {
    clientId,
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
  let dbClient: DbClient;
  let inputCoordinator: AgentInputCoordinator;
  let socket: RelaySocket;
  let client: DeviceLinkClient;
  let unwire: (() => void) | undefined;
  let host: SharedTaskHost;
  let details: Map<string, SharedTaskDetail>;
  let journalRows: Map<string, { sharedTaskId: string; sessionId: string; terminal: boolean; snapshot: SharedTaskDetail | null }>;
  const projections = new Map<string, unknown>();
  const capturesByClientId = new Map<string, SharedTaskPeerCapture>();
  const itemsByClientId = new Map<string, AgentInputQueuedMessage>();
  const capturesBySource = new Map<string, SharedTaskPeerCapture>();
  let holdInputDrain = false;

  const peerOptions = () => ({
    workerScriptPath, dbPath, drizzleDir, betterSqliteModulePath: require.resolve('better-sqlite3'),
  });

  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-shared-task-dispatch-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(rootDir, 'worker'));
    dbPath = path.join(rootDir, 'shared-task.db');
    // Use the repository's production migration chain and tables. The relay
    // remains synthetic, but queue/receipt assertions must not use a fixture
    // replacement table with different semantics.
    drizzleDir = path.resolve(__dirname, '../../../../drizzle');
    const seed = new Database(dbPath);
    const sqliteVecName = process.platform === 'win32' ? 'vec0.dll' : process.platform === 'darwin' ? 'vec0.dylib' : 'vec0.so';
    seed.loadExtension(path.resolve(
      __dirname, '../../../../native/sqlite-vec', `${process.platform}-${process.arch}`, sqliteVecName,
    ));
    runMigrationReplay(seed, { drizzleDir });
    seed.pragma('journal_mode = WAL');
    seed.exec(`
      INSERT INTO sessions (id, title, working_dir, model, effort, permission_mode, status, created_at, updated_at)
      VALUES ('task-a', 'Task A', '/task/task-a', 'host-model', 'medium', 'ask', 'active', 1, 1),
             ('task-b', 'Task B', '/task/task-b', 'host-model', 'medium', 'ask', 'active', 1, 1),
             ('owner-task', 'Owner task', '/task/owner', 'host-model', 'medium', 'ask', 'active', 1, 1);
      UPDATE sessions SET agent_kind = 'omp' WHERE id IN ('task-a', 'task-b', 'owner-task');
    `);
    seed.close();

    // Production default is 128. Readiness is intentionally sequential to
    // avoid manufacturing startup migration lock races in this task fixture.
    worker = new WorkerThreadTransport(peerOptions());
    await worker.send('query', { sql: 'SELECT 1' });
    auditWorker = new WorkerThreadTransport(peerOptions());
    await auditWorker.send('query', { sql: 'SELECT 1' });
    dbClient = {
      query: (sql, params) => worker.send('query', { sql, params: params ?? [] }),
      queryOne: (sql, params) => worker.send('queryOne', { sql, params: params ?? [] }),
      exec: (sql, params) => worker.send('exec', { sql, params: params ?? [] }),
      tx: (name: string, args: unknown, transferList?: unknown[], beforeDispatch?: () => void) =>
        worker.send('tx', { name, args }, transferList, beforeDispatch),
      drizzle: createDrizzleProxy(() => worker) as DbClient['drizzle'],
      vecAvailable: true,
      dispose: async () => {},
    };
    setCurrentDbClient(dbClient, 'owner');

    details = new Map([
      ['share-a', detailFor('share-a', 'task-a', 'member-a', 'guest-a')],
      ['share-b', detailFor('share-b', 'task-b', 'member-b', 'guest-b')],
    ]);
    details.set('share-a', {
      ...details.get('share-a')!,
      guests: [
        ...details.get('share-a')!.guests,
        { memberId: 'member-b', accountId: 'guest-b', deviceIds: ['phone-shared'], version: 1 },
      ],
      memberLabels: [
        ...details.get('share-a')!.memberLabels,
        { memberId: 'member-b', displayName: 'guest-b', joinedAt: 1 },
      ],
    });
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

    inputCoordinator = new AgentInputCoordinator({
      // Keep the vendor edge synthetic, but execute the same durable callback
      // makerSendTransaction invokes before a turn is accepted. This makes
      // the coordinator fixture exercise production createMessage/SQLite
      // persistence instead of treating enqueue as a replacement queue table.
      sendToAgent: async (_sessionId, _message, _createOpts, sendOpts) => {
        const persist = sendOpts.persistUserMessage;
        if (!persist) return { kind: 'session-dispatch', source: 'synthetic', dispatched: true };
        persist.onPersisting?.();
        await createDbMessage(
          _sessionId,
          {
            clientId: persist.clientId, role: 'user', content: persist.content,
            agentMeta: {
              uuid: sendOpts.messageUuid,
              sdkSessionId: persist.sdkSessionId,
              ...(persist.delivery ? { delivery: persist.delivery } : {}),
              ...(persist.agentFacingWireContent !== undefined
                ? { agentFacingWireContent: persist.agentFacingWireContent } : {}),
              ...(persist.origin?.kind === 'scheduler' ? { origin: persist.origin } : {}),
              ...(itemsByClientId.get(persist.clientId)?.sharedTaskAuthor
                ? { sharedTaskAuthor: itemsByClientId.get(persist.clientId)?.sharedTaskAuthor } : {}),
              ...(itemsByClientId.get(persist.clientId)?.createOpts
                ? { createOpts: itemsByClientId.get(persist.clientId)?.createOpts } : {}),
              ...(itemsByClientId.get(persist.clientId)?.durableDelivery === true
                ? { durableDelivery: true } : {}),
            },
          },
          persist.shouldBroadcast || persist.expectedClearBoundaryMs !== undefined
            ? {
                ...(persist.shouldBroadcast ? { shouldBroadcast: persist.shouldBroadcast } : {}),
                ...(persist.expectedClearBoundaryMs !== undefined
                  ? { expectedClearBoundaryMs: persist.expectedClearBoundaryMs } : {}),
              }
            : undefined,
        );
        await persist.onPersisted?.();
        return { kind: 'session-dispatch', source: 'synthetic', dispatched: true };
      },
      steerToAgent: async () => {},
      abortSession: async () => {},
      isTurnRunning: () => holdInputDrain,
      hasPendingInteraction: () => false,
      getAgentKind: () => 'omp',
      getSdkSessionId: async () => 'synthetic-sdk-session',
      emitProjection: (projection) => projections.set(projection.sessionId, projection),
      persistQueueSnapshot: (sessionId, items) => saveAgentInputQueueSnapshot(sessionId, items),
      loadQueueSnapshot: (sessionId) => loadAgentInputQueueSnapshot(sessionId),
      createUserMessage: async (sessionId, message, opts) => {
        const capture = capturesByClientId.get(message.clientId);
        if (capture && (!capture.isCurrent() || !capture.authorize('input.send'))) {
          throw new Error('[PERMISSION_DENIED] Shared task task access denied');
        }
      const agentMeta = {
        ...(message.agentMeta && typeof message.agentMeta === 'object' ? message.agentMeta : {}),
        ...(capture ? { sharedTaskAuthor: capture.author } : {}),
        ...(itemsByClientId.has(message.clientId)
          ? { createOpts: itemsByClientId.get(message.clientId)?.createOpts, durableDelivery: true }
          : {}),
        };
        return createDbMessage(sessionId, { ...message, agentMeta: agentMeta as never }, opts);
      },
      beforeDispatchUserTurn: async (_sessionId, item) => {
        const capture = capturesByClientId.get(item.clientId);
        if (capture && (!capture.isCurrent() || !capture.authorize('input.send'))) {
          throw new Error('[PERMISSION_DENIED] Shared task task access denied');
        }
      },
    });

    setSharedTaskQueueReader((sessionId, clientId) => {
      for (const capture of capturesBySource.values()) {
        if (capture.author.sessionId !== sessionId) continue;
        const scopedClientId = sharedTaskScopedClientId(capture, clientId);
        const item = inputCoordinator.getQueueControlSnapshot(sessionId).pendingQueue.find(
          (candidate) => candidate.clientId === scopedClientId || candidate.clientId === clientId,
        );
        if (!item) continue;
        return {
          sessionId,
          authorAccountId: item.sharedTaskAuthor?.accountId ?? '',
          state: 'pending',
          attachments: item.files,
        } satisfies SharedTaskQueueItem & { attachments?: unknown };
      }
      return undefined;
    });

    invokeRegistry.reset();
    invokeRegistry.register('maker:input:enqueue', async (_event, sessionId: unknown, rawItem: unknown) => {
      if (typeof sessionId !== 'string') throw new Error('[INVALID_PARAMS] sessionId required');
      await inputCoordinator.ensureQueueRestored(sessionId);
      const context = getDeviceLinkInvokeContext();
      const capture = context?.sharedTask;
      const item = rawItem as AgentInputQueuedMessage;
      const scopedWireId = capture ? sharedTaskScopedClientId(capture, item.clientId) : item.clientId;
      if (item.durableDelivery === true && hasInputDeliveryCancellation(sessionId, scopedWireId)) {
        return inputCoordinator.getProjection(sessionId);
      }
      const stamped = capture
        ? stampSharedTaskInput(item, capture, {
          agentKind: 'omp', workingDir: `/task/${sessionId}`, model: 'host-model',
          permissionMode: 'ask', effort: 'medium',
        })
        : item;
      if (capture) capturesByClientId.set(stamped.clientId, capture);
      itemsByClientId.set(stamped.clientId, stamped);
      const projection = inputCoordinator.enqueue(sessionId, stamped, { resumeRestorePausedQueue: true });
      if (stamped.durableDelivery === true) {
        const receipts = await readInputDeliveryReceipts(sessionId, [stamped.clientId]);
        return { ...projection, inputDeliveryVersion: 1, deliveryReceipts: receipts };
      }
      return projection;
    });
    invokeRegistry.register('maker:input:get-projection', async (_event, sessionId: unknown, options: unknown) => {
      if (typeof sessionId !== 'string') throw new Error('[INVALID_PARAMS] sessionId required');
      await inputCoordinator.ensureQueueRestored(sessionId);
      const deliveryClientIds = options && typeof options === 'object'
        && Array.isArray((options as { deliveryClientIds?: unknown }).deliveryClientIds)
        ? (options as { deliveryClientIds: unknown[] }).deliveryClientIds.filter(
          (value): value is string => typeof value === 'string',
        )
        : [];
      const projection = inputCoordinator.getProjection(sessionId);
      const deliveryReceipts = await readInputDeliveryReceipts(sessionId, deliveryClientIds);
      return { ...projection, inputDeliveryVersion: 1, deliveryReceipts };
    });
    invokeRegistry.register('maker:input:update-text', async (_event, sessionId: unknown, clientId: unknown, text: unknown) => {
      if (typeof sessionId !== 'string' || typeof clientId !== 'string' || typeof text !== 'string') {
        throw new Error('[INVALID_PARAMS] input update requires session, client and text');
      }
      return inputCoordinator.updateText(sessionId, clientId, text);
    });
    invokeRegistry.register('maker:input:remove', async (_event, sessionId: unknown, clientId: unknown, opts: unknown) => {
      if (typeof sessionId !== 'string' || typeof clientId !== 'string') {
        throw new Error('[INVALID_PARAMS] input remove requires session and client');
      }
      const durable = !!(opts && typeof opts === 'object' && (opts as { durableDelivery?: unknown }).durableDelivery === true);
      const projection = inputCoordinator.remove(sessionId, clientId);
      if (durable) await saveCancelledInputDelivery(sessionId, clientId);
      return durable ? { ...projection, inputDeliveryCancelled: true } : projection;
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
    projections.clear();
    capturesByClientId.clear();
    itemsByClientId.clear();
    capturesBySource.clear();
    holdInputDrain = false;
    for (const sessionId of ['task-a', 'task-b', 'owner-task']) {
      for (const queued of inputCoordinator?.getQueueControlSnapshot(sessionId).pendingQueue ?? []) {
        inputCoordinator.remove(sessionId, queued.clientId);
      }
      inputCoordinator?.onSessionClosed(sessionId);
    }
    await worker.send('exec', { sql: "DELETE FROM agent_input_queue_snapshots WHERE session_id IN ('task-a', 'task-b', 'owner-task')" });
    await worker.send('exec', { sql: "DELETE FROM messages WHERE session_id IN ('task-a', 'task-b', 'owner-task')" });
  });

  afterAll(async () => {
    unwire?.();
    client?.stop();
    setSharedTaskDispatchHost(null);
    dispatchTesting.reset();
    invokeRegistry.reset();
    setSharedTaskQueueReader(null);
    if (dbClient) clearCurrentDbClient(dbClient);
    await Promise.all([worker?.close(), auditWorker?.close()]);
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  async function openGuest(taskId: string, memberId: string, requestId: string, deviceId = 'phone-shared'): Promise<string> {
    const source = sharedTaskGuestPeer(taskId, memberId, deviceId);
    socket.push({
      v: PROTOCOL_VERSION, kind: 'link-open', id: requestId, src: deviceId, dst: 'desktop',
      sharedTask: {
        sharedTaskId: taskId,
        source: { role: 'guest', memberId: memberId },
        target: { role: 'host' },
      },
      payload: { controllerName: memberId, protocolVersion: 1, appVersion: '0.1.96-test', capabilities: [SHARED_TASK_CAPABILITY] },
    });
    await vi.waitFor(() => expect(socket.sent.some((frame) =>
      frame.kind === 'link-accept' && frame.id === requestId && frame.dst === deviceId
      && frame.sharedTask?.sharedTaskId === taskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === memberId)).toBe(true), { timeout: 5_000 });
    const capture = captureSharedTaskPeer(source);
    if (capture) capturesBySource.set(source, capture);
    return source;
  }

  async function invokeFrom(source: string, requestId: string, sessionId: string, item = queueItem(source)): Promise<Envelope> {
    const peer = parseSharedTaskPeer(source);
    if (!peer || peer.role !== 'guest') throw new Error('expected scoped guest source');
    socket.push({
      v: PROTOCOL_VERSION, kind: 'invoke', id: requestId, src: peer.deviceId, dst: 'desktop',
      sharedTask: {
        sharedTaskId: peer.sharedTaskId,
        source: { role: 'guest', memberId: peer.memberId },
        target: { role: 'host' },
      },
      payload: { channel: 'maker:input:enqueue', args: [sessionId, item, { sendAtMs: 1 }] },
    });
    await vi.waitFor(() => expect(socket.sent.some((frame) =>
      frame.kind === 'invoke-result' && frame.id === requestId && frame.dst === peer.deviceId
      && frame.sharedTask?.sharedTaskId === peer.sharedTaskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === peer.memberId)).toBe(true), { timeout: 5_000 });
    return socket.sent.find((frame) => frame.kind === 'invoke-result' && frame.id === requestId
      && frame.dst === peer.deviceId
      && frame.sharedTask?.sharedTaskId === peer.sharedTaskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === peer.memberId)!;
  }

  async function invokeChannel(
    source: string,
    requestId: string,
    channel: string,
    args: unknown[],
  ): Promise<Envelope> {
    const peer = parseSharedTaskPeer(source);
    if (!peer || peer.role !== 'guest') throw new Error('expected scoped guest source');
    socket.push({
      v: PROTOCOL_VERSION, kind: 'invoke', id: requestId, src: peer.deviceId, dst: 'desktop',
      sharedTask: {
        sharedTaskId: peer.sharedTaskId,
        source: { role: 'guest', memberId: peer.memberId },
        target: { role: 'host' },
      },
      payload: { channel, args },
    });
    await vi.waitFor(() => expect(socket.sent.some((frame) =>
      frame.kind === 'invoke-result' && frame.id === requestId && frame.dst === peer.deviceId
      && frame.sharedTask?.sharedTaskId === peer.sharedTaskId
      && frame.sharedTask?.target?.role === 'guest'
      && frame.sharedTask?.target?.memberId === peer.memberId)).toBe(true), { timeout: 5_000 });
    return socket.sent.find((frame) => frame.kind === 'invoke-result' && frame.id === requestId
      && frame.dst === peer.deviceId
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

    const rows = await auditWorker.send<MessageRow[]>('query', {
      sql: "SELECT session_id, role, client_id, content, agent_meta FROM messages WHERE session_id IN ('task-a', 'task-b') AND role = 'user' ORDER BY session_id",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.session_id).toBe('task-a');
    expect(rows[1]?.session_id).toBe('task-b');
    expect(rows[0]?.client_id).not.toBe(rows[1]?.client_id);
    const firstMeta = JSON.parse(rows[0]!.agent_meta ?? '{}');
    expect(firstMeta).toMatchObject({
      sharedTaskAuthor: { sharedTaskId: 'share-a', memberId: 'member-a', accountId: 'guest-a' },
      createOpts: { agentKind: 'omp', workingDir: '/task/task-a', model: 'host-model', permissionMode: 'ask' },
      durableDelivery: true,
    });
    expect(firstMeta).not.toHaveProperty('fromDeviceLinkClient');
    expect(firstMeta).not.toHaveProperty('fromMobileClient');

    const owner = await runInvoke('owner-device', {
      channel: 'maker:input:enqueue', args: ['owner-task', queueItem('owner')],
    });
    expect(owner).toMatchObject({ ok: true, result: expect.objectContaining({ sessionId: 'owner-task' }) });
    await expect(auditWorker.send<{ count: number }[]>('query', {
      sql: "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'owner-task' AND role = 'user'",
    })).resolves.toEqual([{ count: 1 }]);

    // A guest cannot use a valid peer identity to cross into another task.
    const crossScope = await invokeFrom(guestA, 'a-cross', 'task-b', queueItem('member-a'));
    expect(crossScope).toMatchObject({ payload: { ok: false } });
    await vi.waitFor(async () => {
      await expect(auditWorker.send<{ count: number }[]>('query', {
        sql: "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'task-b' AND role = 'user'",
      })).resolves.toEqual([{ count: 1 }]);
    }, { timeout: 5_000 });
  });

  it('keeps raw clientId ACK, edit and withdrawal projections scoped across two guests', async () => {
    const guestA = await openGuest('share-a', 'member-a', 'open-raw-a');
    const guestB = await openGuest('share-a', 'member-b', 'open-raw-b');
    const rawClientId = 'raw-shared-client-id';
    const scopedA = sharedTaskScopedClientId(captureSharedTaskPeer(guestA)!, rawClientId);
    const scopedB = sharedTaskScopedClientId(captureSharedTaskPeer(guestB)!, rawClientId);
    expect(scopedA).not.toBe(scopedB);
    holdInputDrain = true;

    await expect(invokeFrom(guestA, 'raw-enqueue-a', 'task-a', queueItem('member-a', rawClientId)))
      .resolves.toMatchObject({ payload: { ok: true } });
    await expect(invokeFrom(guestB, 'raw-enqueue-b', 'task-a', queueItem('member-b', rawClientId)))
      .resolves.toMatchObject({ payload: { ok: true } });

    const projectionA = await invokeChannel(guestA, 'raw-projection-a', 'maker:input:get-projection', [
      'task-a', { deliveryClientIds: [rawClientId] },
    ]);
    const projectionB = await invokeChannel(guestB, 'raw-projection-b', 'maker:input:get-projection', [
      'task-a', { deliveryClientIds: [rawClientId] },
    ]);
    const resultA = (projectionA.payload as { ok: true; result: Record<string, unknown> }).result;
    const resultB = (projectionB.payload as { ok: true; result: Record<string, unknown> }).result;
    expect(resultA.pendingQueue).toHaveLength(1);
    expect(resultB.pendingQueue).toHaveLength(1);
    expect((resultA.pendingQueue as Array<Record<string, unknown>>)[0]).toMatchObject({
      clientId: rawClientId, sharedTaskAuthor: { memberId: 'member-a' },
    });
    expect((resultB.pendingQueue as Array<Record<string, unknown>>)[0]).toMatchObject({
      clientId: rawClientId, sharedTaskAuthor: { memberId: 'member-b' },
    });
    expect(resultA.deliveryReceipts).toEqual([{ clientId: rawClientId, state: 'pending' }]);
    expect(resultB.deliveryReceipts).toEqual([{ clientId: rawClientId, state: 'pending' }]);

    const editedA = await invokeChannel(guestA, 'raw-edit-a', 'maker:input:update-text', [
      'task-a', rawClientId, 'edited-by-a',
    ]);
    expect(editedA).toMatchObject({ payload: { ok: true } });
    const projectionBAfterEdit = await invokeChannel(guestB, 'raw-projection-b-edit', 'maker:input:get-projection', [
      'task-a', { deliveryClientIds: [rawClientId] },
    ]);
    const resultBAfterEdit = (projectionBAfterEdit.payload as { ok: true; result: Record<string, unknown> }).result;
    expect((resultBAfterEdit.pendingQueue as Array<Record<string, unknown>>)[0]).toMatchObject({
      text: 'input-member-b', sharedTaskAuthor: { memberId: 'member-b' },
    });

    const removedB = await invokeChannel(guestB, 'raw-remove-b', 'maker:input:remove', [
      'task-a', rawClientId, { durableDelivery: true },
    ]);
    expect(removedB).toMatchObject({ payload: { ok: true } });
    // ACK loss/reconcile uses the original wire id; a new request id must not
    // recreate the cancelled scoped row or its durable tombstone.
    await expect(invokeFrom(guestB, 'raw-resend-b', 'task-a', queueItem('member-b', rawClientId)))
      .resolves.toMatchObject({ payload: { ok: true } });
    const projectionAAfterBRemove = await invokeChannel(guestA, 'raw-projection-a-remove', 'maker:input:get-projection', [
      'task-a', { deliveryClientIds: [rawClientId] },
    ]);
    const resultAAfterBRemove = (projectionAAfterBRemove.payload as { ok: true; result: Record<string, unknown> }).result;
    expect(resultAAfterBRemove.pendingQueue).toHaveLength(1);
    expect(resultAAfterBRemove.deliveryReceipts).toEqual([{ clientId: rawClientId, state: 'pending' }]);
    const projectionBAfterRemove = await invokeChannel(guestB, 'raw-projection-b-remove', 'maker:input:get-projection', [
      'task-a', { deliveryClientIds: [rawClientId] },
    ]);
    const resultBAfterRemove = (projectionBAfterRemove.payload as { ok: true; result: Record<string, unknown> }).result;
    expect(resultBAfterRemove.pendingQueue).toHaveLength(0);
    expect(resultBAfterRemove.deliveryReceipts).toEqual([{ clientId: rawClientId, state: 'removed' }]);

    const rows = await auditWorker.send<Array<{ client_id: string; role: string }>>('query', {
      sql: "SELECT client_id, role FROM messages WHERE session_id = 'task-a' AND client_id IN (?, ?) ORDER BY client_id",
      params: [scopedA, scopedB],
    });
    expect(rows).toEqual([{ client_id: scopedB, role: 'message_tombstone' }]);
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
      sql: "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'task-a' AND role = 'user'",
    })).resolves.toEqual([{ count: 0 }]);
    const guestB = await openGuest('share-b', 'member-b', 'open-after-revoke');
    const unaffected = await invokeFrom(guestB, 'b-after-revoke', 'task-b', queueItem('member-b', 'after-revoke-client'));
    expect(unaffected).toMatchObject({ payload: { ok: true } });
    await vi.waitFor(async () => {
      await expect(auditWorker.send<{ count: number }[]>('query', {
        sql: "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'task-b' AND role = 'user'",
      })).resolves.toEqual([{ count: 1 }]);
    }, { timeout: 5_000 });
  }, 30_000);
});
