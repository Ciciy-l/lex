/**
 * brand-identity — 产品**标识符层**身份的单一事实源(构建期单点)。
 *
 * 与 `branding.ts`(展示名层,`BRAND_NAME`)互补:那边管用户/LLM 看到的名字,
 * 这边管 OS 注册身份与磁盘/协议标识符——exe 名、AppUserModelId/bundle id、
 * 深链 scheme、userData 目录名、CDN 渠道前缀、更新器产物名等。
 *
 * 2026-09-02 Lex 独立发行版身份隔离:
 * 主值全部切换为 Lex 系,旧值移入 legacy 数组供兼容读取与未来数据迁移方案
 * 使用。本仓构建从此产出 Lex 身份的包(新装用户直装);存量 xdt-maker/Cindy 用户
 * 停留在冻结渠道,待后续独立设计的自动迁移方案接走。
 *
 * ⚠️ 语义边界:
 *  - Lex 正式发行只有一个系统身份。历史 `cn` / `global` 参数继续存在于 Cindy
 *    服务兼容层，但二者必须解析到同一个 appId、可执行名和 userData 目录；
 *    `dev` 仍是独立内部身份。
 *  - 历史兼容锚点(旧 scheme 解析、旧 userData / DB 文件识别)由
 *    `legacySchemes` / `legacyUserDataDirNames(ByRegion)` / `legacyDbFilePrefixes`
 *    承载,只增不减:老用户机器上的存量注册与文件可能永远带着旧值。
 *  - 永久不随本配置变化的标识符(settings 键名 `xdtMaker.*`、
 *    `xdt-image://` 等进程内 scheme、`.cshare` 扩展名、
 *    localStorage 键等)由各自协议/存储模块维护,
 *    不要试图从这里派生它们。
 *  - `updaterName` = `lex-updater`(Lex 独立发行版使用独立更新器产物名,
 *    docs/dev-rules/cindy-updater.md;老渠道已冻结、新应用未发过版,无自更新兼容包袱)。
 *    消费方:updateService(resources 源名 + %TEMP% 运行名)、forge prePackage
 *    构建/签名/extraResource、notices 脚本登记路径。
 *
 * 消费方:
 *  - apps/desktop forge.config.ts(executableName / appId / protocols / UTI)
 *  - apps/desktop main 常量(AUMID、深链、orphan-reaper 路径标记、skillhub
 *    usageIndexer 的 userData 兜底路径、localDb 文件名前缀)
 *  - release / publish / smoke 脚本(产物名、OSS 前缀)
 */

import { BRAND_NAME } from './branding.js';

/**
 * 历史构建/服务兼容维度(与 mobile 的 EXPO_PUBLIC_CINDY_AUTH_REGION 同语义)。
 * 2026-07-20 新增第三目标 `dev`:独立系统身份(CindyDev,可与 cn/global 同机
 * 三装),连接独立的 dev 服务器(config/endpoint.dev.json,服务端就绪前为
 * 约定占位域名)。行为语义上 dev 归 cn 系(登录线/文案等运行时按区域分支处
 * 与 cn 同待遇),差异只在端点与身份。注意与「开发模式(未注入区域的本地
 * dev 构建)」区分:那仍默认 global 身份。
 */
export type CindyRegion = 'cn' | 'global' | 'dev';

/** 默认区域:Global。开发模式 / 未显式注入区域的构建一律落在这里。 */
export const DEFAULT_CINDY_REGION: CindyRegion = 'global';

/**
 * 归一化区域输入(构建脚本 env / 运行时注入值)。空值 → 默认 global;
 * 非法值抛错——打包链路宁可失败也不能默默打出身份错误的包。
 */
export function resolveCindyRegion(raw?: string | null): CindyRegion {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_CINDY_REGION;
  if (v === 'cn' || v === 'global' || v === 'dev') return v;
  throw new Error(`Invalid Cindy region: ${raw}; expected cn, global or dev`);
}

/** 标识符层身份配置的完整形状。字段语义见各注释;全部为纯数据,零运行时逻辑。 */
export interface BrandIdentity {
  /** 展示名(与 branding.ts 的 BRAND_NAME 同源,这里仅聚合成完整档案)。 */
  readonly displayName: string;
  /**
   * 可执行文件基名(Windows 加 .exe;mac Mach-O 名同源派生)。
   * 首字母大写是产品决策；Windows 进程匹配大小写不敏感，产物 key 命名走
   * 小写的 `cdnPrefix`，互不影响。打包与运行时统一走
   * `brandExecutableName(region)`，本字段供无区域的兼容消费点使用。
   */
  readonly executableName: string;
  /**
   * 按兼容区域参数派生的可执行文件基名(exe / mac .app 包名 / 安装目录 /
   * NSIS 快捷方式全部跟随)。Lex 的 cn/global 参数必须同值，保证只有一个正式
   * 安装身份；dev 保持独立名，可与正式包并存。
   */
  readonly executableNameByRegion: Readonly<Record<CindyRegion, string>>;
  /**
   * Windows AppUserModelId = NSIS appId = macOS bundle id。Lex 的 cn/global
   * 兼容参数同值，避免账号服务区改变安装身份。
   * ⚠️ AUMID 三位一体:NSIS appId、运行时 setAppUserModelId、快捷方式 AUMID
   * 必须逐字符一致,否则 Windows toast 通知被静默丢弃。取值经 `brandAppId()`。
   */
  readonly appIdByRegion: Readonly<Record<CindyRegion, string>>;
  /** 深链主 scheme(OS 级注册,`<scheme>://session/...`;cn/global 不区分)。 */
  readonly primaryScheme: string;
  /** 历史 scheme,永久保持注册 + 解析兼容(存量链接不能死)。只增不减。 */
  readonly legacySchemes: readonly string[];
  /**
   * Electron 默认派生的 userData 目录名(= package.json productName)。正式
   * cn/global 兼容参数通过下表统一到既有 LexGlobal profile，避免已测试用户的
   * safeStorage 数据因目录迁移失效。
   */
  readonly userDataDirName: string;
  /** 按区域派生的 userData 目录名。 */
  readonly userDataDirNameByRegion: Readonly<Record<CindyRegion, string>>;
  /** 品牌翻转前的共享历史 userData 目录名(首登 mToc 迁移使用)。只增不减。 */
  readonly legacyUserDataDirNames: readonly string[];
  /**
   * 各兼容区域曾经使用过的 userData 目录名。按路径识别进程的消费点只可加入
   * 当前正式目录和本参数明确拥有的历史目录，避免误杀旧产品实例。只增不减。
   */
  readonly legacyUserDataDirNamesByRegion: Readonly<
    Record<CindyRegion, readonly string[]>
  >;
  /**
   * 各区域的 sessions.working_dir 迁移来源。它与进程路径归属清单故意分离。
   */
  readonly legacyDialogueUserDataDirNamesByRegion: Readonly<
    Record<CindyRegion, readonly string[]>
  >;
  /**
   * 更新分发的一级路径前缀。Lex 只有一个正式更新通道，本字段不随 Cindy
   * 账号服务区派生。
   */
  readonly cdnPrefix: string;
  /** 更新器/迁移执行器产物基名(`<updaterName>.exe`)。 */
  readonly updaterName: string;
  /** 本地主库文件名前缀(`<dbFilePrefix>-<userId>.db`)。 */
  readonly dbFilePrefix: string;
  /** 历史主库文件名前缀；首登本地迁移扫描旧库时只增不减。 */
  readonly legacyDbFilePrefixes: readonly string[];
}

/**
 * 当前生效的身份档案(Lex 独立发行版)。
 * 旧 xdt-maker 值全部下沉 legacy 数组。
 *
 * cn/global 兼容参数共享同一个正式 Lex appId、可执行名、userData、更新器与
 * 更新通道；仅 dev 保持独立身份。Cindy 账号 realm 在运行期由 auth/endpoint
 * 层处理，不得在这里重新派生第二套 Lex 身份。
 */
export const BRAND_IDENTITY: BrandIdentity = Object.freeze({
  displayName: BRAND_NAME,
  executableName: 'Lex',
  executableNameByRegion: Object.freeze({
    cn: 'Lex',
    global: 'Lex',
    dev: 'LexDev',
  }),
  appIdByRegion: Object.freeze({
    cn: 'com.ciciy.lex',
    global: 'com.ciciy.lex',
    dev: 'com.ciciy.lexdev',
  }),
  // Deep-link protocol remains `cindy://` for cross-client compatibility;
  // OS installation identity is isolated by the Lex app/bundle IDs above.
  primaryScheme: 'cindy',
  legacySchemes: Object.freeze(['xdt-maker']),
  userDataDirName: 'Lex',
  userDataDirNameByRegion: Object.freeze({
    // Lex has one production installation/profile identity. Keep the already
    // exercised Global profile name to avoid invalidating safeStorage data.
    cn: 'LexGlobal',
    global: 'LexGlobal',
    dev: 'LexDev',
  }),
  legacyUserDataDirNames: Object.freeze(['xdt-maker']),
  legacyUserDataDirNamesByRegion: Object.freeze({
    cn: Object.freeze(['xdt-maker']),
    global: Object.freeze([]),
    dev: Object.freeze([]),
  }),
  legacyDialogueUserDataDirNamesByRegion: Object.freeze({
    cn: Object.freeze(['xdt-maker']),
    // xdt-maker 是旧 CN 渠道的数据来源；Global 不导入或改写 CN 的历史 cwd。
    global: Object.freeze([]),
    dev: Object.freeze([]),
  }),
  cdnPrefix: 'lex',
  updaterName: 'lex-updater',
  dbFilePrefix: 'lex',
  legacyDbFilePrefixes: Object.freeze(['xdt-maker']),
});

/** 按区域取 appId(AUMID / bundle id);默认 global。 */
export function brandAppId(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.appIdByRegion[region];
}

/** 自有 UTI / ProgId 等派生标识的前缀(如 `<prefix>.cindy` UTI),随区域 appId 走。 */
export function brandBundleIdPrefix(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.appIdByRegion[region];
}

/** 按区域取可执行文件基名(exe / mac .app / 安装目录 / 快捷方式名);默认 global。 */
export function brandExecutableName(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.executableNameByRegion[region];
}

/** 按区域取 Electron userData 目录名;默认 global。 */
export function brandUserDataDirName(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.userDataDirNameByRegion[region];
}

/** 深链需要注册/解析的全部 scheme(主 + 历史),顺序稳定:主 scheme 恒为首位。 */
export function allDeepLinkSchemes(identity: BrandIdentity = BRAND_IDENTITY): readonly string[] {
  return [identity.primaryScheme, ...identity.legacySchemes];
}

/**
 * 按路径识别本产品 userData 的全部目录名(唯一正式目录 + 当前兼容参数明确拥有的
 * 历史名)，正式目录恒为首位。历史名仍按参数收窄，避免 orphan-reaper 等消费点
 * 误认领旧产品或内部 dev 实例。
 */
export function allUserDataDirNames(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return [
    identity.userDataDirNameByRegion[region],
    ...identity.legacyUserDataDirNamesByRegion[region],
  ];
}

/**
 * 按区域取持久化 dialogue cwd 的历史 userData 目录名。只用于数据迁移，
 * 绝不能用于判断进程归属或清理另一实例。
 */
export function legacyDialogueUserDataDirNames(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return identity.legacyDialogueUserDataDirNamesByRegion[region];
}

/** 品牌翻转前的共享老目录候选，仅供 cn 的 mToc 首登数据导入。 */
export function legacyBrandUserDataDirNames(
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return identity.legacyUserDataDirNames;
}
