import { describe, expect, it } from 'vitest';
import {
  registerRemoteChannelSession,
  consumeRemoteChannelSession,
  remoteChannelSession,
  authenticateRemoteChannelToken,
  remoteChannelRequestCurrent,
  REMOTE_CHANNEL_TOKEN_HEADER,
} from '../remote-provider-channel-auth.js';

describe('SSH channel task capability', () => {
  it('rejects another engine and removes private credentials before upstream dispatch', () => {
    const lease = registerRemoteChannelSession('task-a', 'codex', () => true);
    try {
      expect(
        consumeRemoteChannelSession({ [REMOTE_CHANNEL_TOKEN_HEADER]: lease.token }, 'claude-code'),
      ).toBe(false);
      const headers = { [REMOTE_CHANNEL_TOKEN_HEADER]: lease.token };
      expect(consumeRemoteChannelSession(headers, 'codex')).toBe('task-a');
      expect(headers).toEqual({});
      expect(remoteChannelSession(headers, 'codex')).toBe('task-a');
      expect(remoteChannelSession({ ...headers }, 'codex')).toBeUndefined();
    } finally {
      lease.release();
    }
  });
  it('revokes account-stale requests and rejects forged or released tokens', () => {
    let current = true;
    const lease = registerRemoteChannelSession('task', 'claude-code', () => current);
    const headers = { [REMOTE_CHANNEL_TOKEN_HEADER]: lease.token };
    expect(consumeRemoteChannelSession(headers, 'claude-code')).toBe('task');
    current = false;
    expect(remoteChannelSession(headers, 'claude-code')).toBeUndefined();
    expect(remoteChannelRequestCurrent(headers, 'claude-code')).toBe(false);
    expect(
      consumeRemoteChannelSession({ [REMOTE_CHANNEL_TOKEN_HEADER]: lease.token }, 'claude-code'),
    ).toBe(false);
    current = true;
    lease.release();
    expect(
      consumeRemoteChannelSession({ [REMOTE_CHANNEL_TOKEN_HEADER]: lease.token }, 'claude-code'),
    ).toBe(false);
    expect(authenticateRemoteChannelToken('task', lease.token)).toBe(false);
    expect(authenticateRemoteChannelToken([lease.token], lease.token)).toBe(false);
    expect(authenticateRemoteChannelToken('é'.repeat(64), lease.token)).toBe(false);
    expect(consumeRemoteChannelSession({}, 'claude-code')).toBeNull();
  });
});
