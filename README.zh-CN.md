# Lex

> 基于开源 [Cindy](https://github.com/makecindy/cindy) 的社区桌面 Agent 发行版，
> 加入受 Orca 启发的本地 CLI 工作台。

[English](README.md) · [下载](https://github.com/Ciciy-l/lex/releases) ·
[官网](https://ciciy-l.github.io/lex/) · [问题反馈](https://github.com/Ciciy-l/lex/issues)

[![CI](https://github.com/Ciciy-l/lex/actions/workflows/ci.yml/badge.svg)](https://github.com/Ciciy-l/lex/actions/workflows/ci.yml)
[![Release](https://github.com/Ciciy-l/lex/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/Ciciy-l/lex/actions/workflows/desktop-release.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Lex 以 Cindy 的应用与 Agent 能力为基础，在聊天窗口旁加入桌面原生 CLI 工作区：
可同时打开 Shell、Claude Code、Codex 和 Pi，会话支持窗格拆分、缩放与完整 PTY
生命周期，开发现场始终留在同一个项目窗口里。

Lex 由社区独立维护，与 XD Inc. 或 Cindy 项目不存在隶属、授权或官方背书关系。

桌面产品与发行版使用 **Lex** 名称；继承的 Agent 人格，以及由 Cindy 提供的账号和
在线服务界面，会有意继续使用 **Cindy** 名称，以保持上游行为兼容。这不表示 Lex
是 Cindy 官方构建。

## 一个安装包，两种 Cindy 服务区

Lex 只发布一个安装包，使用同一个应用身份、用户数据目录、版本号和更新通道。
登录时按 Cindy 账号选择服务区：

- Global Cindy 账号选择 **Global**；
- 中国大陆 Cindy 账号选择 **中国大陆**；
- 企业 SSO 自动发现组织所属服务区。

该选择只决定 Cindy 的鉴权、订阅、云模型、语音、对象存储、Device Link 和远程控制
流量，不会改变 Lex 安装包、下载地址或更新通道。已保存账号会记住自己的服务区。

## Cindy 与 Lex 的责任边界

| 范围 | 提供方 |
| --- | --- |
| 桌面客户端、CLI 工作台、打包、官网、支持和自动更新 | Lex 社区项目 |
| 账号、订阅、托管模型、云存储、Device Link 与远程在线服务 | Cindy 官方服务 |
| 源码基础与上游修复 | Cindy 开源项目 |

Cindy 在线服务受 Cindy 官方条款、区域可用性和服务状态约束。Lex 不运营这些服务，
也不销售另一套订阅。你也可以选择「跳过登录」，只使用本地 Agent；此时依赖服务端
的能力不可用。

## 当前状态

Lex 目前处于早期预览阶段。在项目配置平台签名之前，带正常 SemVer 的 GitHub Release
仍会发布无签名测试包；Windows SmartScreen、macOS Gatekeeper 或 Linux 包管理器可能
显示提示。后续配置签名 Secrets 后，同一套版本和更新链会自动生成正式签名包，现有
安装可以平滑升级。

当前只发行 **Lex Desktop**。仓库中的 Mobile 代码仍为上游 Cindy 客户端；Lex Desktop
可以继续配合 Cindy 官方移动端使用。

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

`--region=global` 现在表示唯一的 Lex 构建身份；Cindy 账号服务区在登录页选择。
需要隔离开发数据时使用：

```powershell
corepack pnpm restart:desktop:remote --region=global --isolated=dev
```

完整开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布与更新

- 推送 `v0.2.0-rc.1` 这类语义化版本 Tag，会启动多平台 Release 工作流；
- GitHub Release 发布后，自动在 `updates` 分支生成应用更新清单；
- prerelease 更新 beta 通道，稳定 Release 更新正式通道；
- 工作流根据签名 Secrets 是否齐全自动选择签名正式包或无签名预览包，版本号保持真实。

细节见 [docs/RELEASING-LEX.md](docs/RELEASING-LEX.md)。

## 同步 Cindy 上游

`upstream-sync` 工作流会定期检查 Cindy 并创建可审阅的同步 PR。尽量把 Lex 的产品身份、
CLI 工作台和发行文件保持为独立改动；冲突处理优先吸收 Cindy 的安全修复和通用改进，
同时保留本文档明确的 Lex 产品边界。

## 隐私与遥测

Lex 保留 Cindy 的同意与统计开关，但 Lex 发行包默认**不启用**上游 TapDB 上报链路。
产品统计不会上传聊天内容、文件内容或工作目录。登录后仍会按 Cindy 官方条款和隐私政策
使用账号在线服务及在线心跳。

诊断日志默认只保存在本机；只有你主动点击「立即上传日志」才会手动上传。「崩溃时自动
上传」是另一项独立开关，默认关闭。两条路径都还要求用户已同意隐私政策，并且构建时已
配置 Lex 自有的日志接收地址。

## 贡献与支持

- 工程规则：[AGENTS.md](AGENTS.md) 与 [docs/README.md](docs/README.md)
- 使用支持和普通 Bug：[SUPPORT.md](SUPPORT.md)
- 安全漏洞私密报告：[SECURITY.md](SECURITY.md)
- Pull Request 的每个提交必须带 DCO Sign-off（`git commit -s`）。

## 许可证与归属

除单独说明外，源码依据 [Apache License 2.0](LICENSE) 授权。Cindy 原始归属和 Lex
修改者声明保存在 [NOTICE](NOTICE)，第三方声明与 SBOM 位于 [docs/legal](docs/legal)。

Apache-2.0 不自动授予 Cindy 商标、托管服务、模型权重、数据集或其他单独材料的权利。
