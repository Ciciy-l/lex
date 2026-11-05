/**
 * In-repo regressions for the reject-and-retry contract: a queue-only Orca
 * dispatch may not enter an active clear/compact, a retry after release queues
 * exactly once, and an owner switch never writes the replacement owner's queue
 * snapshot. These use the real SQLite snapshot save/load path.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { AgentInputCoordinator } from '../agent-input-coordinator.js';
import { createHostSessionClearService } from '../hostSessionClearService.js';
import { createOrcaInterAgentDispatcher } from '../orcaInterAgentDispatcher.js';
import {
  __resetOrcaContextOperationFenceForTest,
  beginOrcaContextOperation,
  releaseOrcaContextOperation,
} from '../orcaContextOperationFence.js';
import { captureOrcaContextOwner } from '../orcaContextOwner.js';
import {
  clearCurrentDbClient,
  getCurrentDbClientSnapshot,
  setCurrentDbClient,
} from '../../localDb/client/current.js';
import {
  awaitAgentInputQueueSnapshotPersistence,
  loadAgentInputQueueSnapshot,
  saveAgentInputQueueSnapshot,
} from '../../localDb/agentInputQueueSnapshots.js';
import * as schema from '../../localDb/schema.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');

const SESSION_ID = 'queue-gate-session';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function database() {
  const raw = new Database(':memory:');
  raw.exec(
    'CREATE TABLE agent_input_queue_snapshots (' +
      'session_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);' +
      'CREATE TABLE changes_log (op TEXT, payload TEXT);',
  );
  raw.exec(
    "CREATE TRIGGER log_insert AFTER INSERT ON agent_input_queue_snapshots BEGIN INSERT INTO changes_log VALUES ('insert', NEW.payload); END;" +
      "CREATE TRIGGER log_update AFTER UPDATE ON agent_input_queue_snapshots BEGIN INSERT INTO changes_log VALUES ('update', NEW.payload); END;" +
      "CREATE TRIGGER log_delete AFTER DELETE ON agent_input_queue_snapshots BEGIN INSERT INTO changes_log VALUES ('delete', OLD.payload); END;",
  );
  return { raw, client: { drizzle: drizzle(raw, { schema }) } };
}

function queued(clientId: string, text = clientId): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'fake',
    effort: '',
    permissionMode: 'default',
    workingDir: '/tmp/queue-gate',
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      isStreaming: false,
      createdAt: '2026-11-05T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/tmp/queue-gate',
      model: 'fake',
      permissionMode: 'default',
    },
  };
}

function readRows(db: ReturnType<typeof database>) {
  const row = db.raw
    .prepare('SELECT payload FROM agent_input_queue_snapshots WHERE session_id=?')
    .get(SESSION_ID) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as AgentInputQueuedMessage[]) : null;
}

function readLog(db: ReturnType<typeof database>) {
  return (db.raw.prepare('SELECT op, payload FROM changes_log').all() as Array<{
    op: string;
    payload: string;
  }>).map((entry) => ({
    op: entry.op,
    ids: (JSON.parse(entry.payload) as AgentInputQueuedMessage[]).map((item) => item.clientId),
  }));
}

function createCoordinator(
  onDiscardedQueuedMessage?: (sessionId: string, item: AgentInputQueuedMessage) => void,
) {
  return new AgentInputCoordinator({
    isTurnRunning: () => true,
    hasPendingInteraction: () => false,
    emitProjection: () => undefined,
    getSdkSessionId: async () => null,
    sendToAgent: async () => {
      throw new Error('unexpected send');
    },
    steerToAgent: async () => undefined,
    abortSession: async () => undefined,
    persistQueueSnapshot: (sessionId: string, items: AgentInputQueuedMessage[]) =>
      saveAgentInputQueueSnapshot(sessionId, items),
    loadQueueSnapshot: (sessionId: string) => loadAgentInputQueueSnapshot(sessionId),
    ...(onDiscardedQueuedMessage ? { onDiscardedQueuedMessage } : {}),
  } as never);
}

function createDispatcher(
  coordinator: AgentInputCoordinator,
  clientId = 'gate-client',
  overrides: Record<string, unknown> = {},
) {
  const live = {
    id: SESSION_ID,
    agentKind: 'claude-code' as const,
    isTurnRunning: () => false,
    send: async () => {
      throw new Error('direct send must not be attempted');
    },
  };
  const createOpts = {
    agentKind: 'claude-code',
    workingDir: '/tmp/queue-gate',
    model: 'fake',
    permissionMode: 'default',
  };
  return createOrcaInterAgentDispatcher({
    createId: () => clientId,
    getSessionMeta: async () => ({ agentKind: 'claude-code', workDir: '/tmp/queue-gate' }),
    getSessionRowSnapshot: async () => ({ title: 'fake', status: 'active', userSendAt: null }),
    getLiveSession: () => live,
    shouldQueueNewTurn: () => true,
    hasSendToSessionLock: () => true,
    buildCreateOptsForQueuedSession: async () => createOpts,
    enqueueQueuedMessage: (sessionId: string, item: AgentInputQueuedMessage) =>
      coordinator.enqueue(sessionId, item),
    reserveNextQueuedMessage: async () => false,
    sendToSessionInternal: async () => {
      throw new Error('direct send must not be attempted');
    },
    createDbMessage: async () => undefined,
    beginDirectTurnChangeSet: async () => undefined,
    abortDirectTurnChangeSet: () => undefined,
    resolveWorkerSenderLabel: async (_workerId: string, fallback: string) => fallback,
    isSessionRunningError: () => false,
    log: { info: () => undefined, warn: () => undefined },
    ...overrides,
  } as never);
}

function params(clientId = 'gate-client') {
  return {
    targetSessionId: SESSION_ID,
    rawContent: `task ${clientId}`,
    source: 'lead' as const,
    senderLabel: 'Lead',
    meta: { source: 'qa', context: 'queue-gate' },
  };
}

afterEach(() => {
  __resetOrcaContextOperationFenceForTest();
  clearCurrentDbClient();
});

describe('Orca context queue gate', () => {
  it.each(['clear', 'compact'] as const)(
    'fails a queue-only dispatch during an active %s before accepted/enqueue/snapshot',
    async (policy) => {
      const db = database();
      setCurrentDbClient(db.client as never, 'synthetic-A');
      const coordinator = createCoordinator();
      const dispatcher = createDispatcher(coordinator);
      await coordinator.ensureQueueRestored(SESSION_ID);
      const token = beginOrcaContextOperation(SESSION_ID, policy);
      let accepted = 0;
      try {
        const result = await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
          ...params(),
          onAccepted: () => {
            accepted += 1;
          },
        });
        expect(result).toMatchObject({
          ok: false,
          dispatchOutcome: { kind: 'host-send', code: 'SESSION_RUNNING' },
        });
        if (result.ok) throw new Error('expected rejection');
        expect(result.dispatchOutcome.message).toMatch(/retry/i);
        expect(accepted).toBe(0);
        expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
        await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
        expect(readRows(db)).toBeNull();
        expect(readLog(db)).toEqual([]);
      } finally {
        releaseOrcaContextOperation(token);
        db.raw.close();
      }
    },
  );

  it('queues the same content exactly once after the fence releases', async () => {
    const db = database();
    setCurrentDbClient(db.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    const dispatcher = createDispatcher(coordinator, 'retry-client');
    await coordinator.ensureQueueRestored(SESSION_ID);
    const token = beginOrcaContextOperation(SESSION_ID, 'clear');
    try {
      expect(await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params('retry-client')))
        .toMatchObject({ ok: false });
      expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
    } finally {
      releaseOrcaContextOperation(token);
    }

    expect(await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params('retry-client')))
      .toMatchObject({ ok: true, mode: 'queued', clientId: 'retry-client' });
    await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
    expect(coordinator.getProjection(SESSION_ID).pendingQueue.map((item) => item.clientId))
      .toEqual(['retry-client']);
    expect(readRows(db)?.map((item) => item.clientId)).toEqual(['retry-client']);
    // The rejected attempt and the retry together produced one row.
    expect(readLog(db)).toEqual([
      { op: 'insert', ids: ['retry-client'] },
    ]);
    db.raw.close();
  });

  it('rejects a fence activated after the pre-enqueue check but before the final commit', async () => {
    const db = database();
    setCurrentDbClient(db.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    const buildStarted = gate();
    const buildRelease = gate();
    let enqueued = 0;
    const dispatcher = createDispatcher(coordinator, 'race-client', {
      buildCreateOptsForQueuedSession: async () => {
        buildStarted.resolve();
        await buildRelease.promise;
        return {
          agentKind: 'claude-code',
          workingDir: '/tmp/queue-gate',
          model: 'fake',
          permissionMode: 'default',
        };
      },
      enqueueQueuedMessage: (sessionId: string, item: AgentInputQueuedMessage) => {
        enqueued += 1;
        coordinator.enqueue(sessionId, item);
      },
    });
    await coordinator.ensureQueueRestored(SESSION_ID);
    let accepted = 0;
    const pending = dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      ...params('race-client'),
      onAccepted: () => {
        accepted += 1;
      },
    });
    await buildStarted.promise;
    const token = beginOrcaContextOperation(SESSION_ID, 'clear');
    try {
      buildRelease.resolve();
      const result = await pending;
      await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
      expect(result).toMatchObject({
        ok: false,
        dispatchOutcome: { kind: 'host-send', code: 'SESSION_RUNNING' },
      });
      expect(enqueued).toBe(0);
      expect(accepted).toBe(0);
      expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
      expect(readRows(db)).toBeNull();
      expect(readLog(db)).toEqual([]);
    } finally {
      releaseOrcaContextOperation(token);
      db.raw.close();
    }
  });

  it('rejects a fence activated during the asynchronous pre-enqueue restore', async () => {
    const db = database();
    setCurrentDbClient(db.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    const restoreStarted = gate();
    const restoreRelease = gate();
    let enqueued = 0;
    const dispatcher = createDispatcher(coordinator, 'restore-race-client', {
      prepareQueuedMessageEnqueue: async () => {
        restoreStarted.resolve();
        await restoreRelease.promise;
      },
      enqueueQueuedMessage: (sessionId: string, item: AgentInputQueuedMessage) => {
        enqueued += 1;
        coordinator.enqueue(sessionId, item);
      },
    });
    await coordinator.ensureQueueRestored(SESSION_ID);
    const pending = dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(
      params('restore-race-client'),
    );
    await restoreStarted.promise;
    const token = beginOrcaContextOperation(SESSION_ID, 'compact');
    try {
      restoreRelease.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        dispatchOutcome: { kind: 'host-send', code: 'SESSION_RUNNING' },
      });
      await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
      expect(enqueued).toBe(0);
      expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
      expect(readRows(db)).toBeNull();
      expect(readLog(db)).toEqual([]);
    } finally {
      releaseOrcaContextOperation(token);
      db.raw.close();
    }
  });

  it('rejects an interrupt reservation when the fence activates during its awaits', async () => {
    const db = database();
    setCurrentDbClient(db.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    const buildStarted = gate();
    const buildRelease = gate();
    let reserved = 0;
    const dispatcher = createDispatcher(coordinator, 'reserve-race-client', {
      buildCreateOptsForQueuedSession: async () => {
        buildStarted.resolve();
        await buildRelease.promise;
        return {
          agentKind: 'claude-code',
          workingDir: '/tmp/queue-gate',
          model: 'fake',
          permissionMode: 'default',
        };
      },
      reserveNextQueuedMessage: async (
        sessionId: string,
        item: AgentInputQueuedMessage,
      ) => {
        reserved += 1;
        coordinator.enqueue(sessionId, item);
        return true;
      },
    });
    await coordinator.ensureQueueRestored(SESSION_ID);
    const pending = dispatcher.reserveNextOrcaInterAgentMessage(
      params('reserve-race-client'),
    );
    await buildStarted.promise;
    const token = beginOrcaContextOperation(SESSION_ID, 'clear');
    try {
      buildRelease.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        dispatchOutcome: { kind: 'host-send', code: 'SESSION_RUNNING' },
      });
      await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
      expect(reserved).toBe(0);
      expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
      expect(readRows(db)).toBeNull();
      expect(readLog(db)).toEqual([]);
    } finally {
      releaseOrcaContextOperation(token);
      db.raw.close();
    }
  });

  it('rejects an interrupt reservation when the fence activates during async reserve preparation', async () => {
    const db = database();
    setCurrentDbClient(db.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    const prepareStarted = gate();
    const prepareRelease = gate();
    let reserved = 0;
    const dispatcher = createDispatcher(coordinator, 'reserve-prep-race-client', {
      prepareQueuedMessageReserve: async () => {
        prepareStarted.resolve();
        await prepareRelease.promise;
      },
      reserveNextQueuedMessage: async (
        sessionId: string,
        item: AgentInputQueuedMessage,
      ) => {
        reserved += 1;
        coordinator.enqueue(sessionId, item);
        return true;
      },
    });
    await coordinator.ensureQueueRestored(SESSION_ID);
    const pending = dispatcher.reserveNextOrcaInterAgentMessage(
      params('reserve-prep-race-client'),
    );
    await prepareStarted.promise;
    const token = beginOrcaContextOperation(SESSION_ID, 'compact');
    try {
      prepareRelease.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        dispatchOutcome: { kind: 'host-send', code: 'SESSION_RUNNING' },
      });
      await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
      expect(reserved).toBe(0);
      expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
      expect(readRows(db)).toBeNull();
      expect(readLog(db)).toEqual([]);
    } finally {
      releaseOrcaContextOperation(token);
      db.raw.close();
    }
  });

  it('keeps ordinary queue persistence and ordinary /clear working without a fence', async () => {
    const db = database();
    setCurrentDbClient(db.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    const dispatcher = createDispatcher(coordinator, 'normal-client');
    await coordinator.ensureQueueRestored(SESSION_ID);
    expect(await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params('normal-client')))
      .toMatchObject({ ok: true, mode: 'queued' });
    await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
    expect(readRows(db)?.map((item) => item.clientId)).toEqual(['normal-client']);

    coordinator.setExecutionPaused(SESSION_ID, true);
    coordinator.enqueue(SESSION_ID, queued('second'));
    await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
    expect(readRows(db)?.map((item) => item.clientId)).toEqual(['normal-client', 'second']);

    // Ordinary /clear (no Orca owner options) keeps its existing behavior.
    coordinator.clearSession(SESSION_ID, Date.now());
    await awaitAgentInputQueueSnapshotPersistence(SESSION_ID);
    expect(readRows(db)).toBeNull();
    expect(coordinator.getProjection(SESSION_ID).pendingQueue).toEqual([]);
    db.raw.close();
  });

  it('does not delete or overwrite the replacement owner snapshot from a clear projection', async () => {
    const a = database();
    const b = database();
    const bBefore = [queued('owner-B-existing', 'B content')];
    b.raw
      .prepare('INSERT INTO agent_input_queue_snapshots VALUES (?,?,?)')
      .run(SESSION_ID, JSON.stringify(bBefore), 1);
    b.raw.prepare('DELETE FROM changes_log').run();

    setCurrentDbClient(a.client as never, 'synthetic-A');
    const coordinator = createCoordinator();
    await coordinator.ensureQueueRestored(SESSION_ID);
    coordinator.clearSession(SESSION_ID, Date.now());
    // The projection write is chained asynchronously; switch owners before it
    // reaches the real save/delete path.
    setCurrentDbClient(b.client as never, 'synthetic-B');
    await tick();
    await tick();

    expect(readRows(b)).toEqual(bBefore);
    expect(readLog(b)).toEqual([]);
    a.raw.close();
    b.raw.close();
  });
});

const prepareSource = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const prepareAst = ts.createSourceFile('register.ts', prepareSource, ts.ScriptTarget.Latest, true);
let prepareDecl = '';
const visit = (node: ts.Node): void => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'prepareOrcaWorkerContext') {
    prepareDecl = node.getText(prepareAst);
  }
  ts.forEachChild(node, visit);
};
visit(prepareAst);
const prepareCode = ts.transpileModule(`${prepareDecl}\nreturn prepareOrcaWorkerContext;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function runOwnerSwitch(stage: 'commit' | 'close') {
  const a = database();
  const b = database();
  const bBefore = [queued('owner-B-existing', 'B content')];
  b.raw
    .prepare('INSERT INTO agent_input_queue_snapshots VALUES (?,?,?)')
    .run(SESSION_ID, JSON.stringify(bBefore), 1);
  b.raw.prepare('DELETE FROM changes_log').run();

  setCurrentDbClient(b.client as never, 'synthetic-B');
  expect((await loadAgentInputQueueSnapshot(SESSION_ID)).map((item) => item.clientId))
    .toEqual(['owner-B-existing']);

  setCurrentDbClient(a.client as never, 'synthetic-A');
  const origin = getCurrentDbClientSnapshot();
  const guard = () => {
    if (getCurrentDbClientSnapshot() !== origin) throw new Error('owner changed');
  };
  const dbStarted = gate();
  const dbFinish = gate();
  const closeStarted = gate();
  const closeFinish = gate();
  const coordinator = createCoordinator();
  const service = createHostSessionClearService({
    beginRemoteInputClearGate: () => undefined,
    endRemoteInputClearGate: () => undefined,
    captureNativeHistoryClearDependencies: () => ({
      root: '/tmp/queue-gate',
      sessionId: SESSION_ID,
      assertCurrent: guard,
      readState: async () => ({ nativeId: 'old', clearedAt: null }),
    } as never),
    readNativeHistoryForClear: () => null,
    withNativeHistoryClear: async () => {
      throw new Error('unexpected native');
    },
    clearSessionContextInDb: async () => {
      dbStarted.resolve();
      await dbFinish.promise;
    },
    clearInputProjection: (sessionId, boundary) => coordinator.clearSession(sessionId, boundary),
    discardWorkingDirectoryRecovery: () => undefined,
    resetAutomaticRecoveryForExplicitStop: () => undefined,
    invalidateAgentHandoff: () => undefined,
    sealAgentHandoffClearBoundary: () => undefined,
    notifyQueueEmptied: () => undefined,
    clearGoal: () => undefined,
    logError: () => undefined,
  });
  let runtime: Record<string, unknown> | undefined = {
    id: SESSION_ID,
    agentKind: 'claude-code',
    remoteHostId: null,
    isTurnRunning: () => false,
  };
  const bindings = {
    maker: {
      getSession: () => runtime,
      closeSession: async () => {
        const old = runtime;
        closeStarted.resolve();
        await closeFinish.promise;
        if (runtime === old) runtime = undefined;
      },
    },
    hasOrcaWorkerPendingInput: async (sessionId: string) =>
      coordinator.hasPendingQueuedWork(sessionId),
    hostSessionClearHolder: service,
    hostInputClearInFlightSessions: new Set<string>(),
    withRehydrateCloseSuppressed: async (_sessionId: string, fn: () => Promise<void>) => fn(),
    cleanupPendingInteractionsForSession: () => undefined,
  };
  const prepare = new Function(...Object.keys(bindings), prepareCode)(
    ...Object.values(bindings),
  ) as (
    params: { worker: { sessionId: string }; link: object; policy: 'clear' },
    assertCurrent?: () => Promise<void>,
    owner?: unknown,
  ) => Promise<Record<string, unknown>>;

  await coordinator.ensureQueueRestored(SESSION_ID);
  const owner = captureOrcaContextOwner();
  const task = prepare(
    { worker: { sessionId: SESSION_ID }, link: {}, policy: 'clear' },
    async () => guard(),
    owner,
  );
  await dbStarted.promise;
  if (stage === 'commit') {
    setCurrentDbClient(b.client as never, 'synthetic-B');
    dbFinish.resolve();
  } else {
    dbFinish.resolve();
    await closeStarted.promise;
    setCurrentDbClient(b.client as never, 'synthetic-B');
    closeFinish.resolve();
  }
  const result = await task;
  releaseOrcaContextOperation(result.operationToken as symbol);

  expect(result).toMatchObject({ ok: false, applied: 'cleared' });
  expect(result.errorCode).toBe('ABORTED');
  expect(readRows(b)).toEqual(bBefore);
  expect(readLog(b)).toEqual([]);
  a.raw.close();
  b.raw.close();
}

describe('Orca context owner switch', () => {
  it('writes nothing to the replacement owner when the owner changes at the DB boundary', async () => {
    await runOwnerSwitch('commit');
  });

  it('writes nothing to the replacement owner when the owner changes while closing the old runtime', async () => {
    await runOwnerSwitch('close');
  });
});
