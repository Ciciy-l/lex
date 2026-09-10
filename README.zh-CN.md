<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/desktop/src/renderer/assets/login/lex-wordmark-dark.svg">
    <img src="./apps/desktop/src/renderer/assets/login/lex-wordmark.svg" width="210" alt="Lex">
  </picture>
</p>

<p align="center"><strong>把主对话、CLI Agent、文件、Git 与 Worker 放进同一个本地工作台。</strong></p>

<p align="center">
  基于 <a href="https://github.com/makecindy/cindy">Cindy</a> 的社区桌面发行版。<br>
  保留理解工作的主对话，也给每一个 Agent 一个真正的工作台。
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

Lex 保留 Cindy 的主对话、Agent Loop、插件、远程控制和在线服务接入能力，并在此基础上
加入面向开发者的桌面原生工作台。你可以一边通过对话推进工作，一边在同一个窗口里查看
和控制真正执行任务的工具。

Lex 由社区独立维护，与 XD Inc. 或 Cindy 项目不存在隶属、授权或官方背书关系。桌面产品、
官网、安装包和更新通道使用 **Lex** 名称；由 Cindy 提供的账号与在线服务则有意继续使用
**Cindy** 名称。

## 当前工作台能力

| 区域 | 可以做什么 |
| --- | --- |
| **内容页签** | 终端、文件、浏览器、Worker 对话与 Git 工作区（Git 图谱 / 审查）均在 Cindy 原有内容区打开，不再创建一套相互竞争的第二内容区。 |
| **CLI 启动** | 通过 `+` 菜单在独立页签中启动 Claude Code、Codex、Pi 或本机已有 Shell；Shell 来自实际环境检测，不会写死。 |
| **终端布局** | 拆分和缩放窗格、拖动调整位置、重命名页签、搜索输出，并可临时最大化需要专注的窗格。 |
| **长任务运行** | 隐藏窗格、切换页签或收起工作区不会终止 PTY；停止进程始终需要明确操作。 |
| **文件** | 浏览项目文件树；单击预览、双击固定，预览文件一旦编辑也会自动固定。 |
| **项目上下文** | 导航后台任务与协同 Worker，并在内容区打开具体详情。 |
| **Git 工作区** | 本地项目可从工具区打开同一个 Git 工作区，默认进入 Git 图谱；可在同一页签切换到审查，查看本地提交关系、暂存/未暂存变更、提交差异及选定提交之间的比较。Git 图谱及其比较为只读；审查保留既有的受保护变更操作。 |

Lex 继续兼容 Cindy 插件、Skill Hub 资源和 `.cindy` 文件，让既有 Cindy 社区资源仍然可以
直接使用。

## 下载与安装

Lex 当前处于**早期预览**阶段。请从
[GitHub Releases](https://github.com/Ciciy-l/lex/releases) 下载对应平台的手动安装包：

| 平台 | 手动安装文件 |
| --- | --- |
| Windows x64 | `Lex-…-Windows-x64-Setup.exe` |
| macOS Apple Silicon | `Lex-…-macOS-Apple-Silicon.dmg` |
| macOS Intel | `Lex-…-macOS-Intel.dmg` |
| Linux x64 | `Lex-…-Linux-x64.deb` |

以 `Auto-Update.zip` 结尾的文件供 Lex 应用内更新器使用，不是推荐的手动安装包。

早期 RC 安装包可能尚未签名，因此 Windows SmartScreen、macOS Gatekeeper 或 Linux 包管理器
可能显示警告。签名状态与版本稳定性彼此独立：已经签名的 RC 仍然是预发布版。若希望在应用
内接收 RC 更新，需要启用 **beta** 更新通道；稳定通道不会接收预发布版本。

### 第一次使用

1. 安装并打开 Lex；
2. 登录 Cindy 账号，或选择「跳过登录」仅使用本地能力；
3. 打开需要处理的项目目录；
4. 点击 `+` 启动 CLI、Shell 或浏览器；需要 Worker 时，从工作区工具栏打开协同。

## 一个应用，两种 Cindy 服务区

Lex 只维护一个安装包、应用身份、用户数据目录、版本号和更新通道。登录时选择的账号决定
Cindy 服务区：

- Global Cindy 账号选择 **Global**；
- 中国大陆 Cindy 账号选择 **中国大陆**；
- 企业 SSO 自动发现组织所属服务区。

该选择只决定 Cindy 的鉴权、订阅、托管模型、语音、云存储、Device Link 与远程控制流量，
不会改变 Lex 下载地址或更新通道。跳过登录后，依赖 Cindy 服务端的能力将不可用。

## Lex 与 Cindy 的责任边界

| 范围 | 提供方 |
| --- | --- |
| 桌面工作台、安装包、官网、支持与更新 | Lex 社区项目 |
| 账号、订阅、托管模型、云存储、Device Link 与远程服务 | Cindy 官方服务 |
| 源码基础与上游修复 | Cindy 开源项目 |

Cindy 在线服务受其官方条款、区域可用性和支持政策约束。Lex 不运营这些服务，也不销售另一套
订阅。当前发行范围是 **Lex Desktop**；它可以继续配合 Cindy 官方移动端使用。

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
- `upstream-sync` 工作流定期检查 Cindy 并创建可审阅的同步 PR。在吸收 Cindy 安全修复与通用
  改进的同时，继续明确保留 Lex 产品标识和工作台行为。

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
