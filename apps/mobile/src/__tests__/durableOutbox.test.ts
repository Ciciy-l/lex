import { describe, expect, it, vi } from 'vitest';
import { buildQueuedTextMessage } from '@/session/inputProjection';
import { buildOutboxItem } from '@/session/sessionOutbox';
import type { RemoteSession } from '@/session/types';
import {
  createDurableOutbox,
  type DurableOutboxRecord,
  type OutboxStorage,
} from '../session/durableOutbox';
import {
  createDurableOutboxDelivery,
  type DeliveryProjection,
  type DurableOutboxDeliveryDeps,
} from '../session/durableOutboxDelivery';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryStorage implements OutboxStorage {
  private readonly values = new Map<string, string>();

  async getAllKeys(): Promise<readonly string[]> {
    return [...this.values.keys()];
  }

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function makeRecord(overrides: Partial<Pick<DurableOutboxRecord, 'accountId' | 'deviceId'>> & {
  sessionId?: string;
  clientId?: string;
  state?: DurableOutboxRecord['state'];
  enqueueStarted?: boolean;
  prepared?: DurableOutboxRecord['prepared'];
  retrySafe?: boolean;
  cancelRequested?: boolean;
} = {}): DurableOutboxRecord {
  const sessionId = overrides.sessionId ?? 'session-1';
  const clientId = overrides.clientId ?? 'client-1';
  const item = buildOutboxItem({
    clientId,
    sessionId,
    text: 'hello',
    permissionModeAtSend: 'ask',
    readyAttachments: [],
    readyPreviews: [],
    claimedUploads: [],
  });
  return {
    version: 1,
    accountId: overrides.accountId ?? 'realm:user-a',
    deviceId: overrides.deviceId ?? 'desktop-1',
    item,
    createdAt: 100,
    state: overrides.state ?? 'queued',
    uploads: [],
    ...(overrides.enqueueStarted !== undefined ? { enqueueStarted: overrides.enqueueStarted } : {}),
    ...(overrides.prepared ? { prepared: overrides.prepared } : {}),
    ...(overrides.retrySafe !== undefined ? { retrySafe: overrides.retrySafe } : {}),
    ...(overrides.cancelRequested ? { cancelRequested: true } : {}),
  };
}

function messageFor(record: DurableOutboxRecord): NonNullable<DurableOutboxRecord['prepared']> {
  const session: RemoteSession = {
    id: record.item.sessionId,
    userId: 'user-a',
    title: 'Test',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'test-model',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'pi',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return buildQueuedTextMessage(session, record.item.text, new Date(record.createdAt), record.item.clientId);
}

function deliveryProjection(
  record: DurableOutboxRecord,
  receiptState?: 'pending' | 'accepted' | 'removed' | 'unknown',
): DeliveryProjection {
  return {
    sessionId: record.item.sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    ...(receiptState !== undefined
      ? {
          inputDeliveryVersion: 1 as const,
          deliveryReceipts: [{ clientId: record.item.clientId, state: receiptState }],
        }
      : {}),
  };
}

function makeDelivery(
  store: ReturnType<typeof createDurableOutbox>,
  overrides: Partial<DurableOutboxDeliveryDeps> = {},
) {
  const defaults: DurableOutboxDeliveryDeps = {
    store,
    isCurrent: () => true,
    canRun: () => true,
    projection: async (record) => deliveryProjection(record),
    session: async () => null,
    prepare: async (record) => messageFor(record),
    upload: async () => { throw new Error('unexpected upload'); },
    enqueue: async (record) => deliveryProjection(record),
    cancel: async () => false,
    history: async () => false,
    applyProjection: () => undefined,
    cleanup: async () => undefined,
    discardUploads: () => undefined,
    retryable: () => false,
    describe: (error) => error instanceof Error ? error.message : String(error),
    confirmationMessage: 'DELIVERY_CONFIRMATION_REQUIRED',
    clearedMessage: 'TASK_CLEARED',
  };
  return createDurableOutboxDelivery({ ...defaults, ...overrides });
}

describe('durable mobile outbox', () => {
  it('isolates persisted records by account, desktop, session, and client ID', async () => {
    const store = createDurableOutbox(new MemoryStorage());
    await store.activate('realm:user-a');
    await store.add(makeRecord({ clientId: 'same-client', deviceId: 'desktop-a', sessionId: 'session-a' }));
    await store.add(makeRecord({ clientId: 'same-client', deviceId: 'desktop-b', sessionId: 'session-a' }));
    await store.add(makeRecord({ clientId: 'same-client', deviceId: 'desktop-a', sessionId: 'session-b' }));
    await store.add(makeRecord({ clientId: 'other-client', deviceId: 'desktop-a', sessionId: 'session-a' }));

    await store.activate('realm:user-b');
    expect(store.getSnapshot()).toEqual([]);
    await store.activate('realm:user-a');
    expect(store.getSnapshot().map((record) => [record.deviceId, record.item.sessionId, record.item.clientId]))
      .toEqual([
        ['desktop-a', 'session-a', 'same-client'],
        ['desktop-b', 'session-a', 'same-client'],
        ['desktop-a', 'session-b', 'same-client'],
        ['desktop-a', 'session-a', 'other-client'],
      ]);
  });

  it('keeps an outgoing account write on disk but never publishes it into the new account snapshot', async () => {
    const storage = new MemoryStorage();
    const writeGate = deferred<void>();
    const writeStarted = deferred<void>();
    const originalSetItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementationOnce(async (key, value) => {
      writeStarted.resolve();
      await writeGate.promise;
      await originalSetItem(key, value);
    });
    const store = createDurableOutbox(storage);
    await store.activate('realm:user-a');
    const record = makeRecord({ accountId: 'realm:user-a' });
    const add = store.add(record);
    await writeStarted.promise;
    const switchOwner = store.activate('realm:user-b');

    writeGate.resolve();
    await add;
    await switchOwner;
    expect(store.getSnapshot()).toEqual([]);
    await store.activate('realm:user-a');
    expect(store.getSnapshot().map((item) => item.item.clientId)).toEqual(['client-1']);
  });

  it('reconciles a lost enqueue ACK from a durable receipt after reactivation without sending twice', async () => {
    const store = createDurableOutbox(new MemoryStorage());
    const record = makeRecord();
    await store.activate(record.accountId);
    await store.add(record);
    let accepted = false;
    let projectionCount = 0;
    const enqueue = vi.fn(async () => {
      accepted = true;
      throw new Error('ack lost');
    });
    const onAccepted = vi.fn(async () => undefined);
    const first = makeDelivery(store, {
      projection: async (current) => {
        projectionCount += 1;
        return projectionCount === 1
          ? deliveryProjection(current, 'unknown')
          : deliveryProjection(current, accepted ? 'pending' : 'unknown');
      },
      enqueue,
      accepted: onAccepted,
    });

    await first.run();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'confirming', enqueueStarted: true });

    await store.activate('realm:other-user');
    await store.activate(record.accountId);
    const recovered = makeDelivery(store, {
      projection: async (current) => deliveryProjection(current, accepted ? 'pending' : 'unknown'),
      enqueue,
      accepted: onAccepted,
    });
    await recovered.run();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned', retrySafe: true });
    expect(onAccepted).toHaveBeenCalledTimes(1);

    recovered.wake();
    await recovered.run();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain send visible and never re-enqueues when the Desktop lacks durable receipts', async () => {
    const store = createDurableOutbox(new MemoryStorage());
    const record = makeRecord();
    await store.activate(record.accountId);
    await store.add(record);
    const enqueue = vi.fn(async (_record: DurableOutboxRecord) => { throw new Error('ack lost'); });
    const delivery = makeDelivery(store, { enqueue });

    await delivery.run();
    delivery.wake();
    await delivery.run();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      state: 'failed',
      error: 'DELIVERY_CONFIRMATION_REQUIRED',
      enqueueStarted: true,
    });
  });

  it('preserves FIFO when the first record is still uncertain after a restart', async () => {
    const store = createDurableOutbox(new MemoryStorage());
    const first = makeRecord({ clientId: 'first' });
    const second = makeRecord({ clientId: 'second' });
    await store.activate(first.accountId);
    await store.add(first);
    await store.add(second);
    const enqueue = vi.fn(async (_record: DurableOutboxRecord) => { throw new Error('ack lost'); });
    const delivery = makeDelivery(store, { enqueue });

    await delivery.run();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].item.clientId).toBe('first');
    expect(store.getSnapshot().map((record) => record.item.clientId)).toEqual(['first', 'second']);
  });

  it('waits for a durable cancellation receipt before deleting an uncertain send', async () => {
    const store = createDurableOutbox(new MemoryStorage());
    const prepared = messageFor(makeRecord());
    const record = makeRecord({
      state: 'confirming',
      enqueueStarted: true,
      prepared: { ...prepared, durableDelivery: true },
      retrySafe: true,
      cancelRequested: true,
    });
    await store.activate(record.accountId);
    await store.add(record);
    const cleanup = vi.fn(async (_record: DurableOutboxRecord, cancelled: boolean) => {
      expect(cancelled).toBe(true);
    });
    const cancel = vi.fn(async () => true);
    const enqueue = vi.fn();
    const delivery = makeDelivery(store, {
      projection: async (current) => deliveryProjection(current, 'pending'),
      cancel,
      enqueue,
      cleanup,
    });

    await delivery.run();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual([]);
  });

  it('settles a persisted user row after history confirms it without creating another enqueue', async () => {
    const store = createDurableOutbox(new MemoryStorage());
    const record = makeRecord({ state: 'host-owned', retrySafe: true, enqueueStarted: true });
    await store.activate(record.accountId);
    await store.add(record);
    const enqueue = vi.fn(async (_record: DurableOutboxRecord) => deliveryProjection(_record));
    const cleanup = vi.fn(async (_record: DurableOutboxRecord, cancelled: boolean) => {
      expect(cancelled).toBe(false);
    });
    const delivery = makeDelivery(store, {
      projection: async (current) => deliveryProjection(current, 'accepted'),
      history: async () => true,
      enqueue,
      cleanup,
    });

    await delivery.run();

    expect(enqueue).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual([]);
  });
});
