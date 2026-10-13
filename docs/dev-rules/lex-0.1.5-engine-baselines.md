# Lex 0.1.5 四引擎基线与官方资产兼容

2026-10-14。本文记录固定版本的公开元数据与源码审阅，不代表新版引擎实机验收。
用户要求 CI-only：本轮未在本机执行 tests、typecheck、build，未启动客户端或安装、运行引擎。

## 固定版本与真相源

| 引擎 | 原基线 | 0.1.5 基线 | 官方依据 |
| --- | --- | --- | --- |
| Claude Code | 2.1.259 | 2.1.296 | npm latest 元数据及 downloads.claude.ai 同版本 manifest |
| Codex | 0.159.2 | 0.162.1 | [rust-v0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1) 的完整 package 与 standalone 资产 |
| Pi | 0.84.4 | 1.2.0 | [v1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) |
| OMP | 18.1.18 | 18.10.4 | [v18.10.4](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.4) |

`tools/<kind>/latest.json` 保存官方 URL、size、SHA-256；Claude 来自官方发布清单，
GitHub 资产来自固定 tag 的 digest。Codex Desktop 使用 `tools/codex-package/latest.json`，
保留 layoutVersion、target、entrypoint、code-mode host、codex-path/rg 和 resources。
SSH standalone pin 使用 `tools/codex/latest.json`，不以单文件替代 Desktop package。
Claude/standalone Codex 保留既有 5 平台，Codex package/Pi/OMP 保留 6 平台。
`config/lex-agent-runtime-assets.json` 只投影原有 4 个 Lex 发行平台；本次没有新增发行平台。

snapshot 的旧 `codex` 0.145.0 相对 CDN 字段继续保留原 URL、size 和摘要，供旧客户端兼容。
这些是真实旧 bytes，**不是** 0.1.5 Desktop 或 SSH 的实际基线，也不是新版 standalone 分发。
不能只改这个字段的 version 来冒充新资产。实际 Desktop 默认基线与新的 Linux 受管
回退安装读取 `codexPackage`；
SSH 安装器读取 tools 的官方 pin。其他既有 snapshot 字段不因四引擎升级而伪造版本。

## 首次安装、恢复和开发准备

`agent-binaries/artifact-format.ts` 为启动 provisioner 与 Harness 恢复共用格式判断：

| 发布资产 | 处理方式 |
| --- | --- |
| 官方 Claude 裸文件、OMP 裸文件 | binary 复制，不再对裸 Claude 执行 gunzip |
| 旧 CDN Claude `.gz` | 保留 gzip 解压 |
| Pi Windows `.zip` | ZIP 整目录解包 |
| Pi Unix、Codex package、旧 Pi `.tar.gz` | tar.gz 整目录解包及既有 Pi wrapper 平铺 |

声明为目录归档却不是 ZIP/tar.gz 的文件会拒绝；平台识别同时覆盖旧 CDN 路径、
官方文件名和 Codex target，不能借用另一平台的资产。所有格式继续使用下载器的
SHA-256/expectedSize 校验、版本仲裁、显式用户选择及平台门槛。

启动下载不写入活跃版本目录。每次使用全新 `.stage-*`，完整解包、入口检查和取消检查
通过后写入 marker，再以目录 rename 替换；替换失败恢复原目录。失败 ZIP 不把残留条目
带进下次重试，半成品和 `.previous-*` 不参与本地版本发现。旧版本仅在新目录发布后回收。
路径/链接/条目数量预检复用 `toolArchive.ts`；不另造 ZIP 解包器。

运行时复用 Harness 管理器原有预算：归档 1 GiB、单文件 1 GiB、展开 3 GiB。
该预算集中为 `RUNTIME_ARCHIVE_LIMITS`，普通工具仍维持 160 MiB/256 MiB/1 GiB。
官方 Codex 0.162.1 Windows x64 主文件为 333,479,728 bytes，arm64 为 282,434,864 bytes，
不能用普通工具的单文件预算处理引擎。摘要、实际大小、路径和布局校验没有放宽。
GUI 恢复继续由 Harness 管理器验证精确 `--version` 和包布局，原子保存显式选择。

`scripts/ensure-agent-binaries.mjs` 继续复用 tools 更新器：Claude 官方裸文件，
Pi ZIP/tar 整目录、主题补齐和目录清单，Codex 完整 package 校验，OMP 严格固定摘要。
没有运行这些脚本或引擎。Linux fallback 的 Claude 保持裸文件；新的 Codex 受管下载
改为 tools/codex-package 的完整包，以相同受限解包器在全新 stage 安装，校验 manifest
版本、target、variant、layout、入口、code-mode host、rg 和 resources，并在真实版本
探针通过后发布。包版本使用独立 `.package-version` marker，不能把同目录原有单文件
CLI 认成新包；原有 CLI、旧私有布局、既有标记及用户选择保留。失败/取消不发布半包。
没有扩大 Linux 平台面，不从 legacy snapshot 冒充新版本。

## OMP v18.10.3 固定源码审阅

以下链接均绑定 v18.10.3，不把旧 v18.1.18 的实测记录改写为新版实测：

- [main.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/main.ts)
  的 version 分支打印 `VERSION`；[utils/dirs.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/utils/src/dirs.ts)
  从同版本 package.json 读取裸 `18.10.3`。本地 parser 接受完整单行裸版本和旧
  `omp/<semver>`，仍拒绝噪声、缺换行及与 pin 不符的版本。SSH 探测/安装同时接受
  两种真实 banner，但仍须精确版本、size、SHA；对外 `READY omp/<version>` 不变。
- [RPC 类型](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/modes/rpc/rpc-types.ts)
  和 [RPC 实现](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
  保留 set_host_tools、host_tool_call/result、select/confirm UI 请求与响应。
  [host-tools.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/modes/rpc/host-tools.ts)
  使用新增的 loadMode，[essential-tools.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/tools/essential-tools.ts)
  把未指定的非内置工具默认放入 discoverable。Lex 固定宿主入口显式 essential，
  保持现有调用面可见；RPC 编码器保留并校验 essential/discoverable，不能在发送时丢掉
  loadMode。工具执行、账号/项目作用域、发现后的单个 schema 复核和权限桥不变。
- [available-commands.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/slash-commands/available-commands.ts)
  仍返回 builtin/skill/extension/custom/mcp_prompt/file，get_available_commands
  仍包装 commands 数组；原目录校验与原生命令分发继续使用。
- [models-config-schema-bundle.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/config/models-config-schema-bundle.ts)
  保留现用 provider API、baseUrl、apiKey、headers、model/thinking 字段。存在 cost 时
  四个 numeric 字段均必需；生成器补齐未提供的零值，保持已知价格且不改 Lex 计费。
  显式 null、负值和非数值仍拒绝，不能把非法值当成缺省。
  [custom-models.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/config/custom-models.ts)
  的缺省 cost 同为四项零。未指定 cost 时仍省略。
  [resolve-config-value.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/config/resolve-config-value.ts)
  保留 env 名凭证解析；不写入密钥或新增模型目录同步。Lex 继续按 provider-level wire route 生成配置。
- [session/context-settings.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/session/context-settings.ts)、
  [task/settings.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/task/settings.ts)、
  [mnemopi/settings.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/mnemopi/settings.ts)、
  [memory-backend/settings.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/memory-backend/settings.ts)
  保留 compaction.enabled/thresholdPercent/keepRecentTokens、task 并发/递归、
  modelRoles.task/smol/tiny、memory.backend 和 Mnemopi 的 dbPath/scoping/noEmbeddings/llmMode。
  thresholdPercent 默认仍为 -1；null 不投影为固定百分比。
  [tools/settings.ts](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/tools/settings.ts)
  保留 always-ask/write/yolo 及默认 yolo，Lex 仍显式传档位、未知档位 fail closed。

关键源码 blob：dirs `6c5317f18730187f395bec3b06ac32a0cb58083b`、utils package
`2e412de93855b0a00f51633d750173be824b69c0`、RPC types
`e19d6d1f7cb3ce27a5e2e3bca0b3bc6d05171bf5`、RPC mode
`2a291babc8c884cfaec727a1f3cf7de3c838cfb3`、模型 schema
`91f4288b47a3a1f20401d13c00f826b69f7ed2bb`。

## OMP v18.10.4 发行前跟进审阅

PR77 合入后、发行前的官方 latest 查询发现 OMP 已发布 v18.10.4，故最终基线从
18.10.3 推进到 18.10.4。上节保留 v18.10.3 的历史审阅，不改写 v18.1.18 实测记录。
这次只审阅公开源码和元数据，没有安装或运行新版 OMP，也没有本地测试结果。

固定依据为 [release 412040933](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.4)
（非 draft、非 prerelease，2026-10-13T19:38:04Z 发布），tag commit 为
`687892d1046ecaf18829b45f5b86928a308258f4`。相对 v18.10.3 的
[固定提交 compare](https://github.com/can1357/oh-my-pi/compare/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b...687892d1046ecaf18829b45f5b86928a308258f4)
包含 105 commits、191 changed files；以下链接固定到新提交，而不是可移动的 main。

- **宿主与 RPC**：[rpc-types.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/modes/rpc/rpc-types.ts)、
  [rpc-mode.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/modes/rpc/rpc-mode.ts)、
  [host-tools.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/modes/rpc/host-tools.ts)
  与 v18.10.3 的 blob 相同，仍有 set_host_tools、host_tool_call/result、
  essential/discoverable loadMode、select/confirm 和 get_available_commands。
  Lex 继续显式 essential、既有字段校验和权限回执，不扩大工具或 IPC 入口。
- **OMP Code Mode 移除**：[session/settings.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/settings.ts)
  删除 providers.openai-codex.codeMode/codeModeDirectTools；
  [session-tools.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/session-tools.ts)
  不再分割 Code Mode 工具，catalog 的 toolMode 与 AI 的 toolNamespacesInfo 也被移除。
  Lex 的 OMP launch-plan、models-config、omp-host 未读写这些字段，也不消费上游内部 SDK
  回调；生成器只投影声明的三种 provider API 和模型字段。本次不改 Lex 工具清单。
  Lex 独立 Codex 引擎的完整 package/code-mode-host 不属于这次 OMP 移除，继续保留。
- **审批与 timeout**：[approval.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/tools/approval.ts)
  新增可选 ui.approve，全/紧凑两种提示；RPC 的 RpcExtensionUIContext 没有实现 approve，
  requestApproval 继续用完整 Allow tool 提示和 select([Approve, Deny])，只认明确 Approve。
  新终端审批快捷键、timeout start/reset 回调在交互 UI；Lex 保留自身有界超时、拒绝/取消、
  requestGeneration 与任务代次围栏，不通过新增 UI method 放行。
- **计划审批扩展**：[extensions/types.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/extensibility/extensions/types.ts)
  新增 plan_review_requested、可选 tier 与 resolve/openPlanReview。
  [agent-session.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/agent-session.ts)
  的默认命令上下文返回 false/undefined；交互模式才提供计划审批 UI。Lex 的 RPC 适配器
  未调用这些扩展 API，不新增功能，也不把它们当成宿主批准事实。
- **配置与价格**：[models-config-schema-bundle.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/config/models-config-schema-bundle.ts)
  blob 仍为 `91f4288b47a3a1f20401d13c00f826b69f7ed2bb`，现用 provider/model 和四项 numeric cost
  契约不变。context/task/mnemopi/memory-backend/tools 的 settings blob 同样未变，
  原生动态 thresholdPercent=-1 保留。新增 scheduled price/catalog 修复由 OMP 自己处理；
  Lex 没有消费 toolMode、同步上游模型目录或改写自有价格/用户默认投影。
- **启动与 SSH**：main.ts、utils/dirs.ts blob 未变，utils/package.json 的 VERSION 改为
  18.10.4，依旧打印裸单行版本。本地保留裸版本/omp 前缀两种解析且默认 pin 精确匹配；
  SSH pin 从 tools 元数据读取，既有 READY omp/<version> 归一和摘要门不变。
- **恢复与压缩**：[session-context.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/session-context.ts)
  修正 leaf/usage marker 重放；
  [compaction.ts](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/agent/src/compaction/compaction.ts)
  与 snapcompact 按读取模型选择 reasoning-free archive，内部 buildProviderContext 增加 model 参数。
  Lex 未实现这些内部回调或解析 archive/preserveData，仍用 switch_session + 绝对 sessionFile
  身份复核、原生 compact 命令及 auto_compaction 事件投影。真实跨模型恢复/压缩仍需运行验收。

六平台裸资产按本固定 release 的唯一 name、URL、size、digest 与先前官方回执交叉比对，
四个发行平台的 OMP snapshot 同源投影；未下载大型二进制，不能把 API digest 核对称为本机
二进制 hash/版本执行验收。非 OMP 条目（包括 frozen Codex 0.145.0 兼容 bytes）原样保持。
默认 pin 的启动/恢复/开发准备继续使用上节的 binary 格式、staging 和完整性校验；
显式用户版本选择不变。本次没有格式、安装器、原生指纹、证书或工作流改动。

当前版本回归同步到 18.10.4，额外保留拒绝 18.10.3、后续 18.10.5 和 prerelease 的
反向覆盖；旧 18.1.18/18.1.19、缺换行、诊断噪声、错误 size/hash/URL/name 仍拒绝。
启动 byte gate、六平台 asset 名与四平台 snapshot 合同须由新 head 的 CI 独立执行，
没有逐例运行结果时不能声称通过。

固定 JSON、完整 compare、tree 与引用 blob（含原 bytes、SHA-1/SHA-256）位于 repo 外
`F:/Projects/lex/ci-logs/release-0.1.5/omp-18.10.4`，asset-mapping.json 标记核对范围。

## Pi v1.2.0 固定源码审阅

- [build-binaries.sh](https://github.com/earendil-works/pi/blob/v1.2.0/scripts/build-binaries.sh)
  明确 Windows ZIP 平铺、Unix tar.gz 包在 pi/ 内，完整携带 theme/assets/wasm/native。
  继续目录安装，不把 Pi 变成仅一个 exe。
- [theme-schema.ts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/modes/interactive/theme/theme-schema.ts)
  严格限制顶层字段和 colors，vars 只能为颜色值。旧 fallback 的字段和值满足这个结构，
  `$schema` 更新为 pi.dev；新增 scrollbar/search 颜色在
  [theme-tokens.ts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/modes/interactive/theme/theme-tokens.ts)
  有原生 fallback，因此不加必需 token 或旧版不认识的元数据。内置主题优先，
  原有 fallback schema 文件留给旧发行包兼容，不覆盖上游已携带的主题。
- [扩展类型](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts)
  将 before_agent_start 分为 user/custom union。Lex 自带 bridge、Subagent 扩展与
  host 没有消费该事件的 prompt 假设或调用 ctx.isIdle，不凭空新增 handler。
- [agent-session.ts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts)
  在 startup handlers 前进入 busy；[rpc-mode.ts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
  保留 prompt preflight 回执、get_state readiness 与 steer/follow_up。Lex send
  始终声明 followUp：原生 idle 时照常开始，busy 时排队，不等待事件镜像赶上。
  steer、Stop、待确认投递和权限策略的代际围栏不变。

关键源码 blob：build `1f9eb96e0beea114f8939fd454979b84782109df`、agent-session
`ca21a547329de1a01214abafaf0a3519bc0443ea`、theme schema
`4e0bf5702c808a628c84c4876397a14f4eba4700`、theme tokens
`a291cf134825f0a95296e6958c3b0dc7fdecb65d`。

## 后续 CI 和交付边界

新增/调整回归覆盖资产格式、官方 pin/snapshot 一致性、首次启动、ZIP 失败后重试、
完整 Codex 旁侧资产、旧格式兼容、Linux 完整包下载/布局/版本/取消与旧 CLI 保留、
OMP banner/固定宿主入口及实际 RPC 字段/模型 schema、
SSH 原始脚本的 banner 与 READY 归一、Pi 主题与早期 busy 排队。
所有新增用例尚未本地执行；后续 PR 必须如实记录 CI 的独立执行结果。
发行还需精确 merge/main CI、永久 Android 签名包、草稿资产及发布后渠道取证。
目前没有 Light/Dark、键盘、窄窗、真实引擎请求、首次安装或覆盖升级实机证据。

repo 外官方 JSON/get_contents 回执和源码副本保存于
`F:/Projects/lex/ci-logs/release-0.1.5`，只读审阅，未运行下载的源码。
版本由既有 release 工作流注入，不修改本轮 package/mobile 原生 fingerprint 输入。
用户版更新说明只描述更新行为和升级须知；验证情况留在工程证据与 PR。
