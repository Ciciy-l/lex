/**
 * legalLinks — 服务条款 / 隐私协议链接的区域分流单点。
 *
 * Lex 只有一个安装包，协议链接按当前 Cindy 账号服务区解析。国内走
 * protocol.xd.cn，国际走 protocol.xd.com；链接一律经系统默认浏览器打开(renderer 走
 * `window.electronAPI.openExternal`,channel `shell:open-external` 只放行 http(s))。
 */

export interface LegalLinks {
  /** 服务条款 */
  termsOfService: string;
  /** 隐私协议 */
  privacyPolicy: string;
}

const CN_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://protocol.xd.cn/cindy/agreement.html',
  privacyPolicy: 'https://protocol.xd.cn/cindy/privacy-1.0.html',
};

const GLOBAL_LEGAL_LINKS: LegalLinks = {
  termsOfService: 'https://protocol.xd.com/cindy/agreement-1.0.html',
  privacyPolicy: 'https://protocol.xd.com/cindy/privacy.html',
};

/** 登录页按 Main 返回的服务区选择 Cindy 官方条款。 */
export function legalLinksForRealm(realm: 'cn' | 'global'): LegalLinks {
  return realm === 'global' ? GLOBAL_LEGAL_LINKS : CN_LEGAL_LINKS;
}
