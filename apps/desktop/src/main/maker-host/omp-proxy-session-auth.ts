/**
 * OMP 请求进共享 loopback Anthropic compat proxy 的 per-session 鉴权。
 *
 * 与 Pi 的差异来自真机实测(v18.1.18,`docs/omp-rpc-spike.md` §10):OMP **不对**
 * models.yml 的 header 值做环境变量插值 —— `$VAR` / `${VAR}` 会原样发出。所以
 * 会话 token 不能走专用 header,只能走 `apiKey` 写的 env **变量名**通道:OMP 把
 * 该 env 的值以 `Authorization: Bearer <token>` 发出来,proxy 从这个头取回。
 *
 * token 是 owner-scoped 导出密钥的确定性派生(`deriveOmpProxySessionToken`),
 * 因此本模块不需要注册表,也没有注册/注销生命周期 —— 只回答一个问题:
 * 「这个 sessionId 此刻该有的 bearer,是不是请求里带的这个」。
 */

import { timingSafeEqual } from 'node:crypto';

import { deriveOmpProxySessionToken } from './omp-proxy-session-token.js';

/**
 * 从 `Authorization: Bearer <token>` 取回 OMP 会话 token。
 *
 * 只认标准 bearer 形态:OMP 的 apiKey 通道**只会**产出 `Authorization: Bearer`,
 * 其它形态(含把 token 塞进 x-api-key)一律不认 —— 放宽等于给伪造多开一条路。
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
