/**
 * brandRegion — Cindy 上游兼容构建区域与 Lex 系统身份的运行时单点。
 *
 * 区域在**构建期**经 VITE_CINDY_AUTH_REGION 烘焙(main 走 vite.main.config.ts
 * 的 define,renderer 走标准 Vite env;生产由 desktopClientBuildEnv 注入,dev /
 * 未注入一律默认 global)。这个值只保留给上游兼容、旧数据迁移和内部 dev 身份，
 * **不是当前登录账号的服务区**。Lex 的 cn/global 兼容值必须解析到同一个 appId、
 * 可执行文件和 userData 目录；账号使用 CN 还是 Global Cindy 服务由 authManager
 * 在运行期按凭证 realm 管理。只有 dev 仍可使用独立的系统身份。
 *
 * ⚠️ AUMID 三位一体:本文件的 CURRENT_APP_ID 必须与 NSIS appId(forge.config
 * 按同一 region 从 brandAppId() 取值)、快捷方式 AUMID 逐字符一致,否则
 * Windows toast 通知被静默丢弃。
 */

import {
  brandAppId,
  resolveCindyRegion,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/** 上游兼容构建区域(构建期烘焙；不是当前账号 realm；dev 默认 global)。 */
export const CURRENT_CINDY_REGION: CindyRegion = resolveCindyRegion(
  import.meta.env?.VITE_CINDY_AUTH_REGION,
);

/** Lex 系统身份 id(Windows AUMID / macOS bundle id；cn/global 同值)。 */
export const CURRENT_APP_ID: string = brandAppId(CURRENT_CINDY_REGION);
