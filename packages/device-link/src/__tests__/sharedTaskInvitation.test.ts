import { describe, expect, it } from 'vitest';
import {
  buildSharedTaskInvitationLink,
  isSharedTaskInvitation,
  parseSharedTaskInvitation,
  parseSharedTaskInvitationIntent,
  sharedTaskAccountName,
} from '../sharedTaskInvitation.js';

const token = 'A'.repeat(43);
const endpoint = 'https://api.example.test/device-link';

describe('shared-task invitations', () => {
  it('keeps invitation secrets in the fragment and enforces the configured endpoint', () => {
    const link = buildSharedTaskInvitationLink(token, endpoint);
    expect(link).toBe(`${endpoint}/shared-task/join#${token}`);
    expect(parseSharedTaskInvitation(link, endpoint)).toEqual({ ok: true, invitation: token });
    expect(parseSharedTaskInvitation(token, endpoint)).toEqual({ ok: true, invitation: token });
    expect(parseSharedTaskInvitation(link, 'https://other.example.test/device-link')).toEqual({
      ok: false, reason: 'different-server',
    });
    expect(link).not.toContain('?');
  });

  it('rejects query-token, malformed, duplicate, and cross-server links', () => {
    expect(parseSharedTaskInvitation(`${endpoint}/shared-task/join?token=${token}`, endpoint).ok).toBe(false);
    expect(parseSharedTaskInvitation(`${endpoint}/shared-task/join#${token}#${token}`, endpoint).ok).toBe(false);
    expect(parseSharedTaskInvitation(`${endpoint}/shared-task/join#${token.slice(1)}`, endpoint).ok).toBe(false);
    expect(parseSharedTaskInvitation(`${endpoint}/shared-task/join#${token}`, `${endpoint}/nested`)).toEqual({
      ok: false, reason: 'different-server',
    });
    expect(isSharedTaskInvitation(token)).toBe(true);
    expect(isSharedTaskInvitation(`${token}=`)).toBe(false);
  });

  it('extracts one invitation from titled text but rejects two candidates and fragment hints', () => {
    const link = buildSharedTaskInvitationLink(token, endpoint);
    expect(parseSharedTaskInvitation(`Join the task (see https://docs.example.test/)\n${link}\nThanks`, endpoint))
      .toEqual({ ok: true, invitation: token });
    expect(parseSharedTaskInvitation(`${link}\n${link}`, endpoint)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSharedTaskInvitation(`${link}?app=cindycn`, endpoint)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSharedTaskInvitation(`${link}#extra`, endpoint)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts only the registered Lex schemes with explicit endpoint matching', () => {
    expect(parseSharedTaskInvitationIntent(`cindy://shared-task/join?invitation=${token}&server=${encodeURIComponent(endpoint)}`))
      .toEqual({ invitation: token, server: endpoint });
    expect(parseSharedTaskInvitationIntent(`xdt-maker://shared-task/join?invitation=${token}&server=${encodeURIComponent(endpoint)}`))
      .toEqual({ invitation: token, server: endpoint });
    expect(parseSharedTaskInvitationIntent(`cindycn://shared-task/join?invitation=${token}&server=${encodeURIComponent(endpoint)}`)).toBeNull();
    expect(parseSharedTaskInvitationIntent(`cindy://shared-task/join?invitation=${token}&server=${encodeURIComponent(endpoint)}&extra=1`)).toBeNull();
  });

  it('bounds display names by UTF-16 units without splitting an emoji', () => {
    const bounded = sharedTaskAccountName('x'.repeat(31) + '😀tail');
    expect(bounded).toBe('x'.repeat(31));
    expect(bounded.length).toBe(31);
    expect(sharedTaskAccountName('\u0000  Cindy  ')).toBe('Cindy');
  });
});
