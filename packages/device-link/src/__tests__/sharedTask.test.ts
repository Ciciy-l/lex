import { describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '../protocol.js';
import {
  authorizeSharedTaskOperation as authorize,
  parseSharedTaskSnapshot as parse,
  sharedTaskTopics,
} from '../sharedTask.js';

const snapshot = () => ({
  sharedTaskId: 'sharedTask-1', sessionId: 'session-1', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  status: 'active', revision: 1,
  guests: [
    { memberId: 'member-a', accountId: 'guest-a', version: 1, deviceIds: ['phone-a', 'desktop-a'] },
    { memberId: 'member-b', accountId: 'guest-b', version: 1, deviceIds: ['phone-b'] },
  ],
});
const guest = { accountId: 'guest-a', deviceId: 'phone-a' };
const owner = { accountId: 'owner', deviceId: 'owner-phone' };

describe('sharedTask authorization and authority decoding', () => {
  it('keeps task subscriptions but removes the full-device list from shared peers', () => {
    expect(sharedTaskTopics(sharedTaskHostPeer('shared', 'desktop'), ['sessions', 'session:task'])).toEqual(['session:task']);
    expect(sharedTaskTopics('my-desktop', ['sessions', 'session:task'])).toEqual(['sessions', 'session:task']);
  });
  it.each(['history.read', 'attachment.read', 'attachment.upload', 'input.send', 'agent.configure', 'agent.stop', 'approval.resolve'])(
    'lets an approved guest %s without treating them as the owner', (operation) => {
      expect(authorize(parse(snapshot()), guest, 'session-1', operation)).toMatchObject({ allowed: true, role: 'guest', memberId: 'member-a' });
    },
  );
  it.each(['permission.configure', 'workdir.configure', 'plugins.configure',
    'history.delete', 'session.archive', 'session.export', 'session.fork', 'background.create', 'schedule.create', 'sharedTask.manage'])(
    'requires the owner for %s', (operation) => {
      expect(authorize(parse(snapshot()), guest, 'session-1', operation)).toEqual({ allowed: false, reason: 'owner-required' });
      expect(authorize(parse(snapshot()), owner, 'session-1', operation)).toMatchObject({ allowed: true, role: 'host' });
    },
  );
  it('does not authorize another task, device, account, or unknown operation', () => {
    const state = parse(snapshot());
    expect(authorize(state, guest, 'session-2', 'history.read').allowed).toBe(false);
    expect(authorize(state, { ...guest, deviceId: 'phone-b' }, 'session-1', 'history.read').allowed).toBe(false);
    expect(authorize(state, { ...guest, accountId: 'stranger' }, 'session-1', 'history.read').allowed).toBe(false);
    expect(authorize(state, owner, 'session-1', '__proto__')).toEqual({ allowed: false, reason: 'unknown-operation' });
  });
  it('rejects duplicate accounts, members, devices, and oversized guest snapshots', () => {
    for (const patch of [{ accountId: 'owner' }, { accountId: 'guest-a' }, { memberId: 'member-a' }, { deviceIds: ['phone-b', 'phone-b'] }]) {
      const input = snapshot();
      input.guests[1] = { ...input.guests[1], ...patch };
      expect(() => parse(input)).toThrow();
    }
    const input = snapshot();
    input.guests.push(
      { memberId: 'member-c', accountId: 'guest-c', version: 1, deviceIds: [] },
      { memberId: 'member-d', accountId: 'guest-d', version: 1, deviceIds: [] },
    );
    expect(() => parse(input)).toThrow();
  });
  it('requires pending same-owner queue items for edit and withdraw', () => {
    const state = parse(snapshot());
    const item = { sessionId: 'session-1', authorAccountId: 'guest-a', state: 'pending' as const };
    expect(authorize(state, guest, 'session-1', 'input.edit', item).allowed).toBe(true);
    expect(authorize(state, owner, 'session-1', 'input.withdraw', { ...item, state: 'accepted' }).allowed).toBe(false);
    expect(authorize(state, guest, 'session-1', 'input.edit', { ...item, authorAccountId: 'guest-b' })).toEqual({ allowed: false, reason: 'queue-item-not-owned' });
  });
});
