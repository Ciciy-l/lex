/**
 * provider-diagnostics（测试连接探测）+ shared/providerErrors（结构化分类器）单测。
 *
 * 覆盖：
 *   - 分类器对 status / 错误体 pattern / 网络层错误码的确定性归类（规则 9）；
 *   - buildProbeRequest 的 wire 形状（cc=/v1/messages 双鉴权头；codex=/responses Bearer），
 *     与 provider-route 的 api-key-header 分支 header 组合对齐；
 *   - runProviderProbe 注入 fetch 不联网：2xx → ok、4xx → 分类、网络错 → UPSTREAM_UNREACHABLE；
 *   - resolveSavedProbeSpec 从 active-catalog + 注入 key reader 解析（仅 user 供应商）。
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, it, expect, afterEach, vi } from 'vitest';

import { BUNDLED_CATALOG, buildUserProvider, buildUserProviderChannels, PROVIDER_MODEL_CATALOG, providerPresetOAuth, type CustomProviderConfig, type ProviderWireProtocol } from '@cindy/model-providers';

import { classifyProviderError } from '../../../shared/providerErrors.js';
import {
  buildProbeRequest,
  runProviderProbe,
  resolveSavedProbeSpec,
  setDiagnosticsKeyReader,
  setDiagnosticsOAuthTokenReader,
  testProviderConnection,
} from '../provider-diagnostics.js';
import { setCustomProviders } from '../active-catalog.js';
import { beginAppSessionBoundary } from '../../appSessionState.js';
import { beginProviderRouteMutation, setCustomProviderHeaderReader } from '../provider-route.js';
import { outboundFetch } from '../outbound-fetch.js';

afterEach(() => {
  setCustomProviders([]);
  setDiagnosticsKeyReader(() => null);
  setCustomProviderHeaderReader(() => null);
});

describe('classifyProviderError', () => {
  it('按 status 归类明确错误', () => {
    expect(classifyProviderError({ status: 401 }).code).toBe('AUTH_INVALID');
    expect(classifyProviderError({ status: 402 }).code).toBe('QUOTA_EXCEEDED');
    expect(classifyProviderError({ status: 403 }).code).toBe('AUTH_FORBIDDEN');
    expect(classifyProviderError({ status: 429 })).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(classifyProviderError({ status: 529 })).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(classifyProviderError({ status: 503 })).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
  });

  it('404：模型措辞 → MODEL_NOT_FOUND，否则 ENDPOINT_NOT_FOUND', () => {
    expect(
      classifyProviderError({
        status: 404,
        bodyText: '{"error":{"message":"model: glm-x not found"}}',
      }).code,
    ).toBe('MODEL_NOT_FOUND');
    expect(classifyProviderError({ status: 404, bodyText: 'no route' }).code).toBe(
      'ENDPOINT_NOT_FOUND',
    );
  });

  it('400 按错误体 pattern 分流', () => {
    expect(
      classifyProviderError({
        status: 400,
        bodyText: 'The model `x` does not exist or you do not have access',
      }).code,
    ).toBe('MODEL_NOT_FOUND');
    expect(
      classifyProviderError({ status: 400, bodyText: 'prompt is too long: 250000 tokens' }).code,
    ).toBe('CONTEXT_TOO_LONG');
    expect(classifyProviderError({ status: 400, bodyText: 'insufficient_quota' }).code).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(
      classifyProviderError({ status: 400, bodyText: 'Extra inputs are not permitted' }).code,
    ).toBe('WIRE_INCOMPATIBLE');
    expect(classifyProviderError({ status: 400, bodyText: 'something odd' }).code).toBe('UNKNOWN');
  });

  it('403 命中鉴权措辞归 AUTH_INVALID（部分网关 key 无效报 403）', () => {
    expect(classifyProviderError({ status: 403, bodyText: 'invalid api key provided' }).code).toBe(
      'AUTH_INVALID',
    );
  });

  it('网络层错误 → UPSTREAM_UNREACHABLE / TIMEOUT（均可重试）', () => {
    expect(classifyProviderError({ networkErrorCode: 'ECONNREFUSED' })).toMatchObject({
      code: 'UPSTREAM_UNREACHABLE',
      retryable: true,
    });
    expect(classifyProviderError({ networkErrorCode: 'TimeoutError' }).code).toBe('TIMEOUT');
  });

  it('不认识的网络错误码 → UNKNOWN（不误导用户「检查网络」）', () => {
    expect(classifyProviderError({ networkErrorCode: 'E_WEIRD_CUSTOM' })).toMatchObject({
      code: 'UNKNOWN',
      retryable: false,
    });
  });
});

describe('buildProbeRequest', () => {
  it('Codex Anthropic Messages probe uses x-api-key and Messages endpoint', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-opus-5',
      apiKey: 'sk-test',
      headers: {
        'Anthropic-Version': 'custom-version',
        'Content-Type': 'text/plain',
      },
    });
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('custom-version');
    expect(headers['Anthropic-Version']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 1,
    });
  });

  it('adds the OpenCode Go session header to the probe request', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'openai-chat',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'go-secret',
    });
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.authorization).toBe('Bearer go-secret');
  });

  it('recognizes an OpenCode Go preset on a mirror base URL', () => {
    const { init } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'openai-chat',
      baseUrl: 'https://mirror.example/v1',
      catalogPresetId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'go-secret',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('leaves other presets on mirror base URLs without the session header', () => {
    const { init } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'openai-chat',
      baseUrl: 'https://mirror.example/v1',
      catalogPresetId: 'moonshot',
      modelId: 'kimi-k2',
      apiKey: 'sk-mirror',
    });
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBeUndefined();
  });

  it('Codex Anthropic Messages probe matches runtime joining for a versioned base URL', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://provider.example/v1',
      modelId: 'claude-sonnet-4-6',
    });
    expect(url).toBe('https://provider.example/v1/messages');
  });

  it('Codex Anthropic Messages probe preserves custom path and query joining', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://provider.example/api/v1?tenant=alpha',
      requestPath: '/tenant/messages?beta=true',
      modelId: 'claude-sonnet-4-6',
    });
    expect(url).toBe('https://provider.example/api/v1/tenant/messages?tenant=alpha&beta=true');
  });

  it('cc wire：/v1/messages + anthropic-version + 双鉴权头（与 api-key-header 路由分支对齐）', () => {
    const { url, init } = buildProbeRequest({
      agent: 'claude-code',
      baseUrl: 'https://api.deepseek.com/anthropic/',
      modelId: 'deepseek-chat',
      apiKey: 'sk-test',
      headers: {
        'x-custom': '1',
        Authorization: 'Bearer stale',
        'X-API-Key': 'stale',
      },
    });
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-custom']).toBe('1');
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number };
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBe(1);
  });

  it('codex wire：/responses + Bearer', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'z-ai/glm-5.2',
      apiKey: 'sk-or',
    });
    expect(url).toBe('https://openrouter.ai/api/v1/responses');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-or');
    expect(headers['x-api-key']).toBeUndefined();
    const body = JSON.parse(String(init.body)) as { model: string; stream: boolean };
    expect(body.model).toBe('z-ai/glm-5.2');
    expect(body.stream).toBe(false);
  });

  it.each([
    ['minimax-cn', 'https://api.minimaxi.com/v1/responses'],
    ['minimax-global', 'https://api.minimax.io/v1/responses'],
  ])('%s 预设拼出官方 Responses 端点', (presetId, expectedUrl) => {
    const runtime = BUNDLED_CATALOG.presets?.find((preset) => preset.id === presetId)?.runtimes
      .codex;
    expect(runtime).toBeDefined();
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: runtime!.baseUrl,
      modelId: runtime!.models[0]!.id,
      apiKey: 'sk-test',
    });
    expect(url).toBe(expectedUrl);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'MiniMax-M3',
      stream: false,
      store: false,
    });
  });

  it('codex Chat bridge wire：/chat/completions 基础流式探测,不强制 tool_choice', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
      wireProtocol: 'openai-chat',
      apiKey: 'sk-ds',
    });
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // 不带 tools / 强制 tool_choice —— 思考模型(DeepSeek deepseek-v4-pro)会拒强制工具,
    // 导致可达端点被误报失败;工具能力交给真实会话验证。
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('uses an exact request path instead of appending the protocol default', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://gateway.example/api',
      modelId: 'custom-model',
      wireProtocol: 'openai-chat',
      requestPath: '/tenant/acme/infer?stream=1',
    });
    expect(url).toBe('https://gateway.example/api/tenant/acme/infer?stream=1');
  });

  it('preserves the base query when applying an exact request path', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://gateway.example/api?tenant=alpha',
      modelId: 'custom-model',
      requestPath: '/infer?stream=1&mode=fast',
    });
    expect(url).toBe('https://gateway.example/api/infer?tenant=alpha&stream=1&mode=fast');
  });

  it('rejects base URL credentials when applying an exact request path', () => {
    expect(() =>
      buildProbeRequest({
        agent: 'codex',
        baseUrl: 'https://user:pass@gateway.example/api',
        modelId: 'custom-model',
        requestPath: '/infer',
      }),
    ).toThrow('invalid provider base URL');
  });

  it('无 key 时不注入鉴权头（端点可能靠自定义 headers 鉴权）', () => {
    const { init } = buildProbeRequest({
      agent: 'claude-code',
      baseUrl: 'https://x.example',
      modelId: 'm',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('no-auth 探测剥掉表单残留的大小写混合凭证头', () => {
    const { init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'http://127.0.0.1:4000/v1',
      modelId: 'local-model',
      authMethod: 'none',
      headers: {
        Authorization: 'Bearer must-not-leak',
        'X-API-Key': 'must-not-leak',
        'X-Tenant': 'local',
      },
    });
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-tenant': 'local',
    });
  });
});

function fakeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('runProviderProbe（注入 fetch，不联网）', () => {
  it('2xx → ok + latency', async () => {
    const r = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://x.example', modelId: 'm', apiKey: 'k' },
      async () => fakeResponse(200, '{}'),
    );
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('401 → AUTH_INVALID + status 透出', async () => {
    const r = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://x.example', modelId: 'm' },
      async () => fakeResponse(401, '{"error":{"type":"authentication_error"}}'),
    );
    expect(r).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
  });

  it('fetch 抛网络错 → UPSTREAM_UNREACHABLE', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: { code: string } }).cause = { code: 'ECONNREFUSED' };
    const r = await runProviderProbe(
      { agent: 'codex', baseUrl: 'https://nope.example', modelId: 'm' },
      async () => {
        throw err;
      },
    );
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_UNREACHABLE' });
  });

  it('openai-chat 探测:200 text/event-stream → ok', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response('data: {}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(r.ok).toBe(true);
  });

  it('openai-chat 探测:200 SSE 顶层 error 帧 → 分类失败', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response('data: {"error":{"type":"server_error","message":"model overloaded"}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR', status: 200 });
  });

  it('openai-chat 探测:200 SSE 无 data 帧 → WIRE_INCOMPATIBLE', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response(': keepalive\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(r).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE', status: 200 });
  });

  it('openai-chat 探测:200 但非 SSE(application/json)→ WIRE_INCOMPATIBLE(与真实桥同口径)', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response('{"choices":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(r).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE', status: 200 });
  });

  it('原生 Responses(codex 无 openai-chat)不做 SSE 校验:200 JSON 仍 ok', async () => {
    const r = await runProviderProbe(
      { agent: 'codex', baseUrl: 'https://x.example', modelId: 'm', apiKey: 'k' },
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('resolveSavedProbeSpec / testProviderConnection(saved)', () => {
  const config = {
    id: 'my-relay',
    name: 'My Relay',
    runtimes: {
      'claude-code': {
        baseUrl: 'https://relay.example/anthropic',
        models: [{ id: 'glm-5.2', name: 'GLM' }],
        headers: {
          'x-tenant': 't1',
          Authorization: 'Bearer stale',
          'X-API-Key': 'stale',
        },
      },
    },
  };

  it('从 active-catalog 解析 user 供应商 + 注入 key reader 读 key', () => {
    setCustomProviders([buildUserProvider(config)]);
    setDiagnosticsKeyReader((id, agent) =>
      id === 'my-relay' && agent === 'claude-code' ? 'sk-saved' : null,
    );
    const spec = resolveSavedProbeSpec('my-relay', 'claude-code');
    expect(spec).toMatchObject({
      baseUrl: 'https://relay.example/anthropic',
      modelId: 'glm-5.2',
      apiKey: 'sk-saved',
      headers: { 'x-tenant': 't1' },
    });
  });

  it('safeStorage 尚无 key 时保留 legacy header-only 凭证', () => {
    setCustomProviders([buildUserProvider(config)]);
    setDiagnosticsKeyReader(() => null);

    const spec = resolveSavedProbeSpec('my-relay', 'claude-code');
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toEqual({
      'x-tenant': 't1',
      Authorization: 'Bearer stale',
      'X-API-Key': 'stale',
    });

    const headers = buildProbeRequest(spec).init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer stale');
    expect(headers['x-api-key']).toBe('stale');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('api-key-header + openai-chat 供应商:saved 探测带上 wireProtocol → 打 /chat/completions', async () => {
    const chatConfig = {
      id: 'ds-chat',
      name: 'DeepSeek Chat',
      runtimes: {
        codex: {
          baseUrl: 'https://api.deepseek.com',
          wireProtocol: 'openai-chat' as const,
          models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
        },
      },
    };
    setCustomProviders([buildUserProvider(chatConfig)]);
    setDiagnosticsKeyReader(() => 'sk-ds');
    // resolveSavedProbeSpec 必须回带 wireProtocol，否则 buildProbeRequest 回落原生 /responses。
    expect(resolveSavedProbeSpec('ds-chat', 'codex').wireProtocol).toBe('openai-chat');
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'ds-chat', agent: 'codex' },
      async (url) => {
        seenUrl = String(url);
        return fakeResponse(200, 'data: [DONE]\n\n');
      },
    );
    expect(seenUrl).toBe('https://api.deepseek.com/chat/completions');
  });

  it('Pi 的常用 Chat 默认仍显式进入 saved 探测，不误走 /responses', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'pi-chat',
        name: 'Pi Chat',
        runtimes: {
          pi: {
            baseUrl: 'https://pi-chat.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'chat-model', name: 'Chat Model' }],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'pi-chat-key');

    expect(resolveSavedProbeSpec('pi-chat', 'pi').wireProtocol).toBe('openai-chat');
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'pi-chat', agent: 'pi' },
      async (url) => {
        seenUrl = String(url);
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    );
    expect(seenUrl).toBe('https://pi-chat.example/v1/chat/completions');
  });

  it('Pi saved 探测优先使用单模型协议覆盖', () => {
    setCustomProviders([
      buildUserProvider({
        id: 'pi-model-override',
        name: 'Pi Model Override',
        runtimes: {
          pi: {
            baseUrl: 'https://pi-override.example/v1',
            wireProtocol: 'openai-chat',
            models: [
              {
                id: 'messages-model',
                name: 'Messages Model',
                piApi: 'anthropic-messages',
              },
            ],
          },
        },
      }),
    ]);

    expect(resolveSavedProbeSpec('pi-model-override', 'pi')).toMatchObject({
      baseUrl: 'https://pi-override.example/v1',
      modelId: 'messages-model',
      wireProtocol: 'anthropic-messages',
    });
  });

  it('仅选择 glm-5.3 时 saved 探测使用模型级 Responses 路由', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'glm-responses-only',
        name: 'GLM Responses Only',
        runtimes: {
          codex: {
            baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            wireProtocol: 'openai-chat',
            requestPath: '/legacy/chat',
            models: [
              {
                id: 'glm-5.3',
                name: 'GLM-5.3',
                route: {
                  baseUrl: 'https://open.bigmodel.cn/api/v1',
                  wireProtocol: 'openai-responses',
                },
              },
            ],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'glm-key');

    expect(resolveSavedProbeSpec('glm-responses-only', 'codex')).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/v1',
      modelId: 'glm-5.3',
      wireProtocol: 'openai-responses',
      requestPath: undefined,
    });
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'glm-responses-only', agent: 'codex' },
      async (url) => {
        seenUrl = String(url);
        return fakeResponse(200, '{}');
      },
    );
    expect(seenUrl).toBe('https://open.bigmodel.cn/api/v1/responses');
  });

  it('无模型级 route 的 glm-5.2 saved 探测继续使用 runtime V4 Chat 路由', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'glm-chat-only',
        name: 'GLM Chat Only',
        runtimes: {
          codex: {
            baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            wireProtocol: 'openai-chat',
            requestPath: '/chat/completions',
            models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'glm-key');

    expect(resolveSavedProbeSpec('glm-chat-only', 'codex')).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      modelId: 'glm-5.2',
      wireProtocol: 'openai-chat',
      requestPath: '/chat/completions',
    });
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'glm-chat-only', agent: 'codex' },
      async (url) => {
        seenUrl = String(url);
        return fakeResponse(200, 'data: [DONE]\n\n');
      },
    );
    expect(seenUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
  });

  it('saved 探测沿用自定义供应商的精确请求路径', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'exact-path',
        name: 'Exact Path',
        runtimes: {
          codex: {
            baseUrl: 'https://gateway.example/api',
            requestPath: '/tenant/acme/infer',
            models: [{ id: 'm', name: 'M' }],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'sk-exact');
    expect(resolveSavedProbeSpec('exact-path', 'codex').requestPath).toBe('/tenant/acme/infer');
  });

  it('不存在 / 非 user 供应商 / 无该 runtime → 抛错（handler 映射 INVALID_PARAMS）', () => {
    setCustomProviders([buildUserProvider(config)]);
    expect(() => resolveSavedProbeSpec('nope', 'claude-code')).toThrow(/not found/);
    expect(() => resolveSavedProbeSpec('xd', 'claude-code')).toThrow(/not a custom provider/);
    expect(() => resolveSavedProbeSpec('my-relay', 'codex')).toThrow(/no runtime/);
  });

  it('跳过非聊天模型挑第一个聊天模型探测(issue #882 第 3 点,2026-07 review):探测发的是聊天形状请求,挑到 embedding/image 模型会得到与配置无关的假失败结论', () => {
    const provider = buildUserProvider(config);
    setCustomProviders([
      {
        ...provider,
        models: {
          ...provider.models,
          'claude-code': [
            {
              id: 'text-embedding-3-large',
              name: 'Embedding',
              contextWindow: 8191,
              efforts: [],
              defaultEffort: null,
              mode: 'embedding',
            },
            {
              id: 'glm-5.2',
              name: 'GLM',
              contextWindow: 128_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      },
    ]);
    setDiagnosticsKeyReader(() => 'sk-saved');
    expect(resolveSavedProbeSpec('my-relay', 'claude-code').modelId).toBe('glm-5.2');
  });

  it('全是非聊天模型时抛「无聊天模型」错误,而不是静默探测一个 embedding 模型', () => {
    const provider = buildUserProvider(config);
    setCustomProviders([
      {
        ...provider,
        models: {
          ...provider.models,
          'claude-code': [
            {
              id: 'text-embedding-3-large',
              name: 'Embedding',
              contextWindow: 8191,
              efforts: [],
              defaultEffort: null,
              mode: 'embedding',
            },
          ],
        },
      },
    ]);
    setDiagnosticsKeyReader(() => 'sk-saved');
    expect(() => resolveSavedProbeSpec('my-relay', 'claude-code')).toThrow(/no chat models/);
  });

  it('testProviderConnection(saved) 端到端（注入 fetch 断言 URL 与 key）', async () => {
    setCustomProviders([buildUserProvider(config)]);
    setDiagnosticsKeyReader(() => 'sk-saved');
    let seenUrl = '';
    let seenAuth = '';
    const r = await testProviderConnection(
      { kind: 'saved', providerId: 'my-relay', agent: 'claude-code' },
      async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)['x-api-key'] ?? '';
        return fakeResponse(200, '{}');
      },
    );
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe('https://relay.example/anthropic/v1/messages');
    expect(seenAuth).toBe('sk-saved');
  });

  it('oauth-token 供应商:探测 token 走 authorization 头,绝不发 x-api-key(与真实路由同口径)', async () => {
    const oauthConfig = {
      ...config,
      id: 'my-sub',
      auth: {
        method: 'oauth' as const,
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'c1',
          scopes: 'openid',
        },
      },
    };
    setCustomProviders([buildUserProvider(oauthConfig)]);
    setDiagnosticsKeyReader(() => 'sk-should-not-be-used');
    setDiagnosticsOAuthTokenReader((id) => (id === 'my-sub' ? 'at-77' : null));

    const spec = resolveSavedProbeSpec('my-sub', 'claude-code');
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toMatchObject({ authorization: 'Bearer at-77', 'x-tenant': 't1' });

    const { init } = buildProbeRequest(spec);
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer at-77');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('none 供应商:saved 探测不读取旧 key,并剥掉配置里残留的鉴权头', () => {
    setCustomProviders([
      buildUserProvider({
        ...config,
        id: 'local-proxy',
        auth: { method: 'none' },
        runtimes: {
          'claude-code': {
            ...config.runtimes['claude-code'],
            baseUrl: 'http://127.0.0.1:4100',
            headers: {
              ...config.runtimes['claude-code'].headers,
              Authorization: 'Bearer must-not-leak',
              'X-API-Key': 'must-not-leak',
            },
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'stale-safe-storage-key');

    const spec = resolveSavedProbeSpec('local-proxy', 'claude-code');
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toEqual({ 'x-tenant': 't1' });
  });

  it('拒绝探测已禁用的 saved runtime，绝不进入网络请求', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'legacy-remote-no-auth',
        name: 'Legacy remote no-auth',
        auth: { method: 'none' },
        runtimes: {
          codex: {
            baseUrl: 'https://remote.example/v1',
            models: [{ id: 'm', name: 'M' }],
          },
        },
      }),
    ]);
    let fetchCalled = false;

    await expect(
      testProviderConnection(
        { kind: 'saved', providerId: 'legacy-remote-no-auth', agent: 'codex' },
        async () => {
          fetchCalled = true;
          return fakeResponse(200, '{}');
        },
      ),
    ).rejects.toThrow(/disabled/);
    expect(fetchCalled).toBe(false);
  });
});


it('probes Google using generateContent instead of falling through to Responses', () => {
  const request = buildProbeRequest({ agent: 'codex', wireProtocol: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId: 'new-gemini', apiKey: 'fixture-key' });
  expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/new-gemini:generateContent');
  expect(request.init.headers).toMatchObject({ 'x-goog-api-key': 'fixture-key' });
  expect(request.init.headers).not.toHaveProperty('authorization');
  expect(JSON.parse(String(request.init.body))).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 16 } });
});


describe('saved probes with a draft model and endpoint', () => {
  const channelConfig: CustomProviderConfig = {
    id: 'supplier',
    name: 'Supplier',
    runtimes: {},
    channels: {
      version: 1,
      channels: [
        {
          id: 'primary',
          name: 'Primary',
          protocols: {
            'anthropic-messages': {
              baseUrl: 'https://channel.example/v1',
              wireProtocol: 'anthropic-messages',
              models: [
                { id: 'chat-a', name: 'chat-a' },
                {
                  id: 'chat-b',
                  name: 'chat-b',
                  route: {
                    baseUrl: 'https://alternate.example/v1',
                    wireProtocol: 'anthropic-messages',
                  },
                },
              ],
            },
          },
        },
      ],
    },
  };
  const providerId = 'primary--anthropic-messages';
  const endpoint = (baseUrl = 'https://channel.example/v1') => ({
    baseUrl,
    wireProtocol: 'anthropic-messages' as const,
    modelsUrl: null,
  });

  it('routes an unsaved draft model through the saved channel endpoint and key', () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    const read = vi.fn(() => 'saved-key');
    setDiagnosticsKeyReader(read);
    const spec = resolveSavedProbeSpec(providerId, 'pi', {
      modelId: 'chat-new',
      endpoint: endpoint(),
    });
    expect(spec).toMatchObject({
      modelId: 'chat-new',
      baseUrl: 'https://channel.example/v1',
      wireProtocol: 'anthropic-messages',
      apiKey: 'saved-key',
    });
    expect(read).toHaveBeenCalledWith('primary', 'pi', 'anthropic-messages');
  });

  it('uses the saved model-level route for a saved draft model', () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => 'saved-key');
    const spec = resolveSavedProbeSpec(providerId, 'pi', {
      modelId: 'chat-b',
      endpoint: endpoint('https://alternate.example/v1'),
    });
    expect(spec).toMatchObject({
      modelId: 'chat-b',
      baseUrl: 'https://alternate.example/v1',
      apiKey: 'saved-key',
    });
  });

  it('sends the saved key to the saved endpoint for an unsaved draft model', async () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => 'saved-key');
    let seenUrl = '';
    let seenAuth = '';
    let seenModel = '';
    await testProviderConnection(
      { kind: 'saved', providerId, agent: 'pi', modelId: 'chat-new', endpoint: endpoint() },
      async (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get('authorization') ?? '';
        seenModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    );
    expect(seenUrl).toContain('https://channel.example/v1');
    expect(seenAuth).toBe('Bearer saved-key');
    expect(seenModel).toBe('chat-new');
  });

  it('rejects mismatched draft endpoints before reading the stored key', () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    const read = vi.fn(() => 'saved-key');
    setDiagnosticsKeyReader(read);

    expect(() =>
      resolveSavedProbeSpec(providerId, 'pi', {
        modelId: 'chat-new',
        endpoint: endpoint('https://evil.example/v1'),
      }),
    ).toThrow(/endpoint differs/);
    expect(() =>
      resolveSavedProbeSpec(providerId, 'pi', {
        modelId: 'chat-new',
        endpoint: { ...endpoint(), modelsUrl: 'https://channel.example/models' },
      }),
    ).toThrow(/model-list endpoint differs/);
    expect(() =>
      resolveSavedProbeSpec(providerId, 'pi', {
        modelId: 'chat-a',
        endpoint: { ...endpoint(), wireProtocol: 'openai-chat' },
      }),
    ).toThrow(/protocol differs/);
    expect(() =>
      resolveSavedProbeSpec(providerId, 'claude-code', {
        modelId: 'chat-a',
        endpoint: { ...endpoint(), requestPath: '/other' },
      }),
    ).toThrow(/request path differs/);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses to read a saved key while a provider route mutation is open', async () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    const read = vi.fn(() => 'saved-key');
    setDiagnosticsKeyReader(read);
    const readHeaders = vi.fn(() => null);
    setCustomProviderHeaderReader(readHeaders);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const release = beginProviderRouteMutation(providerId);
    try {
      await expect(
        testProviderConnection(
          { kind: 'saved', providerId, agent: 'pi', modelId: 'chat-a', endpoint: endpoint() },
          fetchImpl,
        ),
      ).rejects.toThrow(/configuration is being updated/);
    } finally {
      release();
    }
    expect(read).not.toHaveBeenCalled();
    expect(readHeaders).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to read a saved key while an account boundary is pending', () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    const read = vi.fn(() => 'saved-key');
    setDiagnosticsKeyReader(read);
    const readHeaders = vi.fn(() => null);
    setCustomProviderHeaderReader(readHeaders);
    const release = beginAppSessionBoundary();
    try {
      expect(() =>
        resolveSavedProbeSpec(providerId, 'pi', { modelId: 'chat-a', endpoint: endpoint() }),
      ).toThrow(/account changes/);
    } finally {
      release();
    }
    expect(read).not.toHaveBeenCalled();
    expect(readHeaders).not.toHaveBeenCalled();
  });

  it('discards a probe invalidated by an account boundary while it runs', async () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => 'saved-key');
    const boundary: { release?: () => void } = {};
    const fetchImpl = vi.fn(async () => {
      boundary.release = beginAppSessionBoundary();
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    try {
      await expect(
        testProviderConnection(
          { kind: 'saved', providerId, agent: 'pi', modelId: 'chat-a', endpoint: endpoint() },
          fetchImpl,
        ),
      ).rejects.toThrow(/account change/);
    } finally {
      boundary.release?.();
    }
  });

  it('discards a probe invalidated by a route mutation while it runs', async () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => 'saved-key');
    const mutation: { release?: () => void } = {};
    const fetchImpl = vi.fn(async () => {
      mutation.release = beginProviderRouteMutation(providerId);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    try {
      await expect(
        testProviderConnection(
          { kind: 'saved', providerId, agent: 'pi', modelId: 'chat-a', endpoint: endpoint() },
          fetchImpl,
        ),
      ).rejects.toThrow(/configuration changed during the probe/);
    } finally {
      mutation.release?.();
    }
  });

  it('hydrates Main-only headers for a header-only saved channel route', () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => null);
    setCustomProviderHeaderReader((channelId, agent, protocol) =>
      channelId === 'primary' && agent === 'pi' && protocol === 'anthropic-messages'
        ? { authorization: 'Bearer fake-header-key' }
        : null,
    );
    const spec = resolveSavedProbeSpec(providerId, 'pi', {
      modelId: 'chat-new',
      endpoint: endpoint(),
    });
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toMatchObject({ authorization: 'Bearer fake-header-key' });
    const headers = buildProbeRequest(spec).init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer fake-header-key');
  });

  it('prefers the saved key over stored credential headers and keeps non-credential headers', () => {
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => 'saved-key');
    setCustomProviderHeaderReader(() => ({
      authorization: 'Bearer stale',
      'x-tenant': 't1',
    }));
    const spec = resolveSavedProbeSpec(providerId, 'pi', {
      modelId: 'chat-a',
      endpoint: endpoint(),
    });
    expect(spec.headers).toEqual({ 'x-tenant': 't1' });
    const headers = buildProbeRequest(spec).init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer saved-key');
    expect(headers['x-tenant']).toBe('t1');
  });
});

describe('saved probes on an auto channel with two protocols', () => {
  const autoChannelConfig: CustomProviderConfig = {
    id: 'supplier',
    name: 'Supplier',
    runtimes: {},
    channels: {
      version: 1,
      channels: [
        {
          id: 'auto-channel',
          name: 'Auto',
          protocols: {
            'anthropic-messages': {
              baseUrl: 'https://messages.example/v1',
              wireProtocol: 'anthropic-messages',
              models: [{ id: 'messages-model', name: 'Messages Model' }],
            },
            'openai-responses': {
              baseUrl: 'https://responses.example/v1',
              wireProtocol: 'openai-responses',
              models: [{ id: 'responses-model', name: 'Responses Model' }],
            },
          },
        },
      ],
    },
  };
  const autoId = 'auto-channel';
  const responsesEndpoint = {
    baseUrl: 'https://responses.example/v1',
    wireProtocol: 'openai-responses' as const,
    modelsUrl: null,
  };

  it('binds an unsaved draft model to the exact verified protocol key', () => {
    setCustomProviders(buildUserProviderChannels(autoChannelConfig));
    const read = vi.fn(
      (_id: string, _agent: string, protocol?: ProviderWireProtocol) =>
        protocol === 'openai-responses'
          ? 'responses-key'
          : protocol === 'anthropic-messages'
            ? 'messages-key'
            : 'first-model-guess',
    );
    setDiagnosticsKeyReader(read);
    const spec = resolveSavedProbeSpec(autoId, 'pi', {
      modelId: 'draft-model',
      endpoint: responsesEndpoint,
    });
    expect(spec).toMatchObject({
      modelId: 'draft-model',
      baseUrl: 'https://responses.example/v1',
      wireProtocol: 'openai-responses',
      apiKey: 'responses-key',
    });
    expect(read).toHaveBeenCalledWith(autoId, 'pi', 'openai-responses');
  });

  it('binds a fixed protocol provider to the same channel protocol slot', () => {
    setCustomProviders(buildUserProviderChannels(autoChannelConfig));
    const read = vi.fn(() => 'responses-key');
    setDiagnosticsKeyReader(read);
    const spec = resolveSavedProbeSpec(`${autoId}--openai-responses`, 'pi', {
      modelId: 'draft-model',
      endpoint: responsesEndpoint,
    });
    expect(spec.apiKey).toBe('responses-key');
    expect(read).toHaveBeenCalledWith(autoId, 'pi', 'openai-responses');
  });

  it('uses the containing protocol slot for a saved model', () => {
    setCustomProviders(buildUserProviderChannels(autoChannelConfig));
    const read = vi.fn(
      (_id: string, _agent: string, protocol?: ProviderWireProtocol) =>
        protocol === 'openai-responses' ? 'responses-key' : 'messages-key',
    );
    setDiagnosticsKeyReader(read);
    const spec = resolveSavedProbeSpec(autoId, 'pi', {
      modelId: 'responses-model',
      endpoint: responsesEndpoint,
    });
    expect(spec.apiKey).toBe('responses-key');
    expect(read).toHaveBeenCalledWith(autoId, 'pi', 'openai-responses');
  });

  it('rejects a different protocol endpoint before reading any key', () => {
    setCustomProviders(buildUserProviderChannels(autoChannelConfig));
    const read = vi.fn(() => 'should-not-be-read');
    setDiagnosticsKeyReader(read);
    expect(() =>
      resolveSavedProbeSpec(autoId, 'pi', {
        modelId: 'messages-model',
        endpoint: responsesEndpoint,
      }),
    ).toThrow(/endpoint differs/);
    expect(read).not.toHaveBeenCalled();
  });

  it('hydrates header-only credentials for the verified protocol only', () => {
    setCustomProviders(buildUserProviderChannels(autoChannelConfig));
    setDiagnosticsKeyReader(() => null);
    setCustomProviderHeaderReader((_channelId, _agent, protocol) =>
      protocol === 'openai-responses'
        ? { authorization: 'Bearer responses-header' }
        : { authorization: 'Bearer messages-header' },
    );
    const spec = resolveSavedProbeSpec(autoId, 'pi', {
      modelId: 'draft-model',
      endpoint: responsesEndpoint,
    });
    expect(spec.headers).toEqual({ authorization: 'Bearer responses-header' });
  });

  it('fails closed while the auto provider route mutation is open', () => {
    setCustomProviders(buildUserProviderChannels(autoChannelConfig));
    const read = vi.fn(() => 'saved-key');
    setDiagnosticsKeyReader(read);
    const release = beginProviderRouteMutation(autoId);
    try {
      expect(() =>
        resolveSavedProbeSpec(autoId, 'pi', {
          modelId: 'draft-model',
          endpoint: responsesEndpoint,
        }),
      ).toThrow(/configuration is being updated/);
    } finally {
      release();
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe('saved probe error summaries', () => {
  const channelConfig: CustomProviderConfig = {
    id: 'supplier',
    name: 'Supplier',
    runtimes: {},
    channels: {
      version: 1,
      channels: [
        {
          id: 'primary',
          name: 'Primary',
          protocols: {
            'anthropic-messages': {
              baseUrl: 'https://channel.example/v1',
              wireProtocol: 'anthropic-messages',
              models: [{ id: 'chat-a', name: 'chat-a' }],
            },
            'openai-chat': {
              baseUrl: 'https://chat.example/v1',
              wireProtocol: 'openai-chat',
              models: [{ id: 'chat-a', name: 'chat-a' }],
            },
          },
        },
      ],
    },
  };
  const providerId = 'primary--anthropic-messages';
  const endpoint = {
    baseUrl: 'https://channel.example/v1',
    wireProtocol: 'anthropic-messages' as const,
    modelsUrl: null,
  };

  async function probeWith(
    body: string,
    contentType: string,
    status: number,
    wire: 'anthropic-messages' | 'openai-chat' = 'anthropic-messages',
  ) {
    const opaque = `opaque-${randomUUID()}`;
    setCustomProviders(buildUserProviderChannels(channelConfig));
    setDiagnosticsKeyReader(() => null);
    setCustomProviderHeaderReader(() => ({ authorization: `Bearer ${opaque}` }));
    const seen: { authorization: string | null } = { authorization: null };
    const targetProviderId = wire === 'openai-chat' ? 'primary--openai-chat' : providerId;
    const targetEndpoint =
      wire === 'openai-chat'
        ? { baseUrl: 'https://chat.example/v1', wireProtocol: 'openai-chat' as const, modelsUrl: null }
        : endpoint;
    const result = await testProviderConnection(
      { kind: 'saved', providerId: targetProviderId, agent: 'pi', modelId: 'chat-a', endpoint: targetEndpoint },
      async (_url, init) => {
        seen.authorization = new Headers(init?.headers).get('authorization');
        return new Response(body.replaceAll('zzz_safe_marker_zzz', opaque), {
          status,
          headers: { 'content-type': contentType },
        });
      },
    );
    return { opaque, seen, result };
  }

  it('never returns JSON or text upstream errors that echo saved headers', async () => {
    for (const [contentType, status] of [
      ['application/json', 401],
      ['text/plain', 401],
    ] as const) {
      const { opaque, seen, result } = await probeWith(
        JSON.stringify({
          error: { message: 'rejected zzz_safe_marker_zzz', echo: { value: 'zzz_safe_marker_zzz' } },
          echoed: '__SAFE_MARKER__'
        }),
        contentType,
        status,
      );
      expect(seen.authorization).toBe(`Bearer ${opaque}`);
      expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
      expect(result).not.toHaveProperty('detail');
      expect(JSON.stringify(result)).not.toContain(opaque);
    }
  });

  it('never returns a streamed upstream error that echoes saved headers', async () => {
    const { opaque, result } = await probeWith(
      `data: ${JSON.stringify({ error: { message: 'rejected zzz_safe_marker_zzz' } })}\n\n`,
      'text/event-stream',
      200,
      'openai-chat',
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain(opaque);
  });
});

describe('provider probe redirect handling', () => {
  it('blocks same- and cross-origin redirects without a second request', async () => {
    for (const location of ['/v2/messages', 'https://other.example/v1/messages']) {
      const key = `opaque-${randomUUID()}`;
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual');
        return new Response(null, { status: 307, headers: { location } });
      });
      const result = await testProviderConnection(
        {
          kind: 'adhoc',
          spec: {
            agent: 'pi',
            baseUrl: 'https://gateway.example/v1',
            modelId: 'm',
            authMethod: 'apiKey',
            apiKey: key,
            headers: { 'x-custom-secret': key },
            wireProtocol: 'anthropic-messages',
          },
        },
        fetchImpl as unknown as typeof fetch,
      );
      expect(result).toMatchObject({ ok: false, code: 'REDIRECT_BLOCKED', status: 307 });
      expect(result).not.toHaveProperty('detail');
      expect(JSON.stringify(result)).not.toContain(key);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it('never forwards probe credentials to a redirect target through the real outbound fetch', async () => {
    const key = `opaque-${randomUUID()}`;
    const header = `header-${randomUUID()}`;
    let targetHits = 0;
    let sourceHeaders: Record<string, string | string[] | undefined> = {};
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const source = createServer((req, res) => {
      sourceHeaders = req.headers;
      res.writeHead(307, {
        location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`,
      });
      res.end();
    });
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    try {
      const result = await testProviderConnection(
        {
          kind: 'adhoc',
          spec: {
            agent: 'pi',
            baseUrl: `http://127.0.0.1:${(source.address() as AddressInfo).port}/v1`,
            modelId: 'm',
            authMethod: 'apiKey',
            apiKey: key,
            headers: { 'x-custom-secret': header },
            wireProtocol: 'anthropic-messages',
          },
        },
        outboundFetch,
      );
      expect(result).toMatchObject({ ok: false, code: 'REDIRECT_BLOCKED', status: 307 });
      expect(sourceHeaders['x-api-key']).toBe(key);
      expect(sourceHeaders['x-custom-secret']).toBe(header);
      expect(targetHits).toBe(0);
      expect(result).not.toHaveProperty('detail');
      expect(JSON.stringify(result)).not.toContain(key);
    } finally {
      await new Promise<void>((resolve) => source.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it('returns a safe summary for direct adhoc diagnostics as well', async () => {
    const opaque = `opaque-${randomUUID()}`;
    const result = await testProviderConnection(
      {
        kind: 'adhoc',
        spec: {
          agent: 'pi',
          baseUrl: 'https://gateway.example/v1',
          modelId: 'm',
          authMethod: 'apiKey',
          apiKey: opaque,
          headers: { 'x-custom-secret': opaque },
          wireProtocol: 'anthropic-messages',
        },
      },
      async () =>
        new Response(
          JSON.stringify({ error: { message: `bad ${opaque}` }, echo: opaque }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain(opaque);
  });
});

describe('native SDK redirect handling', () => {
  it('routes Google Generative AI probes through the redirect-safe HTTP path', async () => {
    const key = `opaque-${randomUUID()}`;
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain(':generateContent');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(key);
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { location: 'https://b.example' } });
    });
    const result = await runProviderProbe(
      {
        agent: 'pi',
        baseUrl: 'https://gemini.example/v1',
        modelId: 'gemini-fixture',
        api: 'google-generative-ai',
        wireProtocol: 'google-generative-ai',
        apiKey: key,
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_BLOCKED', status: 307 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps an SDK-swallowed redirect to REDIRECT_BLOCKED with the real status', async () => {
    const row = PROVIDER_MODEL_CATALOG.providers['mistral'][0];
    const key = `opaque-${randomUUID()}`;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { location: 'https://b.example' } });
    });
    const result = await runProviderProbe(
      {
        agent: 'pi',
        baseUrl: 'https://api.mistral.ai/v1',
        modelId: row.id,
        api: 'mistral-conversations',
        wireProtocol: 'openai-chat',
        apiKey: key,
        nativeModel: row,
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_BLOCKED', status: 307 });
    expect(result).not.toHaveProperty('detail');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('Google Generative AI 2xx responses', () => {
  const spec = {
    agent: 'pi' as const,
    baseUrl: 'https://gemini.example/v1',
    modelId: 'gemini-fixture',
    api: 'google-generative-ai' as const,
    wireProtocol: 'google-generative-ai' as const,
    apiKey: 'fixture-google-key',
  };

  it.each([
    ['HTML', 'text/html', '<html>OK</html>', 'WIRE_INCOMPATIBLE', 200],
    [
      'error JSON',
      'application/json',
      JSON.stringify({ error: { code: 401, message: 'unauthorized' } }),
      'AUTH_INVALID',
      401,
    ],
    ['empty JSON', 'application/json', '{}', 'WIRE_INCOMPATIBLE', 200],
    ['empty candidates', 'application/json', JSON.stringify({ candidates: [] }), 'WIRE_INCOMPATIBLE', 200],
    [
      'malformed candidates',
      'application/json',
      JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
      'WIRE_INCOMPATIBLE',
      200,
    ],
  ] as const)('fails closed for a 200 %s response', async (_label, contentType, body, code, status) => {
    const result = await runProviderProbe(
      spec,
      async () => new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    );
    expect(result).toMatchObject({ ok: false, code, status });
    expect(result).not.toHaveProperty('detail');
  });

  it('accepts a valid generateContent response', async () => {
    const body = JSON.stringify({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
      ],
    });
    const result = await runProviderProbe(
      spec,
      async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ['HTML', '<html>OK</html>', 'WIRE_INCOMPATIBLE'],
    ['error JSON', JSON.stringify({ error: { code: 401, message: 'unauthorized' } }), 'AUTH_INVALID'],
    ['empty JSON', '{}', 'WIRE_INCOMPATIBLE'],
    ['malformed candidates', JSON.stringify({ candidates: [{ content: { parts: [] } }] }), 'WIRE_INCOMPATIBLE'],
  ] as const)('validates an api-only Google probe against %s', async (_label, body, code) => {
    const apiOnly = {
      agent: 'pi' as const,
      baseUrl: 'https://gemini.example/v1',
      modelId: 'gemini-fixture',
      api: 'google-generative-ai' as const,
      apiKey: 'fixture-google-key',
    };
    const result = await runProviderProbe(
      apiOnly,
      async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code });
    expect(result).not.toHaveProperty('detail');
  });

  it('accepts a valid api-only Google response', async () => {
    const body = JSON.stringify({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
      ],
    });
    const result = await runProviderProbe(
      {
        agent: 'pi',
        baseUrl: 'https://gemini.example/v1',
        modelId: 'gemini-fixture',
        api: 'google-generative-ai',
        apiKey: 'fixture-google-key',
      },
      async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  const geminiBody = (finishReason?: string) =>
    JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'pong' }] },
          ...(finishReason === undefined ? {} : { finishReason }),
        },
      ],
    });

  it.each(['STOP', 'MAX_TOKENS'] as const)('accepts finishReason %s', async (finishReason) => {
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(geminiBody(finishReason), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('accepts a valid candidate without finishReason', async () => {
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(geminiBody(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    'SAFETY',
    'BLOCKLIST',
    'RECITATION',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
    'IMAGE_OTHER',
    'MALFORMED_FUNCTION_CALL',
    'UNEXPECTED_TOOL_CALL',
    'NO_IMAGE',
    'LANGUAGE',
    'OTHER',
    'FINISH_REASON_UNSPECIFIED',
    'SOMETHING_NEW',
  ] as const)('fails finishReason %s like the SDK stop mapping', async (finishReason) => {
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(geminiBody(finishReason), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(result).toMatchObject({ ok: false, code: 'RESPONSE_BLOCKED', status: 200 });
    expect(result).not.toHaveProperty('detail');
  });

  it('fails a blocked first candidate without content as RESPONSE_BLOCKED', async () => {
    const body = JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] });
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'RESPONSE_BLOCKED', status: 200 });
    expect(result).not.toHaveProperty('detail');
  });

  it('fails a blocked first candidate without content even when a later candidate succeeds', async () => {
    const body = JSON.stringify({
      candidates: [
        { finishReason: 'SAFETY' },
        { content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
      ],
    });
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'RESPONSE_BLOCKED' });
  });

  it('fails a successful finishReason without usable text', async () => {
    const body = JSON.stringify({ candidates: [{ finishReason: 'STOP' }] });
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE' });
  });

  it('reads the first candidate like the SDK', async () => {
    const mixed = JSON.stringify({
      candidates: [
        { content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
        { content: { parts: [{ text: 'blocked' }] }, finishReason: 'SAFETY' },
      ],
    });
    const firstOk = await runProviderProbe(
      spec,
      async () => new Response(mixed, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(firstOk).toMatchObject({ ok: true });

    const firstBlocked = JSON.stringify({
      candidates: [
        { content: { parts: [{ text: 'blocked' }] }, finishReason: 'SAFETY' },
        { content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
      ],
    });
    const secondOk = await runProviderProbe(
      spec,
      async () =>
        new Response(firstBlocked, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(secondOk).toMatchObject({ ok: false, code: 'RESPONSE_BLOCKED' });
  });

  it('fails a prompt blocked before any candidate', async () => {
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(result).toMatchObject({ ok: false, code: 'RESPONSE_BLOCKED', status: 200 });
  });

  it('does not expose credentials from a failing Google body stream', async () => {
    const key = `opaque-${randomUUID()}`;
    const header = `header-${randomUUID()}`;
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error(`body failed ${key} ${header}`));
      },
    });
    const result = await runProviderProbe(
      {
        agent: 'pi',
        baseUrl: 'https://gemini.example/v1',
        modelId: 'gemini-fixture',
        api: 'google-generative-ai',
        wireProtocol: 'google-generative-ai',
        apiKey: key,
        headers: { 'x-custom-secret': header },
      },
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE', status: 200 });
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(header);
  });

  it('returns a safe DTO when a probe body stream throws', async () => {
    const key = `opaque-${randomUUID()}`;
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error(`stream failed ${key}`));
      },
    });
    const result = await testProviderConnection(
      {
        kind: 'adhoc',
        spec: {
          agent: 'pi',
          baseUrl: 'https://gemini.example/v1',
          modelId: 'gemini-fixture',
          api: 'google-generative-ai',
          apiKey: key,
        },
      },
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE' });
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain(key);
  });

  const readErrors: Array<[string, Error, string]> = [
    ['TimeoutError', Object.assign(new Error('x'), { name: 'TimeoutError' }), 'TIMEOUT'],
    ['ReadTimeout', Object.assign(new Error('x'), { name: 'ReadTimeout' }), 'TIMEOUT'],
    ['BodyTimeoutError', Object.assign(new Error('x'), { name: 'BodyTimeoutError' }), 'TIMEOUT'],
    [
      'top-level UND_ERR_BODY_TIMEOUT',
      Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }),
      'TIMEOUT',
    ],
    [
      'cause UND_ERR_BODY_TIMEOUT',
      Object.assign(new Error('x'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }),
      'TIMEOUT',
    ],
    [
      'nested cause UND_ERR_BODY_TIMEOUT',
      Object.assign(new Error('x'), { cause: { cause: { code: 'UND_ERR_BODY_TIMEOUT' } } }),
      'TIMEOUT',
    ],
    ['ETIMEDOUT', Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'TIMEOUT'],
    [
      'AbortError without an expired deadline',
      Object.assign(new Error('x'), { name: 'AbortError' }),
      'WIRE_INCOMPATIBLE',
    ],
    ['ordinary error', new Error('x'), 'WIRE_INCOMPATIBLE'],
  ];
  it.each(readErrors)('classifies a body read %s as %s', async (_label, error, code) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    });
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code, status: 200 });
    expect(result).not.toHaveProperty('detail');
  });

  it(
    'times out a stalled Google body on the shared deadline and cancels it',
    async () => {
      const key = `opaque-${randomUUID()}`;
      let seenKey: string | undefined;
      let closed = false;
      const server = createServer((req, res) => {
        seenKey = req.headers['x-goog-api-key'] as string | undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"candidates":');
        res.on('close', () => {
          closed = true;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const result = await testProviderConnection(
          {
            kind: 'adhoc',
            spec: {
              agent: 'pi',
              baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
              modelId: 'gemini-fixture',
              api: 'google-generative-ai',
              wireProtocol: 'google-generative-ai',
              apiKey: key,
            },
          },
          outboundFetch,
        );
        expect(result).toMatchObject({ ok: false, code: 'TIMEOUT', status: 200 });
        expect(result.latencyMs).toBeGreaterThanOrEqual(9_000);
        expect(result).not.toHaveProperty('detail');
        expect(JSON.stringify(result)).not.toContain(key);
        expect(seenKey).toBe(key);
        await new Promise<void>((resolve) => {
          const started = Date.now();
          const poll = () =>
            closed || Date.now() - started > 2_000 ? resolve() : setTimeout(poll, 20);
          poll();
        });
        expect(closed).toBe(true);
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    15_000,
  );

  it(
    'cancels a cooperative stalled body reader on the deadline',
    async () => {
      let sourceCancel = 0;
      const late: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
        controller: null,
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          late.controller = controller;
        },
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          sourceCancel += 1;
          return Promise.resolve();
        },
      });
      const result = await runProviderProbe(
        spec,
        async () =>
          new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      expect(result).toMatchObject({ ok: false, code: 'TIMEOUT', status: 200 });
      expect(sourceCancel).toBe(1);
      // A source that resolves after the deadline cannot overwrite the result.
      try {
        late.controller?.enqueue(new TextEncoder().encode('late'));
      } catch {
        /* the canceled stream may reject late writes */
      }
      await Promise.resolve();
      expect(result.code).toBe('TIMEOUT');
    },
    15_000,
  );

  it(
    'returns TIMEOUT and still requests cancel for a non-cooperative body source',
    async () => {
      let sourceCancel = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          sourceCancel += 1;
          return new Promise(() => {});
        },
      });
      const result = await runProviderProbe(
        spec,
        async () =>
          new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      expect(result).toMatchObject({ ok: false, code: 'TIMEOUT', status: 200 });
      expect(sourceCancel).toBe(1);
    },
    15_000,
  );

  it('keeps the known status for a non-2xx body read timeout', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error('x'), { name: 'ReadTimeout' }));
      },
    });
    const result = await runProviderProbe(
      spec,
      async () =>
        new Response(stream, { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
    expect(result).not.toHaveProperty('detail');
  });

  it('does not expose a fetch error message that echoes credentials', async () => {
    const key = `opaque-${randomUUID()}`;
    const result = await testProviderConnection(
      {
        kind: 'adhoc',
        spec: {
          agent: 'pi',
          baseUrl: 'https://gemini.example/v1',
          modelId: 'gemini-fixture',
          api: 'google-generative-ai',
          apiKey: key,
        },
      },
      async () => {
        throw new Error(`request failed ${key}`);
      },
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('detail');
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe('native SDK HTTP status classification', () => {
  const row = PROVIDER_MODEL_CATALOG.providers['mistral'][0];
  it.each([
    [401, 'AUTH_INVALID'],
    [403, 'AUTH_FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_ERROR'],
  ] as const)('uses the actual Mistral %s status instead of a body code', async (status, code) => {
    const result = await runProviderProbe(
      {
        agent: 'pi',
        baseUrl: 'https://api.mistral.ai/v1',
        modelId: row.id,
        api: 'mistral-conversations',
        wireProtocol: 'openai-chat',
        apiKey: 'fixture-mistral-key',
        nativeModel: row,
      },
      async () =>
        new Response('{"error":{"message":"no code field"}}', {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(result).toMatchObject({ ok: false, code, status });
  });
});

describe('native SDK connection probes', () => {
  it.each(['saved', 'adhoc', 'header-only'] as const)(
    'refuses a %s Vertex probe because its SDK cannot disable redirects',
    async (kind) => {
      const row = PROVIDER_MODEL_CATALOG.providers['google-vertex'][0];
      const baseUrl = 'https://us-central1-aiplatform.googleapis.com';
      const globalFetch = vi.fn(async () => {
        throw new Error('must not send');
      });
      vi.stubGlobal('fetch', globalFetch);
      const wrongTransport = vi.fn(async () => {
        throw new Error('must not send');
      });
      setCustomProviders([
        buildUserProvider({
          id: 'vertex-test',
          name: 'Vertex',
          auth: { method: 'apiKey' },
          runtimes: {
            pi: {
              baseUrl,
              wireProtocol: 'google-generative-ai',
              catalogPresetId: 'google-vertex',
              models: [{ id: row.id, name: row.name, piApi: 'google-vertex' }],
            },
          },
        }),
      ]);
      setDiagnosticsKeyReader(() => 'fixture-vertex-key');
      try {
        const result = await testProviderConnection(
          kind === 'saved'
            ? { kind, providerId: 'vertex-test', agent: 'pi' }
            : {
                kind: 'adhoc',
                spec: {
                  agent: 'pi',
                  baseUrl,
                  modelId: row.id,
                  api: 'google-vertex',
                  wireProtocol: 'google-generative-ai',
                  ...(kind === 'header-only'
                    ? { headers: { 'X-Goog-Api-Key': 'fixture-vertex-key' } }
                    : { apiKey: 'fixture-vertex-key' }),
                },
              },
          wrongTransport,
        );
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: false,
          code: 'PROBE_UNSUPPORTED',
        });
        expect(globalFetch).not.toHaveBeenCalled();
        expect(wrongTransport).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('does not turn an SDK authentication error into a successful probe', async () => {
    const row = PROVIDER_MODEL_CATALOG.providers['mistral'][0];
    const result = await runProviderProbe(
      {
        agent: 'pi',
        baseUrl: 'https://api.mistral.ai/v1',
        modelId: row.id,
        api: 'mistral-conversations',
        wireProtocol: 'openai-chat',
        apiKey: 'fixture-mistral-key',
        nativeModel: row,
      },
      async () =>
        new Response('{"error":{"code":401,"message":"invalid api key"}}', { status: 401 }),
    );
    expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
  });
});


it('keeps the Copilot SDK identity but uses the assigned enterprise host for connection tests', () => {
  const row = PROVIDER_MODEL_CATALOG.providers['github-copilot'].find(row => row.execution.pi.api === 'openai-responses')!;
  setCustomProviders([buildUserProvider({ id: 'copilot-probe', name: 'Copilot',
    auth: { method: 'oauth', oauth: providerPresetOAuth('github-copilot')! },
    runtimes: { codex: { baseUrl: row.upstream, catalogPresetId: 'github-copilot', wireProtocol: 'openai-responses',
      models: [{ id: row.id, name: row.name, api: 'openai-responses' }] } },
  })]);
  setDiagnosticsOAuthTokenReader(() => 'fixture;proxy-ep=proxy.enterprise.githubcopilot.com;');
  try {
    expect(resolveSavedProbeSpec('copilot-probe', 'codex')).toMatchObject({
      baseUrl: 'https://api.enterprise.githubcopilot.com', api: 'openai-responses',
      nativeModel: { upstream: row.upstream, execution: { pi: { headers: expect.objectContaining({ 'Copilot-Integration-Id': 'vscode-chat' }) } } },
    });
  } finally { setDiagnosticsOAuthTokenReader(() => null); }
});


it('does not let a saved Vertex probe inherit Desktop ADC against an unrelated host', async () => {
  setCustomProviders([buildUserProvider({
    id: 'vertex-attacker', name: 'Vertex', auth: { method: 'apiKey' },
    runtimes: { pi: { baseUrl: 'https://attacker.example', wireProtocol: 'google-generative-ai',
      models: [{ id: 'gemini-fixture', name: 'Gemini', piApi: 'google-vertex' }] } },
  })]);
  const fetchSpy = vi.fn(async () => { throw new Error('must not send'); });
  const result = await testProviderConnection(
    { kind: 'saved', providerId: 'vertex-attacker', agent: 'pi' }, fetchSpy);
  expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('refuses a Bedrock probe on an approved host because its SDK exposes no trusted status', async () => {
  const fetchSpy = vi.fn(async () => { throw new Error('must not send'); });
  const approved = await runProviderProbe({
    agent: 'pi',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    modelId: 'claude-fixture',
    api: 'bedrock-converse-stream',
    apiKey: 'not-an-aws-key',
  }, fetchSpy);
  expect(approved).toMatchObject({ ok: false, code: 'PROBE_UNSUPPORTED' });
  // The existing endpoint allowlist still wins for unapproved destinations.
  const unapproved = await runProviderProbe({
    agent: 'pi',
    baseUrl: 'https://attacker.example',
    modelId: 'claude-fixture',
    api: 'bedrock-converse-stream',
    apiKey: 'not-an-aws-key',
  }, fetchSpy);
  expect(unapproved).toMatchObject({ ok: false, code: 'AUTH_INVALID' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('does not let an adhoc Vertex probe inherit Desktop ADC against an unrelated host', async () => {
  const fetchSpy = vi.fn(async () => { throw new Error('must not send');
  });
  const result = await runProviderProbe({
    agent: 'pi',
    baseUrl: 'https://attacker.example',
    modelId: 'gemini-fixture',
    api: 'google-vertex',
    wireProtocol: 'google-generative-ai',
    authMethod: 'apiKey',
  }, fetchSpy);
  expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('does not replace an explicit Chat probe with the preset’s Google SDK', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://proxy.example/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gemini-2.5-flash', messages: expect.any(Array) });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  expect(await runProviderProbe({ agent: 'pi', baseUrl: 'https://proxy.example/v1', modelId: 'gemini-2.5-flash',
    catalogPresetId: 'google-vertex', wireProtocol: 'openai-chat', apiKey: 'fixture-key' }, fetcher)).toMatchObject({ ok: true });
  expect(fetcher).toHaveBeenCalledOnce();
});
