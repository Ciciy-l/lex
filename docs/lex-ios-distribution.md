# Lex iOS 安装与更新方案

本轮目标是让 iOS 连接 Lex Admin，并评估「GitHub Actions 定期续签，App 提醒用户更新」。
用户目前只有普通 Apple ID，且不希望最终用户安装或操作重签工具。

## 免费签名的实际边界

Apple 的 Personal Team 面向本人设备开发测试：最多登记 10 个 App ID、3 台设备，
每台设备最多安装 3 个 App；安装用 provisioning profile 在签发 7 天后过期。
Apple 要求周期性重新生成配置、构建并重新安装。这个期限由 profile 决定，
重复用同一个 profile 签名不会延长它的有效期。

因此，Actions 能构建新包、校验产物、发布更新元数据，但这些步骤并不能提供
Personal Team 的通用安装授权。包仍绑定签名团队和指定设备，不是所有用户都能安装的
公开 IPA。免费账号的配置由 Xcode 管理；没有已验证的、无需交互即可长期生成新免费
profile 的官方 CI 流程。不能把 Apple ID 密码、二次验证或私人登录会话作为公共仓库的
定时工作流配置。

即使某次成功生成了新签名包，服务器上的新包也不会更新手机上已安装的签名。
用户必须通过可用的安装渠道完成覆盖安装。普通 iOS App 无法像 Android APK 更新器
那样自行安装下载的 IPA；免费 Personal Team 不提供面向普通用户的公开 OTA 分发渠道。
包过期后 App 无法启动，也不能指望过期后再从 App 内检查更新。

## 当前可执行的选择

| 使用场景 | 构建与安装 | 用户负担与限制 |
| --- | --- | --- |
| 当前本机开发 | Mac 构建模拟器包；真机通过 Xcode Personal Team 安装 | 真机需要设备配对、开发者模式、7 天内重新部署；不作为公开分发 |
| 免费侧载实验 | CI 可构建未签名 IPA，再由电脑/手机重签工具安装刷新 | 需要重签工具或等价的设备配对服务，不满足本轮「普通用户不用工具」目标 |
| 普通用户测试 | 付费 Apple Developer + Actions 构建上传 + TestFlight | 用户只需 TestFlight；可接收更新，每个测试构建最多有效 90 天，外部测试受 Beta Review 管理 |
| 正式公开使用 | 付费 Apple Developer + App Store | 经审核发布，安装更新走系统渠道 |

建议保留「有新版本时提醒并跳转安装渠道」的产品交互，将真正分发通道与 Android
实现分开。当前先交付 iOS 连接能力和本地验证，不开放无可安装产物的下载/更新按钮，
不建立一个会把旧 profile 重新打包后误报为「续签成功」的定时任务。

若后续选择 TestFlight，再实现受保护的发布工作流：签名材料仅放 CI secret/临时钥匙串，
上传使用受限 App Store Connect API key，成功回执包含构建号、处理/审核状态和真实
安装入口；未审核/未可用时不得向客户端宣告可安装。无需在客户端实现 7 天免费续签。
目前没有生成真机签名包、部署续签服务或发布 iOS 更新通道。

## 依据（2026-10-31 核对）

- [Apple Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account/)：Personal Team 的设备、App ID、安装数量与 7 天限制；分发所需会员能力。
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)：90 天构建有效期、测试邀请、外部审核及用户安装更新流程。

模拟器的可运行证据不等于 iPhone 签名、安装、续期或发布验收。实际签名方案确定后仍需
在真机验证首次安装、覆盖升级、数据保留、账号恢复和证书/profile 过期处理。
