import { expect, it, vi } from 'vitest';
import { deleteRemoteMessageConfirmed } from '../session/confirmedMessageDeletion';

it.each([
  { sessionId: 'task', clientId: 'selected', clientIds: ['selected', 'paired'] },
  { sessionId: 'task', clientId: 'selected' },
  { sessionId: 'task', clientId: 'selected', clientIds: [] },
])('uses the confirmed group or legacy single acknowledgement: %j', async (ack) => {
  const apply = vi.fn();
  await deleteRemoteMessageConfirmed({ sessionId: 'task', clientId: 'selected', send: async () => ack, isCurrent: () => true, apply });
  expect(apply).toHaveBeenCalledExactlyOnceWith(ack.clientIds ?? ['selected']);
});

it.each([null, {}, { sessionId: 'other', clientId: 'selected' }, { sessionId: 'task', clientId: 'other' },
  { sessionId: 'task', clientId: 'selected', clientIds: [null] }])('does not invent a deletion from an invalid acknowledgement: %j', async (ack) => {
  const apply = vi.fn();
  await expect(deleteRemoteMessageConfirmed({ sessionId: 'task', clientId: 'selected', send: async () => ack, isCurrent: () => true, apply })).rejects.toThrow('acknowledgement');
  expect(apply).not.toHaveBeenCalled();
});

it('rejects a late acknowledgement after an owner/page change without repeating the request', async () => {
  let current = true;
  let resolve!: (value: unknown) => void;
  const send = vi.fn(() => new Promise<unknown>(done => { resolve = done; }));
  const apply = vi.fn();
  const pending = deleteRemoteMessageConfirmed({ sessionId: 'task', clientId: 'selected', send, isCurrent: () => current, apply });
  current = false;
  resolve({ sessionId: 'task', clientId: 'selected' });
  expect(await pending).toBe(false);
  expect(send).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it('does not send from an already stale confirmation', async () => {
  const send = vi.fn();
  expect(await deleteRemoteMessageConfirmed({ sessionId: 'task', clientId: 'selected', send, isCurrent: () => false, apply: vi.fn() })).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
