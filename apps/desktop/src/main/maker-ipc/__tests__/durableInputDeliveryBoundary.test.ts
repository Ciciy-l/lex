import { describe, expect, it, vi } from 'vitest';
import {
  parseInputDeliveryProjection,
  readInputDeliveryCancelled,
  readInputDeliveryClientIds,
} from '@cindy/device-link';
import { createDurableInputDeliveryBoundary } from '../durableInputDeliveryBoundary.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type State = 'pending' | 'accepted' | 'removed' | 'unknown';

function fixture(
  initialOwner = 'owner-a',
  options: { wasPersisted?: (sessionId: string, clientId: string) => Promise<boolean> } = {},
) {
  let owner = initialOwner;
  const pending = new Map<string, Set<string>>();
  const stored = new Map<string, 'user' | 'message_tombstone'>();
  const steering = new Map<string, Set<string>>();
  const key = (sessionId: string, clientId: string) => owner + '/' + sessionId + '/' + clientId;
  const sessionPending = (sessionId: string) => pending.get(owner + '/' + sessionId) ?? new Set<string>();
  const projection = (sessionId: string) => ({
    sessionId,
    pendingQueue: [...sessionPending(sessionId)].map((clientId) => ({ clientId })),
    steeringQueueClientIds: [...(steering.get(owner + '/' + sessionId) ?? [])],
  });
  const persistCancellation = vi.fn(async (sessionId: string, clientId: string) => {
    const rowKey = key(sessionId, clientId);
    if (!stored.has(rowKey)) stored.set(rowKey, 'message_tombstone');
    return stored.get(rowKey) === 'message_tombstone';
  });
  const enqueue = vi.fn((sessionId: string, clientId: string) => {
    const queue = sessionPending(sessionId);
    queue.add(clientId);
    pending.set(owner + '/' + sessionId, queue);
    return projection(sessionId);
  });
  const boundary = createDurableInputDeliveryBoundary({
    getProjection: projection,
    hasKnownClientId: (sessionId: string, clientId: string) => (
      sessionPending(sessionId).has(clientId)
      || stored.has(key(sessionId, clientId))
    ),
    remove: (sessionId: string, clientId: string) => {
      sessionPending(sessionId).delete(clientId);
      return projection(sessionId);
    },
    persistCancellation,
    awaitDurableQueueSnapshot: async () => undefined,
    wasPersisted: options.wasPersisted ?? (async (sessionId: string, clientId: string) => stored.has(key(sessionId, clientId))),
    hasCancellation: (sessionId: string, clientId: string) => stored.get(key(sessionId, clientId)) === 'message_tombstone',
  });
  const receipt = (sessionId: string, clientId: string): State => {
    const row = stored.get(key(sessionId, clientId));
    if (row === 'message_tombstone') return 'removed';
    if (row === 'user') return 'accepted';
    return sessionPending(sessionId).has(clientId) ? 'pending' : 'unknown';
  };
  return {
    boundary,
    enqueue,
    persistCancellation,
    receipt,
    setOwner(value: string) { owner = value; },
    accept(sessionId: string, clientId: string) {
      sessionPending(sessionId).delete(clientId);
      stored.set(key(sessionId, clientId), 'user');
    },
  };
}

describe('Desktop durable input IPC boundary behavior', () => {
  it('seals cancellation while attachment materialization and reference hydration are delayed', async () => {
    const harness = fixture();
    const materialized = deferred<void>();
    const hydrated = deferred<void>();
    const cleanup = vi.fn(async () => undefined);
    const dispatch = async () => {
      await materialized.promise;
      await hydrated.promise;
      const gate = await harness.boundary.beforeEnqueue('session-a', 'client-a', true, cleanup);
      if (!gate.enqueue) return gate.projection;
      return harness.enqueue('session-a', 'client-a');
    };
    const lateEnqueue = dispatch();

    const removed = await harness.boundary.remove('session-a', 'client-a', true);
    materialized.resolve();
    hydrated.resolve();
    const response = await lateEnqueue;

    expect(removed.inputDeliveryCancelled).toBe(true);
    expect(response?.pendingQueue).toEqual([]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.receipt('session-a', 'client-a')).toBe('removed');
  });

  it('fences a synchronous remove after the pre-enqueue check but before its await continuation', async () => {
    const persistedRead = deferred<boolean>();
    const persistedReadsStarted = deferred<void>();
    let persistedReadCount = 0;
    const harness = fixture('owner-a', {
      wasPersisted: () => {
        persistedReadCount += 1;
        if (persistedReadCount === 2) persistedReadsStarted.resolve(undefined);
        return persistedRead.promise;
      },
    });
    const cleanup = vi.fn(async () => undefined);
    const attachmentOwners = new Set(['materialization-a', 'materialization-b']);
    const cleanupAttachmentOwner = vi.fn(async (ownerId: string) => {
      attachmentOwners.delete(ownerId);
    });
    const enqueue = (ownerId: string) => harness.boundary.enqueueIfAllowed(
      'session-a',
      'client-a',
      true,
      async () => {
        await cleanup();
        await cleanupAttachmentOwner(ownerId);
      },
      () => harness.enqueue('session-a', 'client-a'),
    );
    const firstDelivery = enqueue('materialization-a');
    const secondDelivery = enqueue('materialization-b');
    await persistedReadsStarted.promise;

    const removed = deferred<Awaited<ReturnType<typeof harness.boundary.remove>>>();
    persistedRead.resolve(false);
    queueMicrotask(() => {
      void harness.boundary.remove('session-a', 'client-a', true).then(removed.resolve);
    });

    const [firstAttempt, secondAttempt] = await Promise.all([firstDelivery, secondDelivery]);
    const removeResult = await removed.promise;

    expect(firstAttempt).toMatchObject({ enqueued: false, projection: { pendingQueue: [] } });
    expect(secondAttempt).toMatchObject({ enqueued: false, projection: { pendingQueue: [] } });
    expect(removeResult.inputDeliveryCancelled).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanupAttachmentOwner).toHaveBeenCalledTimes(2);
    expect(attachmentOwners.size).toBe(0);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.receipt('session-a', 'client-a')).toBe('removed');
  });

  it('does not acknowledge a remove until the tombstone persistence promise resolves', async () => {
    const gate = deferred<boolean>();
    let removedSynchronously = false;
    const boundary = createDurableInputDeliveryBoundary({
      getProjection: (sessionId: string) => ({ sessionId, pendingQueue: [], steeringQueueClientIds: [] }),
      hasKnownClientId: () => false,
      remove: (sessionId: string) => {
        removedSynchronously = true;
        return { sessionId, pendingQueue: [], steeringQueueClientIds: [] };
      },
      persistCancellation: () => gate.promise,
      awaitDurableQueueSnapshot: async () => undefined,
      wasPersisted: async () => false,
      hasCancellation: () => true,
    });
    const resultPromise = boundary.remove('session-a', 'client-a', true);
    let acknowledged = false;
    void resultPromise.then(() => { acknowledged = true; });
    await Promise.resolve();

    expect(removedSynchronously).toBe(true);
    expect(acknowledged).toBe(false);
    gate.resolve(true);
    await expect(resultPromise).resolves.toMatchObject({ inputDeliveryCancelled: true });
  });

  it.each(['pending', 'accepted'] as const)('does not enqueue a second time after a lost ACK when the duplicate is %s', async (state) => {
    const harness = fixture();
    harness.enqueue('session-a', 'client-a');
    if (state === 'accepted') harness.accept('session-a', 'client-a');

    const known = state === 'pending'
      ? await harness.boundary.knownClient('session-a', 'client-a', true)
      : null;
    const gate = state === 'accepted'
      ? await harness.boundary.beforeEnqueue('session-a', 'client-a', true, async () => undefined)
      : null;

    if (state === 'pending') expect(known?.sessionId).toBe('session-a');
    else expect(gate?.enqueue).toBe(false);
    expect(harness.receipt('session-a', 'client-a')).toBe(state);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps a remove tombstone authoritative across a known-client resend', async () => {
    const harness = fixture();
    harness.enqueue('session-a', 'client-a');

    const duplicateProjection = harness.boundary.knownClient('session-a', 'client-a', true);
    const removeResult = harness.boundary.remove('session-a', 'client-a', true);
    const [duplicate, removed] = await Promise.all([duplicateProjection, removeResult]);
    const lateRetry = await harness.boundary.enqueueIfAllowed(
      'session-a',
      'client-a',
      true,
      async () => undefined,
      () => harness.enqueue('session-a', 'client-a'),
    );

    expect(duplicate?.pendingQueue).toEqual([]);
    expect(removed.inputDeliveryCancelled).toBe(true);
    expect(lateRetry.enqueued).toBe(false);
    expect(harness.receipt('session-a', 'client-a')).toBe('removed');
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it('keeps legacy invocations on their prior projection/remove path without a durable receipt', async () => {
    const harness = fixture();
    const cleanup = vi.fn(async () => undefined);
    const gate = await harness.boundary.beforeEnqueue('session-legacy', 'client-legacy', false, cleanup);
    const removed = await harness.boundary.remove('session-legacy', 'client-legacy', false);

    expect(gate).toEqual({ enqueue: true });
    expect(removed).not.toHaveProperty('inputDeliveryCancelled');
    expect(harness.persistCancellation).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('scopes cancellation by session and database owner, including after an owner epoch switch', async () => {
    const harness = fixture('owner-a');
    await harness.boundary.remove('session-a', 'same-client', true);
    expect(harness.receipt('session-a', 'same-client')).toBe('removed');
    expect(harness.receipt('session-b', 'same-client')).toBe('unknown');

    harness.setOwner('owner-b');
    const gate = await harness.boundary.beforeEnqueue('session-a', 'same-client', true, async () => undefined);
    expect(gate.enqueue).toBe(true);
    expect(harness.receipt('session-a', 'same-client')).toBe('unknown');

    harness.setOwner('owner-a');
    expect(harness.receipt('session-a', 'same-client')).toBe('removed');
  });

  it('uses the same bounded valid/invalid wire fixtures as the device-link parser', () => {
    const ids = readInputDeliveryClientIds({ deliveryClientIds: ['same', 'same', 'second'] });
    const serverProjection = {
      inputDeliveryVersion: 1,
      deliveryReceipts: [
        { clientId: ids![0], state: 'pending' },
        { clientId: ids![1], state: 'removed' },
      ],
    };

    expect(ids).toEqual(['same', 'second']);
    expect(parseInputDeliveryProjection(serverProjection)).toEqual(serverProjection);
    expect(readInputDeliveryCancelled({ sessionId: 'legacy-remove-response' })).toBe(false);
    expect(readInputDeliveryCancelled({ ...serverProjection, inputDeliveryCancelled: true })).toBe(true);
    expect(() => readInputDeliveryClientIds({ deliveryClientIds: Array(65).fill('x') })).toThrow();
    expect(() => parseInputDeliveryProjection({
      inputDeliveryVersion: 2,
      deliveryReceipts: [{ clientId: 'bad', state: 'retry' }],
    })).toThrow();
  });

  it('register.ts routes durable enqueue through the synchronous cancellation fence', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const boundaryStart = source.indexOf('await durableInputDeliveryBoundary.enqueueIfAllowed(');
    const coordinatorEnqueue = source.indexOf('const enqueueNow = () => inputCoordinator.enqueue(sid, queued, {');
    const persistedResend = source.indexOf('if (await remoteInputClientIdWasPersisted(sid, parsed.clientId)) {');
    const removeHandler = source.indexOf('const result = await durableInputDeliveryBoundary.remove(sid, cid, durable);');
    const knownHandler = source.indexOf('durableInputDeliveryBoundary.knownClient(');
    const cancellationAck = source.indexOf('inputDeliveryCancelled: result.inputDeliveryCancelled === true');
    const helper = await readFile(new URL('../durableInputDeliveryBoundary.ts', import.meta.url), 'utf8');
    const finalFence = helper.indexOf('if (durable && deps.hasCancellation(sessionId, clientId))');
    const enqueueCallback = helper.indexOf('return { enqueued: true, value: enqueueNow() };', finalFence);

    expect(boundaryStart).toBeGreaterThan(source.indexOf('const commitAutoTitle = await prepareDeviceLinkAutoTitle(sid, queued);'));
    expect(coordinatorEnqueue).toBeGreaterThan(-1);
    expect(boundaryStart).toBeGreaterThan(coordinatorEnqueue);
    expect(persistedResend).toBeGreaterThan(-1);
    expect(persistedResend).toBeLessThan(source.indexOf('const knownClientProjection ='));
    expect(removeHandler).toBeGreaterThan(-1);
    expect(knownHandler).toBeGreaterThan(-1);
    expect(cancellationAck).toBeGreaterThan(removeHandler);
    expect(finalFence).toBeGreaterThan(-1);
    expect(enqueueCallback).toBeGreaterThan(finalFence);
    expect(helper.slice(finalFence, enqueueCallback)).not.toContain('await');
  });
});
