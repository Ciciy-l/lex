import { describe, expect, it } from 'vitest';
import {
  parseInputDeliveryProjection,
  readInputDeliveryCancelled,
  readInputDeliveryClientIds,
} from '../inputDelivery.js';

describe('durable input delivery extension', () => {
  it('leaves legacy projections on the unknown-delivery path', () => {
    expect(parseInputDeliveryProjection({ sessionId: 's1', pendingQueue: [] })).toBeUndefined();
  });

  it('parses bounded receipts without changing their client identity', () => {
    expect(parseInputDeliveryProjection({
      inputDeliveryVersion: 1,
      deliveryReceipts: [
        { clientId: 'queued-1', state: 'pending' },
        { clientId: 'accepted-1', state: 'accepted' },
        { clientId: 'removed-1', state: 'removed' },
        { clientId: 'unknown-1', state: 'unknown' },
      ],
    })).toEqual({
      inputDeliveryVersion: 1,
      deliveryReceipts: [
        { clientId: 'queued-1', state: 'pending' },
        { clientId: 'accepted-1', state: 'accepted' },
        { clientId: 'removed-1', state: 'removed' },
        { clientId: 'unknown-1', state: 'unknown' },
      ],
    });
  });

  it('validates request IDs and de-duplicates them within the bounded payload', () => {
    expect(readInputDeliveryClientIds({ deliveryClientIds: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
    expect(readInputDeliveryClientIds({ deliveryClientIds: [] })).toEqual([]);
    expect(readInputDeliveryClientIds({})).toBeUndefined();
    expect(() => readInputDeliveryClientIds({ deliveryClientIds: [''] })).toThrow();
    expect(() => readInputDeliveryClientIds({ deliveryClientIds: ['x'.repeat(257)] })).toThrow();
    expect(() => readInputDeliveryClientIds({ deliveryClientIds: Array(65).fill('x') })).toThrow();
  });

  it('reads optional cancellation ACKs and fails closed on malformed values', () => {
    expect(readInputDeliveryCancelled({ inputDeliveryCancelled: true })).toBe(true);
    expect(readInputDeliveryCancelled({ inputDeliveryCancelled: false })).toBe(false);
    expect(readInputDeliveryCancelled({ sessionId: 'legacy' })).toBe(false);
    expect(() => readInputDeliveryCancelled({ inputDeliveryCancelled: 'true' })).toThrow();
    expect(() => readInputDeliveryCancelled(null)).toThrow();
  });

  it('fails closed on partial, duplicate, malformed or unknown receipt versions', () => {
    expect(() => parseInputDeliveryProjection({ deliveryReceipts: [] })).toThrow();
    expect(() => parseInputDeliveryProjection({ inputDeliveryVersion: 2, deliveryReceipts: [] })).toThrow();
    expect(() => parseInputDeliveryProjection({
      inputDeliveryVersion: 1,
      deliveryReceipts: [{ clientId: 'same', state: 'pending' }, { clientId: 'same', state: 'removed' }],
    })).toThrow();
    expect(() => parseInputDeliveryProjection({
      inputDeliveryVersion: 1,
      deliveryReceipts: [{ clientId: 'bad', state: 'sending' }],
    })).toThrow();
  });
});
