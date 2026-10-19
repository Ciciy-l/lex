import { describe, expect, it, vi } from 'vitest';
import { CodexNativeTaskResumeReceipt } from './native-attach-readiness.js';

describe('one genuine original-thread resume receipt', () => {
  it('requires the matching ACK write before input readiness, never a title/descendant receipt', async () => {
    const receipt = new CodexNativeTaskResumeReceipt('owned', () => true);
    const call = { request: { id: 1, method: 'thread/resume' }, signal: new AbortController().signal,
      forward: vi.fn(async () => ({ thread: { id: 'owned' } })) };
    const value = await receipt.forward(call);
    expect(receipt.confirmed).toBe(false);
    receipt.delivered({ id: 2, method: 'thread/resume' }, value);
    expect(receipt.confirmed).toBe(false);
    receipt.delivered(call.request, value); await receipt.ready;
    expect(receipt.confirmed).toBe(true);
    await expect(receipt.forward({ ...call, request: { id: 3, method: 'thread/resume' } })).rejects.toThrow('already');
    expect(call.forward).toHaveBeenCalledOnce();
  });
  it.each(['wrong-id', 'lost-receipt', 'connection-closed'] as const)('keeps %s failed without retrying', async scenario => {
    const receipt = new CodexNativeTaskResumeReceipt('owned', () => true);
    const call = { request: { id: 1, method: 'thread/resume' }, signal: new AbortController().signal,
      forward: vi.fn(async () => {
        if (scenario === 'lost-receipt') throw new Error('lost');
        return { thread: { id: scenario === 'wrong-id' ? 'foreign' : 'owned' } };
      }) };
    if (scenario === 'connection-closed') { await receipt.forward(call); receipt.fail(); }
    else await expect(receipt.forward(call)).rejects.toThrow();
    await expect(receipt.ready).rejects.toThrow('unconfirmed');
    await expect(receipt.forward({ ...call, request: { id: 2, method: 'thread/resume' } })).rejects.toThrow('already');
    expect(receipt.confirmed).toBe(false); expect(call.forward).toHaveBeenCalledOnce();
  });
});
