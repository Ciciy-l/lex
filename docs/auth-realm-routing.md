# Lex Desktop 账号服务区路由

Lex Desktop 只发布一个安装包、一个系统身份和一个更新通道。中国大陆与 Global
在本文中表示 **Cindy 账号服务区（realm）**，不表示两个 Lex 版本。权威产品边界见
[`product-rules/region-and-editions.md`](./product-rules/region-and-editions.md)。

## 三类状态

- `compatBuildRegion`：上游兼容构建参数。它仍用于旧凭证迁移、开发端点自举和内部
  `dev` 身份，但 `cn` / `global` 必须映射到同一个 Lex app ID、可执行文件、
  userData 目录和更新通道。它不能用于判断当前账号的数据面。
- `selectedPersonalRealm`：未登录或新增账号时，用户在登录页明确选择的
  `cn | global`。Main 持有真值，Renderer 只能通过受信任 IPC 请求变更。
- `activeSessionRealm`：登录成功后与凭证绑定的服务区。保存账号切换、冷启动刷新和
  运行时 token 轮换都从凭证记录恢复该值。

Lex 产品官网、支持入口、GitHub Release 和更新清单不随账号 realm 改变。Cindy
账号、订阅、模型、Device Link、远控和其他带账号语义的在线服务随会话 realm 路由。

## 个人登录

登录页默认选择 Global，并允许用户切换到中国大陆。切换后 Main 先加载目标 realm
的受信任端点清单，再返回该区的登录方式；邮箱/手机号、验证码、Captcha、社交登录
和 Cindy 官方协议链接都复用同一个冻结 realm。

一旦进入浏览器跳转或已经得到组织发现结果，本次流程的 realm 不能再切换。取消、
reset 或失败清理临时票据；已登录账号在新账号提交成功前不受影响。

## 企业 SSO 发现

企业 ID、组织 slug 或已验证域名会在 CN/Global 两区分别发现组织归属：

- 一区成功、另一区明确返回 `ORG_SSO_NOT_FOUND`：使用成功区域。
- 两区都成功：返回 `ORG_REALM_AMBIGUOUS`，不猜测。
- 两区都明确未找到：保留 `ORG_SSO_NOT_FOUND`。
- 任一区超时、不可达、响应非法或区域不匹配：返回
  `ORG_REALM_UNAVAILABLE`，即使另一侧成功也 fail closed。

发现结果与登录页当前选择不同时，界面必须先显示目标服务区并取得确认，再允许启动
SSO。后续 authorize、callback、授权码兑换、联系方式验证和 membership 选择始终
复用发现得到的 realm。

## 邮箱域名的企业发现

邮箱入口在用户提交完整邮箱后，会提取并小写化域名，复用上述双区组织发现；不会在
逐字输入时请求，也不会向对端发送完整邮箱。跨区命中时，复用现有目标区域确认文案，
确认后提供该企业的 SSO 连接，同时保留个人邮箱验证码选项。个人验证码始终走当前
`selectedPersonalRealm`；确认企业区域不会把个人账号、验证码或社交登录迁往另一地区。

同区企业继续使用原有邮箱 discovery 的登录方式列表；两区都明确未找到时继续普通
邮箱登录。歧义、网络故障和非法响应仍遵守上面的失败规则，不当作未找到而自动发码。
服务端现有 `POST /api/auth/sso/discovery` 已支持已验证域名、企业名称、区域和启用的
SSO 连接，无需改接口。未验证域名、未启用 SSO 的企业不在本次发现范围内。
实现见 `packages/auth-client/src/emailLoginDiscovery.ts`，回归见同目录
`__tests__/emailLoginDiscovery.test.ts`。

## 个人登录后的企业提示

Google、Apple、邮箱/手机验证码、补绑和身份选择等新登录，统一在收到最终个人
membership 后检查邮箱域名（Desktop `finishFreshLogin`、Mobile `acceptOutcome`）。
只使用服务端返回的邮箱；已通过邮箱入口完成发现的同一邮箱不重复提示。已是企业身份、
没有有效邮箱、冷启动恢复、刷新 token 和切换已保存账号不触发此提示。

发现可用企业时，同区和跨区均显示区域及两个选择：使用企业 SSO，或继续刚完成的个人
登录。个人登录结果仅暂存在 main / AuthContext 内存，UI 状态只有发现信息和可继续标记。
继续个人登录直接提交原结果和原区域；选择企业 SSO 则丢弃临时个人结果，并在企业区域
重新授权。不会把个人 token、Google/Apple 凭据或两区 passport 互相转移。

此阶段的发现属于可选提示：未找到、歧义、限流或网络失败都保留原个人登录，不猜测
企业区域。取消本次登录或开始新流程后，迟到发现结果不能恢复旧登录。此规则只适用于
已经成功的个人认证；用户主动提交邮箱或企业标识时仍执行前述严格发现规则。

## 端点清单与缓存

CN 与 Global 的清单自举地址都是构建期信任锚。客户端下载清单时记录目标 realm，
并要求清单自报的 region（若存在）与目标一致：

- `*.cindy.com.cn` 属于中国大陆服务区；
- `*.cindy.app` 属于 Global 服务区；
- 只有源码明确列出的共享 Hook 端点可以跨域。

两区缓存使用独立文件。网络失败时只允许读取同一 realm、同一 `sourceUrl` 的缓存，
读回后重新做严格语法和主机白名单校验。解析失败、region 不匹配或不可信主机不得
降级到缓存，也不得退回兼容构建区域发送 token。旧版单文件缓存只可作为其原构建区
的一次性兼容候选。

## 移动端边界

Mobile 的 Pending OAuth 同时保存 `realm`，但 redirect scheme 始终使用当前安装包的
scheme。个人验证码和社交登录使用其当前个人 realm，也不合并两区 passport；邮箱提交时
新增的域名发现只为引导企业 SSO。

## 凭证、账号与本地数据

Desktop safeStorage/vault 保存带 realm 的凭证记录。保存账号的 key 与展示摘要也带
realm；冷启动、刷新和账号切换必须先加载记录所属 realm 的端点，再发送 token。
token 轮换先原子写回原 realm，之后才发布新登录态。

当前 Cindy Device Link 与本地多处存储仍要求使用服务端的裸 membership ID，不能
直接把对外 owner 改成 `realm:id`。同时，两区并未承诺 membership ID 全局唯一。
在后续 Profile Registry 以 `(realm, membershipId)` 全面派生本地 namespace 之前，
Lex 采用兼容优先的过渡保护：如果设备上已知另一 realm 使用相同裸 ID，拒绝激活
第二个身份并返回 `ACCOUNT_NAMESPACE_CONFLICT`。显式登录会回滚本次凭证提交；
冷启动或运行时刷新保留服务端刚轮换的有效 token，但不发布冲突身份。

## 运行期消费者

活动 realm 变化时，Main 先切换账号端点，再重载或失效以下消费者：

- Model Access 目录、Provider 推荐和 XD 能力投影；
- 订阅、余额、账单币种和用量展示；
- IM Bot 区域可见性；
- Cindy 官网、移动端下载二维码和官方协议链接；
- Device Link、远控及其他使用当前账号令牌的连接。

Renderer 可以使用 `AuthState.serviceRealm` 调整展示，但不能据此拼接服务 URL；URL
仍由 Main 的已校验端点表提供。Lex 自身的更新地址始终来自
`config/lex-product.json`，不参与账号 realm 切换。

## Mobile 边界

当前 Lex 里程碑只发行 Desktop。仓库中的 Mobile 仍是上游 Cindy 客户端；Lex
Desktop 的二维码按当前账号 realm 指向相应 Cindy 官方移动端下载页。本文不改变
Cindy Mobile 自身的安装、凭证或推送协议。

## 验收要点

1. 同一个 Lex 安装可以分别登录 CN 和 Global 账号，系统身份与更新通道不变。
2. 登录每个子流程只使用 Main 冻结的 realm，Renderer 不能自行改写路由。
3. 保存账号、冷启动和 token 轮换不会把一侧凭证发送到另一侧端点。
4. 两区清单缓存互不覆盖，且缓存不能扩大编译期主机信任边界。
5. 同裸 membership ID 的跨 realm 身份在 Profile Registry 完成前 fail closed。
6. 账号切换后模型、Provider、账单、IM、协议与 Cindy Mobile 下载入口同步刷新。
7. Lex Release、官网、支持入口和自动更新始终保持 Lex 自有单通道。
