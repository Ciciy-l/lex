# Lex 发行版与 Cindy 服务区

> **状态**：权威产品规则（authoritative）
> **适用范围**：Lex 的安装身份、更新渠道、登录、端点选择、区域文案与发布流程
> **最后变更**：2026-09-03，产品所有者确认采用单一 Lex 发行版

## 1. 产品关系

Lex 是基于开源 Cindy 客户端构建、由社区独立维护的桌面发行版。Lex 拥有自己的
产品名、安装身份、用户数据目录、官网、支持入口和更新渠道；账号、订阅、云模型、
对象存储、语音、Device Link 与远程控制等在线能力由 Cindy 官方服务提供。

这两个维度必须分开：

- **Lex product identity**：一个安装包、一个正式 app/bundle ID、一个用户数据目录、
  一个版本号、一个 GitHub Release 和一个自动更新通道。
- **Cindy service realm**：`global` 或 `cn`，是登录会话及账号凭证的属性，不是 Lex
  的发行版、下载版本或系统身份。

Apache-2.0 授权适用于源码，不自动授予 Cindy 商标或官方云服务的运营权。对外说明
必须明确 Lex 是社区发行版，不代表 Cindy 或 XD Inc. 官方。

### 1.1 品牌表面矩阵

判断用户可见名称时先看“谁拥有这个表面或能力”，不要按源码目录名机械替换：

| 表面 / 能力 | 用户可见归属 | 实现约束 |
| --- | --- | --- |
| Desktop 应用、窗口标题、菜单、通知、安装器、更新器、日志、数据库、本地终端、内置浏览器与 iOS Simulator 宿主 | **Lex** | 代码走 `BRAND_NAME` / `BRAND_IDENTITY.displayName`，locale 走 `{{appName}}` |
| 新任务品牌块、登录/Splash 本地产品标识、分享图片页脚、默认主题可见名、关于页和本地联系方式 | **Lex** | 使用 Lex 字标与角色资产；Light / Dark 同时覆盖 |
| 账号、登录服务区、订阅、支付、Cindy AI、官方语音、Device Link、远程服务 | **Cindy** | 明确写 Cindy；服务区仍是账号属性，不得写成 Lex CN / Lex Global |
| Cindy 官方 bot、官方市场、签名/审核信任、插件与社区生态 | **Cindy** | 不把上游服务或信任背书改称 Lex；Lex 只描述本地安装、校验、启停等宿主动作 |
| `.cindy`、`cindy://`、`@cindy/*`、`CINDY_*`、主题 family ID、存储键、协议字段和迁移目录名 | **稳定兼容标识** | 默认保留；可见说明可同时解释 Lex 宿主与 Cindy 生态，禁止为“去 Cindy 化”破坏兼容 |
| 当前仓库内尚未迁移的 `/issue` 官方提交通道 | **Cindy 上游** | 在 Lex 自有反馈目标落地前，不得宣称会提交给 Lex；Lex 联系入口独立占位 |

本矩阵允许同一屏同时出现两个名字，例如“Lex 无法连接 Cindy 服务”或“在 Lex 中登录
Cindy 账号”。这不是品牌不一致，而是必须保留的责任边界。

## 2. 单一发行版不变量

1. 面向用户只发布一个 Lex Desktop。不得重新引入 Global/CN 两套安装包、两套
   app ID、两套更新清单或按语言拆分的产物。
2. `global` 与 `cn` 的正式构建身份必须解析到同一个 Lex app ID 和同一个 userData
   目录；`dev` 可以保留独立的 `LexDev` 身份。
3. Lex 官网、下载页、支持入口和应用更新清单属于产品范围，永远不随 Cindy
   登录账号的服务区切换。
4. Cindy 账号相关端点属于会话范围，必须跟随经过验证并持久化在凭证记录中的 realm。
   包括 auth、订阅/模型、OAuth broker、OSS、Voice、Device Link 和相关长连接。
5. Lex 更新清单地址与 Cindy 服务端点清单地址必须是独立的构建期信任锚；不得再从
   Lex 更新地址推导 CN/Global 服务地址，也不得把两区可信域合并成一个宽泛白名单。

## 3. 登录与服务区选择

### 3.1 个人账号

- 新的个人登录默认展示 `Global`，并提供明确的 Cindy 服务区切换入口。
- 用户可以选择 `Global` 或「中国大陆」；邮箱/手机号形态、验证码、社交登录、
  Captcha 和 Cindy 官方协议链接随选择结果切换。
- 选择由 Electron Main 持有并通过运行期校验的 IPC 改变。Renderer 只展示 Main
  返回的结果，不能把本地 UI 状态当作路由真值。
- 登录成功后，realm 与加密 refresh credential 一起按账号保存。冷启动、刷新和
  已保存账号切换必须按该账号的 realm 加载端点后再使用 token。
- 不得根据系统语言、IP、时区、下载镜像或地理位置静默猜测账号 realm。

### 3.2 企业 SSO

- 企业 SSO 继续在 CN/Global 两个官方 realm 做发现，由服务端结果决定组织归属。
- 发现结果与当前个人登录选择不同时，登录页显示明确确认；确认前不能把连接 ID
  加入可启动的 SSO 白名单。
- 任一区域清单不可用时 fail closed，不凭另一侧成功结果猜测组织区域。

## 4. 安全边界

- CN 凭证只能发送给从 CN 信任锚加载并严格校验的服务端点；Global 同理。
- realm 端点缓存必须按 `cn` / `global` 隔离或保留等价的显式 namespace，读回时
  重新解析并按对应区域域名验证。禁止采用「两个 Cindy 域都可信」的并集策略。
- Lex 更新资产只从 Lex 的更新信任锚解析。Cindy 官方 CLI runtime 资产在尚未镜像
  前可以使用绝对 URL，但不能因此把应用更新通道切回 Cindy。
- 凭证仍只存 Main 的 safeStorage/vault；Renderer 不接触 token、realm/account
  复合键或服务端票据。
- Cindy 的两个 realm 没有承诺共享 membership ID 命名空间。当前本地数据层仍以裸
  membership ID 作为 owner；在 Profile Registry 全面接管本地存储前，如果同一裸 ID
  已出现在另一 realm，Lex 必须拒绝激活该会话，不能冒险打开另一账号的数据库或密钥。
  这条 fail-closed 保护不得影响 Device Link 对外仍使用 Cindy 服务端的裸 membership ID。

## 5. 对外文案

- 英文服务区名称使用 `Global` 与 `Mainland China`；中文使用 `Global` 与
  「中国大陆」。它们描述 Cindy 服务区，不描述 Lex 版本。
- 允许并鼓励使用：`Lex is a community desktop distribution based on Cindy.`
- 必须同时说明：Cindy Account、Cindy Subscription 和远程在线服务由 Cindy 官方
  提供，其条款、区域可用性和服务状态由 Cindy 负责。
- 不得把 Lex 表述为 Cindy 官方产品，也不得暗示 Lex 运营 Cindy 账号或订阅。

## 6. Mobile 与内部兼容名

- 当前里程碑只发行 Lex Desktop。仓库中的 Mobile 代码仍属于上游 Cindy 客户端；
  对外可说明 Lex Desktop 能配合 Cindy 官方移动端，不发布“Lex Mobile”。
- `@cindy/*`、`CINDY_*`、`cindy://`、存储键和协议字段属于上游同步或服务兼容层，
  不做机械改名。只有用户可见的产品身份归 Lex。
- `CindyRegion` 作为历史构建/兼容类型可以暂时保留，但不能再被解释为两个 Lex
  用户发行版。

## 7. 验收清单

涉及区域或发行改动时逐项确认：

1. 是否仍只生成一套正式 Lex 产物和一个更新通道？
2. Lex 安装身份、官网、支持或更新地址是否意外随账号 realm 改变？
3. 个人登录选择是否由 Main 管理，且所有 auth 子流程使用同一冻结 realm？
4. 保存账号、冷启动与刷新是否先加载凭证记录的 realm 端点再发送 token？
5. 企业 SSO 是否仍双区发现并在跨区时要求确认？
6. CN/Global token 是否可能通过缓存、回退或默认值被发送到另一 realm？
7. UI 新文案是否同步覆盖 `zh-CN / zh-TW / en / ja / ko`？
8. 是否保留 Cindy 源码归属与在线服务责任边界？

修改本文意味着改变 Lex 的发行和服务边界，必须先获得产品所有者明确决策，并同步
修改实现、测试、README 与发布工作流。
