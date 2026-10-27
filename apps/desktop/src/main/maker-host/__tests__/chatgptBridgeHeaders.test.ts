import { describe, expect, it } from 'vitest';

import { buildChatgptBridgeHeaders } from '../chatgpt-bridge-headers.js';

describe('buildChatgptBridgeHeaders', () => {
  it('includes the account header when Codex auth identifies a ChatGPT workspace', () => {
    expect(
      buildChatgptBridgeHeaders({
        accessToken: 'access-token',
        accountId: 'account-1',
        sessionId: 'session-1',
      }),
    ).toEqual({
      authorization: 'Bearer access-token',
      'chatgpt-account-id': 'account-1',
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: 'session-1',
      'user-agent': 'Lex-ChatGPTBridge',
    });
  });

  it('omits the account header for a valid single-account token without account metadata', () => {
    const headers = buildChatgptBridgeHeaders({
      accessToken: 'access-token',
      accountId: null,
    });

    expect(headers).toEqual({
      authorization: 'Bearer access-token',
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: '',
      'user-agent': 'Lex-ChatGPTBridge',
    });
  });
});
