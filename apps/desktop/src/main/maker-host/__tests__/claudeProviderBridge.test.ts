import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PROVIDER_MODEL_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { invocationModelRecord, NATIVE_BRIDGE_SESSION_HEADER } from '../pi-provider-transport.js';
import { claudeProviderReasoningNamespace, createClaudeProviderBridge } from '../claude-provider-bridge.js';

async function runBridge(
  protocol: 'openai-chat' | 'openai-responses',
  stream: boolean,
  upstream: string,
  onRequest: (url: string, init?: RequestInit) => void,
  extras: Partial<Parameters<typeof createClaudeProviderBridge>[0]> = {},
  effort = 'high',
  fast = false,
  inboundHeaders: Record<string, string> = {},
) {
  const handler = createClaudeProviderBridge({
    url: `https://supplier.example/v1/${protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`,
    protocol, headers: { authorization: 'Bearer fixture-supplier-key', 'x-api-key': 'fixture-supplier-key' },
    efforts: ['low', 'medium', 'high'], capabilities: { imageInput: 'image_url', reasoningField: 'reasoning_effort' },
    fetchImpl: async (url, init) => {
      onRequest(String(url), init);
      return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
    },
    ...extras,
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      void handler.handle({ parsedBody: JSON.parse(Buffer.concat(chunks).toString()),
        ctx: { reqId: 1, method: 'POST', url: req.url!, headers: inboundHeaders }, res,
        prefs: { reasoningEffort: effort, fast },
      }).catch(() => { res.statusCode = 500; res.end(); });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-claude-subscription' },
      body: JSON.stringify({ model: 'test-model', stream, max_tokens: 8192,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
      }),
    });
    return { status: response.status, body: await response.text() };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const chatStream = [
  { id: 'chat-fixture', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
  { id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';

describe('Claude Code custom provider translation', () => {
  it.each([true, false])('translates chat requests and replies with streaming=%s', async stream => {
    const result = await runBridge('openai-chat', stream, chatStream, (url, init) => {
      expect(url).toBe('https://supplier.example/v1/chat/completions');
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: 'test-model', reasoning_effort: 'high', stream: true });
      expect(JSON.stringify(request.messages)).toContain('data:image/png;base64,AAAA');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-supplier-key' });
      expect(JSON.stringify(init?.headers)).not.toContain('fixture-claude-subscription');
      expect(JSON.stringify(init?.headers)).not.toContain('x-api-key');
    });
    expect(result.status).toBe(200);
    if (stream) { expect(result.body).toContain('message_stop'); expect(result.body).toContain('Hello'); }
    else expect(JSON.parse(result.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello' }] });
  });

  it('keeps Cloudflare header-only credentials on the native Claude bridge', async () => {
    const original = PROVIDER_MODEL_CATALOG.providers['cloudflare-ai-gateway'].find(row => row.execution.pi.api === 'openai-completions')!;
    const row = { ...original, upstream: original.upstream.replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway') };
    let sent: Headers | undefined;
    const result = await runBridge('openai-chat', true, chatStream, (url, init) => {
      sent = new Headers(init?.headers as HeadersInit);
    }, {
      headers: { 'cf-aig-authorization': 'Bearer header-only-key' },
      model: row,
    });
    expect(result.status).toBe(200);
    expect(sent?.get('cf-aig-authorization')).toBe('Bearer header-only-key');
    expect(sent?.get('authorization')).toBeNull();
  });

  it('keeps encrypted reasoning state private to a connection, not a shared URL', () => {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    expect(claudeProviderReasoningNamespace(url, 'custom:openrouter-a'))
      .not.toBe(claudeProviderReasoningNamespace(url, 'custom:openrouter-b'));
    expect(claudeProviderReasoningNamespace(url, 'custom:openrouter-a'))
      .not.toBe(claudeProviderReasoningNamespace(url));
  });

  it.each([true, false, undefined])('sends Fast only when enabled and supported (%s)', async supportsFastMode => {
    for (const fast of [true, false]) {
      let body: Record<string, unknown> | undefined;
      const result = await runBridge('openai-chat', true, chatStream,
        (_url, init) => { body = JSON.parse(String(init?.body)); },
        { supportsFastMode }, 'high', fast);
      expect(result.status).toBe(200);
      expect(body?.service_tier).toBe(supportsFastMode === true && fast ? 'priority' : undefined);
    }
  });
});

describe('OpenCode Go session identity through the native Claude bridge (#5325)', () => {
  const upstream = 'https://opencode.ai/zen/go/v1';
  function goRow() {
    const provider = buildUserProvider({ id: 'opencode-go', name: 'OpenCode Go', runtimes: {
      'claude-code': { baseUrl: upstream, wireProtocol: 'openai-chat', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: false, reasoningEfforts: [] }] },
    } });
    return invocationModelRecord(provider.models['claude-code']![0], upstream, 'openai-completions')!;
  }
  /** The SDK's final HTTP request is what the upstream validates, not the handler arguments. */
  function goUpstream(seen: Headers[]) {
    return async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers);
      if (!headers.get('x-opencode-session')?.trim()) return new Response(JSON.stringify({ error: 'MissingSessionID' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(chatStream, { headers: { 'content-type': 'text/event-stream' } });
    };
  }

  it('carries the inbound Claude Code session as a stable x-opencode-session on the SDK request', async () => {
    const seen: Headers[] = [];
    const row = goRow();
    const runs = [] as Array<{ status: number; body: string }>;
    for (const inbound of ['cc-session-a', 'cc-session-a', 'cc-session-b']) {
      runs.push(await runBridge('openai-chat', true, chatStream, () => {}, {
        model: row, nativeUpstream: upstream, providerId: 'opencode-go', efforts: [],
        fetchImpl: goUpstream(seen) as typeof fetch,
      }, 'high', false, { 'x-claude-code-session-id': inbound }));
    }
    expect(runs.map(run => run.status)).toEqual([200, 200, 200]);
    expect(runs[0]!.body).toContain('Hello');
    const values = seen.map(headers => headers.get('x-opencode-session'));
    expect(values[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(values[1]).toBe(values[0]);
    expect(values[2]).not.toBe(values[0]);
    for (const headers of seen) {
      expect(headers.get(NATIVE_BRIDGE_SESSION_HEADER)).toBeNull();
      expect(headers.get('x-claude-code-session-id')).toBeNull();
    }
  });

  it('does not leak the internal session carrier to a Responses pass-through upstream', async () => {
    let sent: Headers | undefined;
    const result = await runBridge('openai-responses', true, 'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n', (_url, init) => {
      sent = new Headers(init?.headers as HeadersInit);
    }, {}, 'high', false, { 'x-claude-code-session-id': 'cc-session-a' });
    expect(result.status).toBe(200);
    expect(sent?.get(NATIVE_BRIDGE_SESSION_HEADER)).toBeNull();
    expect(sent?.get('x-opencode-session')).toBeNull();
  });
});
