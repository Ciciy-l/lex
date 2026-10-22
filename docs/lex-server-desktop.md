# Lex Server Desktop 接入

主界面仍默认进入未登录本地模式。主动登录可选 Lex Server 或 Cindy；Cindy 原有双区登录不变。
Lex Server 地址是设备服务的 **origin**（例如 `https://lex.example.com` 或本机开发
`http://127.0.0.1:3101`），不是管理后台 `:3100/admin`。不接受路径、用户信息、查询或片段；
除 loopback 外必须 HTTPS，证书正常校验。修改地址等于添加另一服务，不能给旧凭据更换目的地。

## 认证与本地兼容

- 匿名、有界检查 `/health`、`/ready`、`/api/auth/providers` 的 JSON 合同。检查不携带旧凭据，
  认证请求禁止重定向。只支持管理员已预建的邮箱账号，不注册、不向 Cindy 发现邮箱。
- 复用 Main 登录事务、可信 IPC、safeStorage 与 owner 切换；验证码和 device-bound 身份选择票据
  留在 Main。多身份选择保留 OTP 返回的账号级凭据。取消检查/登录只使本次 epoch 失效。
- 服务键由规范 origin 决定：`lex-server:<origin>`。资源凭据键为 `[serviceKey,membershipId]`，
  账号级凭据键为 `[serviceKey,passportId]`；本地数据 owner 为该 scope 与 membershipId 的散列。
  远程协议仍使用裸 UUID。同邮箱或同 UUID 的不同部署不会共用本地任务、草稿或凭据。
- 旧会话 v1、凭据库 v1/v2 和原 `cn/global` key 继续读取。旧记录没有 service 时仍属于原 Cindy 区域，
  旧数据库和 owner 不搬迁。Lex 使用带 service 的会话 v2 和凭据库 v3；纯 Cindy 仍写兼容格式。
  旧客户端不能恢复 Lex 记录，不应同时用旧客户端管理同一 profile。
- 切换只选择已存账号，不 logout。显式退出沿既有设备/账号撤权、独立 tombstone 和原子回滚路径，
  不删除另一服务同 ID 的记录。离线或密文不可读时保留凭据，不回退 Cindy，也不持久化 local 覆盖恢复。
  Lex 最后一个可用账号明确退出后回到未登录主界面；有其它可用保存账号时仍沿原切换路径，Cindy 的退出落点不变。
- Lex refresh 严格单次轮换。跨进程锁覆盖读、请求和 durable CAS；每个服务/认证 epoch 复用在途请求。
  发出前先持久化 token 的不可逆指纹，替代凭据成功落盘的同一事务才清除。已知离线不发请求；
  响应丢失、5xx、格式错误或成功后的磁盘失败均不重放旧 token。此时明确要求正常重新登录，
  不能仅凭客户端判断服务端是否已提交。保留原密文及指纹不等于可以自动重试未知提交。

## 端点与能力

账号、profile、设备目录、WebSocket 与共享均从选定 origin 的固定 `/api/*` 路径访问，
不信任响应自报端点。连接与请求捕获 service、owner 和 generation；切服务拆掉旧连接、仲裁和投影。
共享邀请为同 origin 的 `/shared-task/join#token`，仅在 Lex 内粘贴；不自动访问外来邀请地址。

首轮范围包括邮箱登录/恢复/刷新/切换/退出、多成员身份、设备目录、基础远程任务与任务共享。
Lex 不提供模型中转、托管模型、订阅、语音、OSS 云附件、TURN、push 投递、系统凭据交接或自动解锁；
这些账号服务在 Main 边界不可用，不能将 Lex token 当作 Cindy global token。用户手配模型、CLI、
本地插件凭据不清除；软件更新与下载信任锚独立。Android/iOS 本轮不新增入口，共享层旧调用兼容。

实现与合成定向测试不代替两 Desktop 的真实 OTP、多身份、重启、远程和共享实窗验收；
交付报告分别记录实际通过、阻断及未验项，不把类型绿当作认证或远程通过。
