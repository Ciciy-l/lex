/**
 * ompProxyAuth.test.ts —— OMP 进共享 loopback proxy 的凭证通道与网关路由。
 *
 * 真机事实(v18.1.18,`docs/omp-rpc-spike.md` §10):OMP **不对** models.yml 的
 * header 值做环境变量插值,会话 token 只能走 `apiKey` env 名通道 —— OMP 把它
 * 以 `Authorization: Bearer <token>` 发出来。因此:
 *
 *   · token 从 Authorization 取,**不是**从 `x-cindy-omp-*` 头取(那些头只做
 *     路由识别,loopback 不是安全边界,任何本地进程都能伪造);
 *   · 把 token 塞进 `x-api-key` 一律不认 —— 放宽等于给伪造多开一条路;
 *   · 只有 session id 没有合规 bearer → 401,绝不能掉进 Claude / Pi 的默认路由。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));

vi.mock('../logger-adapter', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function self() {
      return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: self };
    }),
  }),
  desktopMakerLogger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function self() {
      return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: self };
    }),
  },
}));

vi.mock('../runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://gateway.example.com',
}));

vi.mock('../silent-encrypted-retry-store', () => ({
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
}));

vi.mock('../claude-fast-mode-log', () => ({
  createClaudeFastModeRequestTransform: () => () => null,
  createClaudeFastModeResponseObserver: () => () => undefined,
}));

// 派生确定性化:安全存储在测试环境不可用,这里钉成可预测的值。
vi.mock('../pi-proxy-session-token.js', () => ({
  deriveOmpProxySessionToken: (sessionId: string) => `omp-tok-${sessionId}`,
  derivePiProxySessionToken: (sessionId: string) => `pi-tok-${sessionId}`,
}));

import { createModelRoutingTransform, setClaudeProxyGatewayKeyReader } from '../anthropic-compat-proxy-host';
import {
  authenticateOmpProxySession,
  readOmpBearerToken,
} from '../omp-proxy-session-auth';

const OMP_HEADERS = {
  'x-cindy-omp-session-id': 'sess-omp',
  'x-cindy-omp-provider-id': 'cindy',
};

function ctxWith(headers: Record<string, string>, url = '/v1/messages') {
  return { reqId: 1, method: 'POST', url, headers } as never;
}

/** 触发 localHandler 并解出它写回的 JSON 错误体。 */
async function errorBodyOf(
  decision: Awaited<ReturnType<ReturnType<typeof createModelRoutingTransform>>>,
): Promise<{ status: number; code: string }> {
  const writeHead = vi.fn();
  const end = vi.fn();
  await decision?.localHandler?.({ res: { writeHead, end } } as never);
  return {
    status: writeHead.mock.calls[0][0] as number,
    code: JSON.parse(end.mock.calls[0][0] as string).error.code as string,
  };
}

describe('readOmpBearerToken', () => {
  it('reads the standard bearer form', () => {
    expect(readOmpBearerToken({ authorization: 'Bearer abc' })).toBe('abc');
  });

  it('is case-insensitive about the scheme', () => {
    expect(readOmpBearerToken({ Authorization: 'bearer abc' })).toBe('abc');
  });

  it('rejects non-bearer schemes', () => {
    expect(readOmpBearerToken({ authorization: 'Basic abc' })).toBeNull();
  });

  it('rejects a bearer without a token', () => {
    expect(readOmpBearerToken({ authorization: 'Bearer' })).toBeNull();
    expect(readOmpBearerToken({ authorization: 'Bearer ' })).toBeNull();
  });

  it('returns null when the header is absent', () => {
    expect(readOmpBearerToken({ 'x-api-key': 'abc' })).toBeNull();
  });
});

describe('authenticateOmpProxySession', () => {
  it('accepts the derived token for the session', () => {
    expect(authenticateOmpProxySession('sess-omp', 'omp-tok-sess-omp')).toBe(true);
  });

  it('rejects a token derived for another session', () => {
    expect(authenticateOmpProxySession('sess-omp', 'omp-tok-other')).toBe(false);
  });

  it('rejects a Pi token even for the same session id', () => {
    expect(authenticateOmpProxySession('sess-omp', 'pi-tok-sess-omp')).toBe(false);
  });

  it('rejects empty candidates', () => {
    expect(authenticateOmpProxySession('sess-omp', null)).toBe(false);
    expect(authenticateOmpProxySession('', 'omp-tok-')).toBe(false);
  });
});

describe('OMP gateway route in cc routingTransform', () => {
  let gatewayKey: string | null;

  beforeEach(() => {
    gatewayKey = 'sk-gw';
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
  });

  afterEach(() => {
    setClaudeProxyGatewayKeyReader(() => null);
  });

  it('takes the token from Authorization and swaps in the gateway key', () => {
    const decision = createModelRoutingTransform()(
      { model: 'claude-sonnet-4-6' },
      ctxWith({ ...OMP_HEADERS, authorization: 'Bearer omp-tok-sess-omp' }),
    );
    expect(decision).toMatchObject({ headerOverride: { authorization: 'Bearer sk-gw' } });
    // OMP 的识别头只在本地有意义,绝不能带到上游。
    expect(decision?.headerDelete).toEqual(
      expect.arrayContaining(['x-cindy-omp-session-id', 'x-cindy-omp-provider-id']),
    );
  });

  it('rejects a forged session token with 401', async () => {
    const decision = createModelRoutingTransform()(
      { model: 'claude-sonnet-4-6' },
      ctxWith({ ...OMP_HEADERS, authorization: 'Bearer forged' }),
    );
    await expect(errorBodyOf(decision)).resolves.toEqual({
      status: 401,
      code: 'invalid_omp_session_token',
    });
  });

  it('does not accept the token via x-api-key', async () => {
    const decision = createModelRoutingTransform()(
      { model: 'claude-sonnet-4-6' },
      ctxWith({ ...OMP_HEADERS, 'x-api-key': 'omp-tok-sess-omp' }),
    );
    await expect(errorBodyOf(decision)).resolves.toEqual({
      status: 401,
      code: 'invalid_omp_session_token',
    });
  });

  it('rejects an OMP request that carries no session id', async () => {
    const decision = createModelRoutingTransform()(
      { model: 'claude-sonnet-4-6' },
      ctxWith({ 'x-cindy-omp-provider-id': 'cindy' }),
    );
    await expect(errorBodyOf(decision)).resolves.toEqual({
      status: 401,
      code: 'invalid_omp_session',
    });
  });

  it('refuses the default upstream when no gateway key can be swapped in', async () => {
    gatewayKey = null;
    const decision = createModelRoutingTransform()(
      { model: 'claude-sonnet-4-6' },
      ctxWith({ ...OMP_HEADERS, authorization: 'Bearer omp-tok-sess-omp' }),
    );
    await expect(errorBodyOf(decision)).resolves.toEqual({
      status: 503,
      code: 'omp_gateway_unavailable',
    });
  });

  it('leaves requests without OMP headers on the existing Claude path', () => {
    // 没有 OMP 头 → 不许走 OMP 分支(否则会误伤 cc / pi 的全部流量)。
    const decision = createModelRoutingTransform()(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).not.toMatchObject({ headerDelete: expect.any(Array) });
  });
});
