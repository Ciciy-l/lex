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
