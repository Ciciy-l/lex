import { afterEach, describe, expect, it } from 'vitest';
import { redirectSystemPath } from '../../app/+native-intent';
import { clearSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';

afterEach(clearSharedTaskInvitationIntent);

describe('native OAuth routing', () => {
  it.each(['cindy://auth?code=fixture', 'cindycn://auth?error=access_denied', '/auth?state=fixture'])(
    'preserves the current login page on a warm callback and opens the root on cold start (%s)', path => {
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
      expect(redirectSystemPath({ path, initial: true })).toBe('/');
    },
  );
  it('continues to route invitations and other paths independently of OAuth', () => {
    const invitation = 'A'.repeat(43);
    const path = `cindy://shared-session?invitation=${invitation}&server=https%3A%2F%2Frelay.example.test`;
    expect(redirectSystemPath({ path, initial: false })).toBe('/shared-session');
    expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe(invitation);
    expect(redirectSystemPath({ path: '/devices', initial: false })).toBe('/devices');
    expect(redirectSystemPath({ path: '/shared-session', initial: true })).toBe('/shared-session');
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  });
});
