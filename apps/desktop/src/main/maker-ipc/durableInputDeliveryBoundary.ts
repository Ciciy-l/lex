export interface DurableInputDeliveryProjection {
  pendingQueue: readonly { clientId: string }[];
  steeringQueueClientIds: readonly string[];
}

export interface DurableInputDeliveryBoundaryDeps<Projection extends DurableInputDeliveryProjection> {
  getProjection(sessionId: string): Projection;
  hasKnownClientId(sessionId: string, clientId: string): boolean;
  remove(sessionId: string, clientId: string): Projection;
  persistCancellation(sessionId: string, clientId: string): Promise<boolean>;
  awaitDurableQueueSnapshot(sessionId: string): Promise<void>;
  wasPersisted(sessionId: string, clientId: string): Promise<boolean>;
  hasCancellation(sessionId: string, clientId: string): boolean;
}

export function createDurableInputDeliveryBoundary<Projection extends DurableInputDeliveryProjection>(
  deps: DurableInputDeliveryBoundaryDeps<Projection>,
) {
  const beforeEnqueue = async (sessionId: string, clientId: string, durable: boolean, cleanup: () => Promise<void>): Promise<{
    enqueue: boolean;
    projection?: Projection;
  }> => {
    if (!durable) return { enqueue: true };
    await deps.awaitDurableQueueSnapshot(sessionId);
    const persisted = await deps.wasPersisted(sessionId, clientId);
    if (!persisted && !deps.hasCancellation(sessionId, clientId)) return { enqueue: true };
    await cleanup();
    await deps.awaitDurableQueueSnapshot(sessionId);
    return { enqueue: false, projection: deps.getProjection(sessionId) };
  };

  const tryEnqueue = <Result>(
    sessionId: string,
    clientId: string,
    durable: boolean,
    enqueueNow: () => Result,
  ): { enqueued: true; value: Result } | { enqueued: false; projection: Projection } => {
    if (durable && deps.hasCancellation(sessionId, clientId)) {
      return { enqueued: false, projection: deps.getProjection(sessionId) };
    }
    return { enqueued: true, value: enqueueNow() };
  };

  return {
    async knownClient(sessionId: string, clientId: string, durable: boolean): Promise<Projection | null> {
      if (!deps.hasKnownClientId(sessionId, clientId)) return null;
      if (durable) await deps.awaitDurableQueueSnapshot(sessionId);
      return deps.getProjection(sessionId);
    },

    async remove(sessionId: string, clientId: string, durable: boolean): Promise<{
      projection: Projection;
      inputDeliveryCancelled?: boolean;
    }> {
      const before = deps.getProjection(sessionId);
      if (durable && (
        before.steeringQueueClientIds.includes(clientId)
        || (!before.pendingQueue.some((item) => item.clientId === clientId)
          && deps.hasKnownClientId(sessionId, clientId))
      )) return { projection: before, inputDeliveryCancelled: false };

      const cancellation = durable
        ? deps.persistCancellation(sessionId, clientId)
        : undefined;
      const projection = deps.remove(sessionId, clientId);
      const inputDeliveryCancelled = await cancellation;
      if (durable) await deps.awaitDurableQueueSnapshot(sessionId);
      return durable
        ? { projection, inputDeliveryCancelled: inputDeliveryCancelled === true }
        : { projection };
    },

    beforeEnqueue,

    tryEnqueue,

    async enqueueIfAllowed<Result>(
      sessionId: string,
      clientId: string,
      durable: boolean,
      cleanup: () => Promise<void>,
      enqueueNow: () => Result,
    ): Promise<{ enqueued: true; value: Result } | { enqueued: false; projection: Projection }> {
      if (!durable) return { enqueued: true, value: enqueueNow() };
      const gate = await beforeEnqueue(sessionId, clientId, true, cleanup);
      if (!gate.enqueue) {
        return { enqueued: false, projection: gate.projection! };
      }
      const result = tryEnqueue(sessionId, clientId, true, enqueueNow);
      if (!result.enqueued) {
        await cleanup();
        await deps.awaitDurableQueueSnapshot(sessionId);
      }
      return result;
    },
  };
}
