# Lex 0.1.13 引擎基线与 Fast 验证

2026-10-30。基于官方 stable 元数据固定版本；用户显式选择的自定义版本不自动覆盖。

| 引擎 | 原版本 | 新版本 | 官方来源 |
| --- | --- | --- | --- |
| Claude Code | 2.1.296 | 2.1.314 | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.314) 与 downloads.claude.ai 同版本清单 |
| Codex 完整包 / standalone | 0.162.1 | 0.166.0 | [rust-v0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0) |
| Pi | 1.2.0 | 1.4.0 | [v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0) |
| OMP | 18.10.4 | 18.14.0 | [v18.14.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.14.0) |

## 资产与安装

官方清单的 URL、size、SHA-256 更新到 tools 下五份 latest.json。发行 snapshot 仅投影既有四平台；旧 codex 0.145.0 CDN 元组原样保留。Desktop 仍使用完整 Codex package，SSH 仍读取 standalone pin；完整包的 code-mode host、资源、target、entrypoint 校验不变。

macOS arm64 通过现有更新器下载并校验全部五种资产，隔离环境中的版本探针均匹配新 pin。没有替换正在运行的 Cindy，也没有覆盖个人引擎配置。Windows、macOS x64、Linux 只核对元数据，打包与跨平台实机验证留给 CI / 对应平台。

## 上游接口核对

Codex 固定源码 [ModelInfo](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/protocol/src/openai_models.rs) 仅序列化模型目录允许的 service_tiers。模型目录配置是启动级，不能依赖 thread 配置热更新。因此仅 API / 已冻结目录宿主补充私有 Fast 请求描述，并将模型集合纳入宿主复用签名。官方订阅普通宿主继续原生发现。未知别名沿用原生 fallback；内置 fallback prompt 在新二进制中仍字节一致，未改写 system prompt。

OMP 固定源码的 [RPC](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)、[host-tools](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/rpc/host-tools.ts)、[模型配置](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/config/models-config-schema-bundle.ts) 保留 set_host_tools、host_tool_call/result、essential/discoverable、select/confirm、provider/model/cost 字段。switch_session 新增可选模型选择，旧 sessionPath 合约仍有效。原生审批新增选项不构成宿主授权，现有权限桥保持拒绝未知响应。终端快捷键显示改为符号，测试跟随实际提示，生产审批不放宽。

## 实际验证

全部原生测试在 macOS arm64、Node 22.22.3、临时 HOME/运行目录与 loopback 合成服务上执行，无真实账号或收费请求：

- Codex Fast：未知私有别名、启动 Fast、关闭、模型切换、恢复；检查实际 HTTP 请求为 priority / 省略，模拟服务返回 default，不把请求档位当作账单。
- Codex 网关认证：28 个首次启动、订阅过期/撤销/并发阻塞、恢复与 401 用例通过。测试补上隔离的 owner 初始化和 Electron getName；不修改生产认证。
- Claude Code：4 个普通/Lead 身份变化、恢复、失败恢复用例通过。Mac fixture 用 realpath，MCP 可用性从原生 tool-list 核验，兼容新版延迟发送工具 schema。
- Pi：原生普通/Lead 激活、撤销、重入与真实 Main MCP 路由用例通过。
- OMP：Ask / Full Access 身份变化，以及 Worker 排队输入和真实 Main MCP 派发共 3 个用例通过。
- Fast 定向单测：保存过的配置、缺失/false 声明、provider/model 身份、xAI fast/priority 别名、原生目录保真、默认关闭与非服务档位边界。

相关单测、类型检查和发布元数据门禁以本 PR 的实际命令结果为准；环境变量未启用时跳过的原生集成测试不能冒充上述验收。未验证真实供应商计费、网络提速、SSH 服务器实机或移动端 UI 实机。移动端仅共享 JS 请求能力变化，没有新增原生输入、fingerprint 或 OTA 配置。

## 行为与回退

[Fast 规则](../gpt-fast-mode.md)区分用户选择、执行能力、供应商实报和回执。未重建供应商、未迁移凭证、未改数据库或设备协议。自选旧 Codex 若原生目录不兼容，保留原生目录并记录告警，不能宣称它与固定新版完全等价。

提示词与工具顺序没有为 Fast 重排；请求只增加显式 service tier，关闭时省略。额外目录工作在启动阶段，模型签名为内存哈希，不给每轮增加网络请求。原生验证覆盖工具调用回执和上下文保留；未测真实缓存命中率或线上延迟，不作性能承诺。

本 PR 准备 0.1.13 稳定版两份 release notice。合并 main 且对应 push CI 成功后再创建新标签；本 PR 不发布安装包，不提供公开 iOS 安装包。
