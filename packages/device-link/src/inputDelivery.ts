export type InputDeliveryState = 'pending' | 'accepted' | 'removed' | 'unknown';

export interface InputDeliveryReceipt {
  clientId: string;
  state: InputDeliveryState;
}

export interface InputDeliveryProjection {
  inputDeliveryVersion?: 1;
  deliveryReceipts?: InputDeliveryReceipt[];
}

export interface InputDeliveryRemoveProjection {
  inputDeliveryCancelled?: boolean;
}

const INPUT_DELIVERY_STATES = new Set<InputDeliveryState>([
  'pending',
  'accepted',
  'removed',
  'unknown',
]);

export function readInputDeliveryClientIds(options: unknown): string[] | undefined {
  if (!options || typeof options !== 'object' || !('deliveryClientIds' in options)) {
    return undefined;
  }
  const ids = (options as { deliveryClientIds?: unknown }).deliveryClientIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 64 ||
    ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)
  ) {
    throw new Error('deliveryClientIds must contain at most 64 nonempty IDs (256 characters each)');
  }
  return [...new Set(ids as string[])];
}

export function parseInputDeliveryProjection(value: unknown): InputDeliveryProjection | undefined {
  if (!value || typeof value !== 'object') throw new Error('Invalid input delivery projection');
  const projection = value as Record<string, unknown>;
  if (projection.inputDeliveryVersion === undefined && projection.deliveryReceipts === undefined) {
    return undefined;
  }
  if (projection.inputDeliveryVersion !== 1 || !Array.isArray(projection.deliveryReceipts)) {
    throw new Error('Invalid input delivery projection');
  }
  if (projection.deliveryReceipts.length > 64) throw new Error('Invalid input delivery receipts');
  const seen = new Set<string>();
  const deliveryReceipts: InputDeliveryReceipt[] = [];
  for (const raw of projection.deliveryReceipts) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid input delivery receipt');
    const receipt = raw as Record<string, unknown>;
    if (
      typeof receipt.clientId !== 'string' ||
      receipt.clientId.length === 0 ||
      receipt.clientId.length > 256 ||
      typeof receipt.state !== 'string' ||
      !INPUT_DELIVERY_STATES.has(receipt.state as InputDeliveryState) ||
      seen.has(receipt.clientId)
    ) {
      throw new Error('Invalid input delivery receipt');
    }
    seen.add(receipt.clientId);
    deliveryReceipts.push({
      clientId: receipt.clientId,
      state: receipt.state as InputDeliveryState,
    });
  }
  return { inputDeliveryVersion: 1, deliveryReceipts };
}

export function readInputDeliveryCancelled(value: unknown): boolean {
  if (!value || typeof value !== 'object') throw new Error('Invalid input delivery remove response');
  const cancelled = (value as Record<string, unknown>).inputDeliveryCancelled;
  if (cancelled === undefined) return false;
  if (typeof cancelled !== 'boolean') throw new Error('Invalid input delivery cancellation state');
  return cancelled;
}
