# Lex iOS 下载、签名与更新

Lex 提供面向 iPhone/iPad 真机的未签名 IPA。构建不需要发行方的 Apple 签名凭据或付费开发者账号；普通 iPhone 仍不能直接安装未签名 IPA。用户需要自行选择签名与安装方法。

## 下载与安装

1. 在 [Lex Releases](https://github.com/Ciciy-l/lex/releases) 选择所需版本，下载名称为 `Lex-<version>-iOS-unsigned.ipa` 的文件。正式版和预发布版请按自己的更新偏好选择。
2. 查看同名 `.update.json` 与 `SHA256SUMS.txt`，核对文件大小和 SHA-256；最低 iOS 版本以该包的元数据为准。
3. 使用自己信任的工具签名并安装。Lex 不接收 Apple ID 密码、证书或个人 provisioning profile，也不替用户操作这些工具。
4. 更新时尽量沿用原来的签名工具、团队与安装身份，并先备份重要数据。不要把更换签名身份、改变 bundle ID 或卸载重装当作无损升级；这些操作可能使原数据、Keychain 或账号状态不可访问。

可自行评估的路径包括 Xcode Personal Team 本人设备开发安装、AltStore Classic/AltServer、Sideloadly，以及已拥有有效开发者凭据的签名工具。工具的版本、设备/iOS、App ID 和 entitlement 支持不同；本仓未逐项验证兼容性，不保证所有工具都能重签此 IPA。Xcode 是源码构建/开发部署路径，不是“点开下载 IPA 即可安装”。

[AltStore Classic](https://faq.altstore.io/) 依赖自己的安装与刷新流程；它与欧盟替代应用市场 AltStore PAL 不是同一分发途径。这里不提供 PAL 安装承诺。本轮未增加 AltStore source JSON；先使用真实 Release 文件手动导入工具，不要将 GitHub Release 页误当成 source URL。

## 应用内检查更新

Lex iOS 启动或回到前台时自动检查，最多每六小时一次；同一版本的自动提醒间隔至少 24 小时。设置中可随时手动检查、切换是否接收预发布版，或忽略当前版本。手动检查仍可找到被忽略的版本。预发布安装默认接收 beta，正式安装默认接收 stable；明确保存的用户选择优先，切换 Cindy 服务区不会改变更新来源。

更新页显示发行说明、大小、构建号和最低系统要求。系统过旧时先提示升级 iOS，不提供不兼容的下载按钮。“下载 IPA”只打开下载链接，“查看安装说明”打开本页；不会调用 Android 安装器或承诺自动安装。无清单、离线或清单损坏会分别提示，不能当作“已经最新”。

发布流程从已上传的真实 IPA 生成 stable/beta 清单，包含版本/build、最低 OS、大小、SHA-256 和发行说明。App 仅接受 Lex 官方仓库的固定 Release 路径，检查不携带登录凭据，不接受远程任意下载地址或重定向清单。IPA 文件由外部浏览器/工具下载，用户仍需核对下载文件；App 不声称在浏览器中完成了文件校验。

## 签名到期与版本更新是两件事

Personal Team 免费开发配置通常七天到期，并受 App ID、设备数和同时安装数量限制。以 Apple 当前规则和工具实际显示为准。签名/profile 到期后，即使没有新 Lex 版本，也可能需要重新签名安装；有新版本也不会延长手机上旧包的签名。过期 App 可能无法启动，不能依赖它过期后再提醒。

重复使用过期或同一份 profile 签名不会延长期限。GitHub Actions 生成新 IPA 不会给用户设备提供安装授权，也不能替代用户的刷新流程。项目不配置定期免费续签、Apple ID 自动登录、收费 CI 平台或 App Store/TestFlight 上传。

当前原生工程保留既有权限描述、URL scheme、推送/Apple 登录等 capability 配置。未签名 IPA 不携带授予这些能力的签名 entitlement/profile；重签工具可能要求调整或剥离不支持的 entitlement，相关能力随后可能不可用。普通本地/远程功能、通知、社交登录、Universal Link、Keychain 和服务端注册身份须按实际签名环境分别验收，不能用编译成功证明已获得 Apple 能力。

## 开发与制品核验

`.github/workflows/mobile-ios.yml` 支持手动仅生成 CI artifact，不创建正式 Release。正式发行由 `desktop-release.yml` 统一编排，必须等待 iOS 成功。完整顺序见 [Releasing Lex](RELEASING-LEX.md)。

本机在干净的独立检出中使用 Node 22、根 packageManager 指定的 pnpm、Xcode 26.6（17F113，iPhoneOS SDK 26.5）和 CocoaPods 1.17.0。先遵守 [环境准备规则](dev-rules/environment-setup.md)。构建器拒绝覆盖已存在的 `apps/mobile/ios` 或同名输出；请保留原目录，不要为重试删除开发者工程。

```sh
pnpm install --frozen-lockfile
# 仅缺少该忽略文件时，从仓库公开模板建立 Metro 解析所需的占位文件。
[ -e config/endpoint.dev.json ] || cp config/endpoint.dev.json.example config/endpoint.dev.json
DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer LEX_IOS_REQUIRE_PINNED_TOOLCHAIN=1 LEX_MOBILE_BUILD=1 LEX_MOBILE_VERSION=0.1.15 node scripts/build-lex-ios.mjs
```

产物在 `dist/ios/`，必须包含 `Payload/<app>.app`、arm64 真机二进制、离线 `main.jsbundle` 和资源；`CFBundleSupportedPlatforms` 必须是 `iPhoneOS`。最低 OS 从实际归档 Info.plist 读取，不能以模拟器支持版本代替。既有 LexServiceWebSocketModule 由 Expo/CocoaPods 自动链接，缺少该 pod 会阻断构建。
源码有未提交修改时生成的本地制品标记 `sourceDirty: true`，仅供验证；发行上传器和客户端清单拒绝该标记。正式构建必须来自干净的已审核 commit。

SemVer 主版本/次版本沿用现有 mobile 限额，iOS patch 额外限制为 0–99。Apple short version 使用 `major.minor.patch`；build 为 `(major*100+minor+1).patch.slot`，alpha 的 slot 为 N、beta 为 30+N、rc 为 60+N、stable 为 99，N 为 1–29。首段加一保证非零；同一版本重试不产生新 build。0.1.15 对应 short version 0.1.15、build 2.15.99。修改仅作用于新构建生成的 plist，既有原生配置/依赖不为此重写。

工具链采用标准 `macos-26` arm64 runner，依据 [runner 标签表](https://github.com/actions/runner-images#available-images) 和 [macos-26 arm64 软件清单](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)（2026-11-02 查阅，image `20261026.0455.2`）。清单提供 Xcode 26.6 / 17F113、iPhoneOS SDK 26.5 和 CocoaPods 1.17.0；Xcode 版本不等于 SDK 版本。`macos-15` 最多提供 Xcode 26.3，低于 [Expo SDK 57 要求的 Xcode 26.4](https://github.com/expo/expo/blob/eaa6f8dff378635d336807a405dc67e6bf3b0086/packages/@expo/sdk-compatibility/src/sdk-compatibility.json)。

此前的云端失败发生在 ExpoModulesJSI 57.0.6 的 `RuntimeScheduler.h`，不是 React Native 同名类：Swift 6.2 的 ClangImporter 拒绝构造函数上的 `SWIFT_RETURNS_RETAINED`。这些注解由 [Expo #49120](https://github.com/expo/expo/pull/49120) 加入，[上游说明](https://github.com/expo/expo/issues/49426#issuecomment-5437084400) 要求升级 Xcode。这里更换构建工具链，不修改依赖、头文件或原生配置。选择稳定的 26.6；Xcode 27 构建还涉及 [UIKit scene lifecycle 要求](https://github.com/expo/expo/blob/f0d6b6d8567378883fc49b3e270aec706d86b99a/docs/pages/build-reference/infrastructure.mdx)，不能用本机 27.2 归档成功替代发行工具链验证。

构建器在 prebuild 前执行 `scripts/check-lex-ios-toolchain.mjs`：检查真实 Xcode/build/SDK、Swift ≥6.3 与 CocoaPods，再用已安装的原始 Expo 头文件和 Swift C++ importer typecheck `arm64-apple-ios16.4` 消费端。预检不只是比较版本字符串；普通 `clang++` 检查不足以捕获此错误。单独定位可运行 `DEVELOPER_DIR=… node scripts/check-lex-ios-toolchain.mjs`，不生成工程或 IPA。CI 的 `LEX_IOS_REQUIRE_PINNED_TOOLCHAIN=1` 同时要求精确 pin，不静默回退。实际 Swift/Clang 版本、SDK 路径、头文件 SHA-256 与探针结果记录在 CI `build-info.json` 中；探针通过仍不等于完整归档通过。

pnpm 依赖使用 frozen lockfile。生成的 Podfile.lock 随 CI 构建证据保留；尚未建立跨 runner 的二进制逐字节可复现保证。同源重建的字节也可能不同，因此同版本上传重试必须复用原产物，不覆盖已存在字节。

本轮实现尚未完成签名后的 iPhone 首次安装、覆盖升级、数据保留、过期恢复及 Apple capability 真机验收。模拟器、源码单测、unsigned archive 各自只证明相应范围。验收时记录设备/iOS、签名工具/身份、原版本和结果，避免把“下载成功”写成“安装成功”。

## 参考

- [Apple Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account/)：Personal Team 与分发权限。
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)：受管理的测试分发与构建期限。
- [AltStore Classic source 格式](https://faq.altstore.io/developers/make-a-source)、[更新规则](https://faq.altstore.io/developers/updating-apps)：后续若增加源，须由真实产物生成并单独验收，不能复用 PAL 的安装口径。
