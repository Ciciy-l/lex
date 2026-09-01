/**
 * branding — 产品品牌展示名的单一事实源（single source of truth）。
 *
 * 目标：把散落在 UI 文案、窗口标题、LLM 可见描述里的品牌名收敛到一处，
 * 未来改名只改这里（i18n 文案经 defaultVariables 注入 {{appName}} 同步生效）。
 *
 * 边界（改名时也【不要】跟随本常量变化的标识符，改了会造成数据迁移事故）：
 * 磁盘 / 协议 / 系统注册层标识符统一由 brandIdentity.ts 管理（2026-07 身份翻转时
 * 一次性切换并各自钉死），包括深链协议、userData 目录名、productName、deviceId
 * 前缀、AppUserModelId、bundle id，以及浏览器自动化的受管 profile 目录名
 * （mcp-integrations/browser.ts 的 MANAGED_PROFILE，翻转时定格 'Cindy'）。
 * 这些标识符之后同样不跟随本常量变化——与展示名解耦正是本模块存在的意义。
 *
 * 稳定标识符边界由本模块常量和相关测试维护，不随展示名迁移。
 */

/** Lex 对用户 / LLM 展示的品牌名（唯一规范写法，不要再派生其它变体）。 */
export const BRAND_NAME = 'Lex';
