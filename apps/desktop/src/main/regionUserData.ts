/**
 * regionUserData — 按构建区域选择 Electron userData 目录。
 *
 * Lex 只有一个正式安装身份。历史 region 构建参数仍存在于上游兼容层，但 cn/global
 * 都在 main 入口最早期落到同一个正式 userData 目录；内部 dev 身份保持独立。
 *
 * 语义边界:
 *  - 正式 cn/global 都返回同一个 Lex profile 名；不按账号服务区分库。
 *  - 非 packaged 启动同样解析这份身份映射；`--isolated` 再由 devCliFlags
 *    基于所得目录派生 `<正式目录>-dev2[-<名字>]`。
 *  - 命令行显式传了 Chromium 原生 `--user-data-dir` 时返回 null，尊重调用方。
 *    `XDT_USER_DATA_DIR` 是 devCliFlags 的最终覆写；这里仍先建立区域默认
 *    profile，确保隔离 epoch comparison 以 LexGlobal / LexDev 为基线。
 *  - 只决定**目录名**,拼绝对路径(appData 基址)留给调用方——本模块保持
 *    零 Electron 依赖,可直接单测。
 */

import {
  BRAND_IDENTITY,
  brandUserDataDirName,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/** argv 里是否显式指定了 Chromium 原生 --user-data-dir(= 与空格两种形态)。 */
function hasExplicitUserDataDir(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
}

/**
 * 解析本构建是否需要覆写 userData 目录。
 * 返回目录名(调用方拼到 appData 下)或 null(保持 Electron 默认)。
 */
export function resolveRegionUserDataDirName(input: {
  isPackaged: boolean;
  region: CindyRegion;
  argv: readonly string[];
  envUserDataDir?: string;
}): string | null {
  if (hasExplicitUserDataDir(input.argv)) return null;
  const dirName = brandUserDataDirName(input.region);
  // 若未来某个身份与 productName 默认目录同名，就无需重复覆写。
  if (dirName === BRAND_IDENTITY.userDataDirName) return null;
  return dirName;
}
