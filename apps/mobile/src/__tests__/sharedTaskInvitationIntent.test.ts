import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSharedTaskInvitationIntent,
  confirmClipboardSharedTaskInvitation,
  getPendingSharedTaskInvitationIntent,
  receiveSharedTaskInvitationIntent,
} from '@/device-link/sharedTaskInvitationIntent';
import { __testing as ownerTesting, setMobileAuthOwner } from '@/auth/authOwnerGeneration';

const token = 'A'.repeat(43);
const server = 'https://relay.example.test';
const url = `cindy://shared-session?invitation=${token}&server=${encodeURIComponent(server)}`;

beforeEach(() => {
  vi.useFakeTimers();
  ownerTesting.reset();
  clearSharedTaskInvitationIntent();
});
afterEach(() => {
  clearSharedTaskInvitationIntent();
  ownerTesting.reset();
  vi.useRealTimers();
});

describe('mobile shared-task invitation handoff', () => {
  it('keeps a link through first login but retires it on an account switch', () => {
    expect(receiveSharedTaskInvitationIntent(url)).toBe(true);
    expect(getPendingSharedTaskInvitationIntent()?.source).toBe('link');
    setMobileAuthOwner('first-account');
    expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe(token);
    setMobileAuthOwner('second-account');
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });

  it('requires the visible clipboard offer id before promoting it to a link handoff', () => {
    setMobileAuthOwner('account');
    expect(receiveSharedTaskInvitationIntent(url, 'clipboard')).toBe(true);
    const visible = getPendingSharedTaskInvitationIntent();
    expect(visible?.source).toBe('clipboard');
    confirmClipboardSharedTaskInvitation(visible!.id + 1);
    expect(getPendingSharedTaskInvitationIntent()?.source).toBe('clipboard');
    confirmClipboardSharedTaskInvitation(visible!.id);
    const confirmed = getPendingSharedTaskInvitationIntent();
    expect(confirmed?.source).toBe('link');
    expect(confirmed?.id).not.toBe(visible!.id);
  });

  it('retires a bound clipboard offer on logout before confirmation', () => {
    setMobileAuthOwner('account');
    expect(receiveSharedTaskInvitationIntent(url, 'clipboard')).toBe(true);
    const visible = getPendingSharedTaskInvitationIntent();
    setMobileAuthOwner(null);
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    confirmClipboardSharedTaskInvitation(visible!.id);
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });

  it('does not let an old clipboard confirmation promote under a new account', () => {
    setMobileAuthOwner('first-account');
    expect(receiveSharedTaskInvitationIntent(url, 'clipboard')).toBe(true);
    const visible = getPendingSharedTaskInvitationIntent();
    setMobileAuthOwner('second-account');
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    confirmClipboardSharedTaskInvitation(visible!.id);
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });

  it('expires memory-only links and does not accept malformed input', () => {
    expect(receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=bad')).toBe(false);
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    expect(receiveSharedTaskInvitationIntent(url)).toBe(true);
    vi.advanceTimersByTime(15 * 60_000);
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });
});
