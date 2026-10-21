<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/desktop/src/renderer/assets/login/lex-wordmark-dark.svg">
    <img src="./apps/desktop/src/renderer/assets/login/lex-wordmark.svg" width="210" alt="Lex">
  </picture>
</p>

<p align="center"><strong>把主对话、四种 Agent 引擎、文件、Git 与 Worker 放进同一个本地工作台。</strong></p>

<p align="center">
  通过对话梳理工作，用工具推进任务，在同一窗口查看结果。<br>
  让 Claude Code、Codex、Pi 与 OMP 连接同一个本地开发工作台。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://ciciy-l.github.io/lex/">官网</a> ·
  <a href="https://github.com/Ciciy-l/lex/releases">下载</a> ·
  <a href="https://github.com/Ciciy-l/lex/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://github.com/Ciciy-l/lex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Ciciy-l/lex/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Ciciy-l/lex/actions/workflows/pages.yml"><img alt="官网部署" src="https://github.com/Ciciy-l/lex/actions/workflows/pages.yml/badge.svg"></a>
  <a href="https://github.com/Ciciy-l/lex/releases"><img alt="预发布版本" src="https://img.shields.io/github/v/release/Ciciy-l/lex?include_prereleases&label=preview"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-6f55e8.svg"></a>
</p>

## Lex 是什么？

Lex 是用于 AI 协作的开源桌面与移动端工作台。你可以通过对话梳理任务、运行 Agent、
查看文件与 Git 变更，并在同一个窗口跟进 Worker 的工作。

桌面任务可使用 Claude Code、Codex、Pi 或 OMP，在图形对话界面（GUI）和引擎原生终端（TUI）
之间切换，沿用同一任务与对话记录。文件与终端也支持已配置的 SSH 主机。

Lex 基于开源 [Cindy](https://github.com/makecindy/cindy) 客户端，由社区独立维护，
与 XD Inc. 或 Cindy 项目不存在隶属、授权或官方背书关系。桌面产品、
官网、安装包和更新通道使用 **Lex** 名称；由 Cindy 提供的账号与在线服务则有意继续使用
**Cindy** 名称。

## 当前工作台能力

| 区域 | 可以做什么 |
| --- | --- |
| **内容页签** | 在对话旁打开终端、文件、浏览器、Worker 对话与 Git 工作区（Git 图谱 / 审查）。 |
| **GUI / TUI** | 本地新任务可直接从 TUI 首发，携带对话记录切换视图；停止生成后可明确发送新消息。高级功能因引擎和视图而异。 |
| **草稿保存** | 原任务与新任务分别保留草稿；已保存的文本、附件和图片批注可在桌面端重启后恢复，发送或丢弃后清理。 |
| **CLI 启动** | 通过 `+` 菜单在独立页签中启动 Claude Code、Codex、Pi、OMP 或本机已有 Shell；Shell 来自实际环境检测，不会写死。 |
| **终端布局** | 拆分和缩放窗格、拖动调整位置、重命名页签、搜索输出，并可临时最大化需要专注的窗格。 |
| **长任务运行** | 隐藏窗格、切换页签或收起工作区不会终止 PTY；停止进程始终需要明确操作。 |
| **文件** | 浏览项目文件树；单击预览、双击固定，预览文件一旦编辑也会自动固定。 |
| **项目上下文** | 导航后台任务与协同 Worker，并在内容区打开具体详情。 |
| **Git 工作区** | 本地项目可从工具区打开同一个 Git 工作区，默认进入 Git 图谱；可在同一页签切换到审查，查看本地提交关系、暂存/未暂存变更、提交差异及选定提交之间的比较。Git 图谱及其比较为只读；审查保留既有的受保护变更操作。 |

Lex 继续兼容 Cindy 插件、Skill Hub 资源和 `.cindy` 文件，让既有 Cindy 社区资源仍然可以
直接使用。

## 0.1.7 更新

模型选择区以模型名称为主，渠道与协议合并为一处紧凑入口。桌面端未登录时默认进入主界面，
需要在线服务时可主动点击登录，选择 Cindy 后进入原有账号登录流程。

本次正式版改善 Claude Code、Codex、Pi 与 OMP 的主要 GUI/TUI 收发与任务恢复，
增加桌面端重启后的已保存草稿恢复，修正 Pi 正常空闲退出的提示与 OMP 累计用量显示。
详情见[发布说明](release-notices/0.1.7.md)。0.1.7 为正式版本；
官网默认下载跟随最新已发布的稳定版。

OMP 原生任务暂时关闭自动 recap，规避已观察到的空闲断连；显式 TUI 设置仍可能重新开启。
`/btw`、`/omfg` 与其它辅助并发未验，GUI/TUI 功能也并非完全一致。
本次交互验证使用 Windows 专有模拟模型，不代表真实供应商或 macOS/Linux 已完成实测。
草稿恢复针对已保存内容，尚未保存的最后编辑不保证在硬中断后恢复。

## 敬请期待

Lex 自建中转服务正在开发，敬请期待。

## 下载与安装

请从
[GitHub Releases](https://github.com/Ciciy-l/lex/releases) 下载对应平台的手动安装包：

| 平台 | 手动安装文件 |
| --- | --- |
| Windows x64 | `Lex-…-Windows-x64-Setup.exe` |
| macOS Apple Silicon | `Lex-…-macOS-Apple-Silicon.dmg` |
| macOS Intel | `Lex-…-macOS-Intel.dmg` |
| Linux x64 | `Lex-…-Linux-x64.deb` |
| Android | `Lex-…-Android.apk`（以已发布版本实际提供为准） |

以 `Auto-Update.zip` 结尾的文件供 Lex 应用内更新器使用，不是推荐的手动安装包。

安装包可能尚未签名，因此 Windows SmartScreen、macOS Gatekeeper 或 Linux 包管理器
可能显示警告。签名状态与版本稳定性彼此独立：已经签名的 RC 仍然是预发布版。若希望在应用
内接收 RC 更新，需要启用 **beta** 更新通道；稳定通道不会接收预发布版本。

### 桌面端第一次使用

1. 安装并打开 Lex；
2. 默认进入未登录主界面；需要 Cindy 在线服务时，点击登录、选择 **Cindy**，再完成账号登录；
3. 打开需要处理的项目目录；
4. 点击 `+` 启动 CLI、Shell 或浏览器；需要 Worker 时，从工作区工具栏打开协同。

## 一个应用，两种 Cindy 服务区

Lex 在每个平台只维护一个发行版和安装身份，不按服务区拆分下载。登录时选择的账号决定
Cindy 服务区：

- Global Cindy 账号选择 **Global**；
- 中国大陆 Cindy 账号选择 **中国大陆**；
- 企业 SSO 自动发现组织所属服务区。

该选择只决定 Cindy 的鉴权、订阅、托管模型、语音、云存储、Device Link 与远程控制流量，
不会改变 Lex 下载地址或更新通道。未登录时，依赖 Cindy 服务端的能力不可用。

## Lex 与 Cindy 的责任边界

| 范围 | 提供方 |
| --- | --- |
| 桌面工作台、安装包、官网、支持与更新 | Lex 社区项目 |
| 账号、订阅、托管模型、云存储、Device Link 与远程服务 | Cindy 官方服务 |
| 源码基础与上游修复 | Cindy 开源项目 |

Cindy 在线服务受其官方条款、区域可用性和支持政策约束。Lex 不运营这些服务，也不销售另一套
订阅。发版流程现覆盖 **Lex Desktop 与 Lex Mobile Android**。可扫描
[移动端下载页](https://ciciy-l.github.io/lex/#mobile-download)的二维码查看已发布 APK。
Android 需登录 Cindy 账号连接桌面设备，不在手机上本地运行桌面 Agent 引擎。
Lex Mobile 使用独立包名，通过新 APK 升级，暂不启用 OTA。iOS 尚未开放安装，
需要后续配置 TestFlight / App Store 分发。

Lex 将沿自己的路线发展，按需引入上游安全、稳定性和兼容修复，已停用每周自动同步。

## 隐私与遥测

- Lex 发行包默认**不启用**上游 TapDB 上报链路；
- 产品统计不包含聊天内容、文件内容或工作目录内容；
- 诊断日志默认留在本机，只有主动点击「立即上传日志」才会上传；
- 「崩溃时自动上传」是独立的可选开关，默认关闭。

登录并使用在线 Agent 时，仍会产生所选 Cindy 服务和模型提供商完成请求所必需的网络流量，
这些服务遵循各自的条款与隐私政策。

## 从源码运行

需要 Node.js 22.x、pnpm 10.x、Git 和 Git LFS。

```powershell
git clone https://github.com/Ciciy-l/lex.git
cd lex
git lfs pull
corepack enable
corepack pnpm install
corepack pnpm restart:desktop:remote --region=global
```

重启命令默认使用隔离的 `dev` 数据目录，不会混用正式版本数据。多个工作树并行开发时，使用
`--isolated=@worktree` 为每个工作树分配独立沙箱。

完整开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布与上游同步

- 预发布版只进入 beta 通道；稳定 Release 同时更新稳定和 beta 通道，让已安装 RC 的用户能自然升级；
- 工作流根据仓库中已配置的签名凭据选择签名方式，不会因此创建第二套安装身份或发行流程；
- `upstream-sync` 工作流仅在维护者明确发起时创建可审阅的同步 PR，
  按需引入安全、稳定性与兼容修复，已停用每周自动同步。

维护者说明见 [docs/RELEASING-LEX.md](docs/RELEASING-LEX.md)。

## 贡献与支持

- 工程规则：[AGENTS.md](AGENTS.md) 与 [docs/README.md](docs/README.md)
- 使用支持和普通 Bug：[SUPPORT.md](SUPPORT.md)
- 安全漏洞私密报告：[SECURITY.md](SECURITY.md)
- Pull Request 的每个提交都需要 DCO Sign-off（`git commit -s`）。

## 许可证与归属

除单独说明外，源码依据 [Apache License 2.0](LICENSE) 授权。Cindy 原始归属和 Lex 修改者声明
保存在 [NOTICE](NOTICE)，第三方声明与 SBOM 位于 [docs/legal](docs/legal)。

Apache-2.0 不自动授予 Cindy 商标、托管服务、模型权重、数据集或其他单独材料的权利。
