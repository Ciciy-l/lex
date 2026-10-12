/**
 * legalLinks — 服务条款 / 隐私协议链接的区域分流单点(consent PR,与桌面
 * shared/legalLinks.ts 同 URL 权威源)。
 *
 * 登录页按用户选择的服务分区，已登录页面按当前账号所属分区。
 * 国内走 protocol.xd.cn，Global 走 protocol.xd.com，服务协议保留 Cindy 归属。
 * 链接一律 `Linking.openURL` 交系统默认浏览器打开。
 */

import { getActiveMobileSessionRealm } from '@/config/env';
import type { AuthRegion } from '@cindy/auth-client';

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

/** Legal URLs follow the login selection, or the authenticated session realm. */
export function legalLinksForRealm(realm: AuthRegion): LegalLinks {
  return realm === 'cn' ? CN_LEGAL_LINKS : GLOBAL_LEGAL_LINKS;
}
export const LEGAL_LINKS: LegalLinks = {
  get termsOfService() { return legalLinksForRealm(getActiveMobileSessionRealm()).termsOfService; },
  get privacyPolicy() { return legalLinksForRealm(getActiveMobileSessionRealm()).privacyPolicy; },
};
