/**
 * OMP 请求进共享 loopback Anthropic compat proxy 的 per-session 鉴权。
 *
 * 与 Pi 的差异来自真机实测(v18.1.18,`docs/omp-rpc-spike.md` §10):OMP **不对**
 * models.yml 的 header 值做环境变量插值 —— `$VAR` / `${VAR}` 会原样发出。所以
 * 会话 token 不能走专用 header,只能走 `apiKey` 写的 env **变量名**通道:OMP 把
 * 该 env 的值交给原生传输。原有 Messages/OpenAI 路径使用 Bearer；新增的
 * Google 原生路径使用 x-goog-api-key（依据固定 v18.10.4 源码，尚未实机验证）。
 *
 * token 是 owner-scoped 导出密钥的确定性派生(`deriveOmpProxySessionToken`),
 * 因此本模块不需要注册表,也没有注册/注销生命周期 —— 只回答一个问题:
 * 「这个 sessionId 此刻该有的 bearer,是不是请求里带的这个」。
 */

import { timingSafeEqual } from 'node:crypto';

import { deriveOmpProxySessionToken } from './omp-proxy-session-token.js';

/** Google carries the model in the URL, not in the native request body. */
export function parseOmpGoogleRequest(requestUrl: string): { model: string; path: string } | null {
  try {
    const url = new URL(requestUrl, 'http://127.0.0.1');
    const match = /^\/v1beta\/models\/([^/?]+):(streamGenerateContent|generateContent)$/u.exec(
      url.pathname,
    );
    if (!match) return null;
    const model = decodeURIComponent(match[1]);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) return null;
    // Never forward a credential embedded in a query string. OMP's native
    // Google transport only needs alt=sse on the streaming operation.
    if ([...url.searchParams.keys()].some((key) => key !== 'alt')) return null;
    if (url.searchParams.has('alt') && url.searchParams.get('alt') !== 'sse') return null;
    return { model, path: `/models/${encodeURIComponent(model)}:${match[2]}${url.search}` };
  } catch {
    return null;
  }
}

/** Accept Google's native credential header only on the Google front door. */
export function readOmpRequestToken(
  headers: Readonly<Record<string, string>>,
  requestUrl: string,
): string | null {
  if (!parseOmpGoogleRequest(requestUrl)) return readOmpBearerToken(headers);
  const values = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === 'x-goog-api-key',
  );
  if (values.length !== 1 || !/^\S+$/u.test(values[0][1])) return null;
  return values[0][1];
}

/**
 * 从 `Authorization: Bearer <token>` 取回 OMP 会话 token。
 *
 * 此函数只处理 Messages/OpenAI 路径，仍只认标准 bearer 形态。Google 的
 * x-goog-api-key 由 readOmpRequestToken 按明确的 Google 路径单独读取。
 */
export function readOmpBearerToken(headers: Readonly<Record<string, string>>): string | null {
  let raw: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && typeof value === 'string' && value.length > 0) {
      raw = value;
      break;
    }
  }
  if (raw === null) return null;
  const match = /^Bearer[ \t]+(\S+)$/iu.exec(raw.trim());
  return match?.[1] ?? null;
}

/**
 * 校验 OMP 会话 token。
 *
 * 派生失败(安全存储不可用)按**认证失败**处理:此刻没有任何值能被信任,
 * 宁可让 OMP 会话拿不到模型,也不能放行一个无法验真的请求。
 */
export function authenticateOmpProxySession(sessionId: string, candidate: string | null): boolean {
  if (!sessionId || !candidate) return false;
  let expected: string;
  try {
    expected = deriveOmpProxySessionToken(sessionId);
  } catch {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  if (expectedBytes.length !== candidateBytes.length) return false;
  return timingSafeEqual(expectedBytes, candidateBytes);
}
