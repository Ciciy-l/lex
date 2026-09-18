# Lex 桌面端 OMP Agent 接入 PRD

| 项 | 值 |
| --- | --- |
| 文档语言 | 中文 |
| 状态 | 待客户拍板（见 §11 开放问题） |
| 目标工作树 | `F:\Projects\lex\app`（分支 `sync/cindy-20260911-v0.1.79`） |
| 上游基线 | `can1357/oh-my-pi` tag **v18.1.18** |
| 品牌边界 | 桌面产品 / 官网 / 安装器 / 更新通道 = **Lex**；账号 / 订阅 / 托管模型 / 云存储 / Device Link = **Cindy**。二者不得混用（`pnpm check:brand-terminology` 为硬门禁） |

---

## 1. 目标与非目标

### 1.1 目标（唯一北极星）

让 **OMP 成为 Lex GUI 里的第四个 agent**，与 Claude Code / Codex / Pi 完全同构：用户在引擎选择器里能选中 OMP、发消息、看到流式输出、看到工具执行、管理会话（新建 / 续接 / 历史）。

### 1.2 非目标

- **不是**协议探测器。现有 `omp-probe-*` 四层封装（sandbox → preflight → runtime → isolated-probe-host）全部是为"在沙箱里问一句你支持哪些命令然后关掉"服务的，生产入口零调用。**探测不是产品形态。**
- **不是**隔离沙箱实验。沙箱机制本身有价值（见 §3.2 保留部分），但它不是交付物。
- 本 PRD 不涉及：SSH 远程 OMP、Device Link、IM 渠道、Orca 子代理、Orca 协同、Mobile。全部 P2。

### 1.3 成功判据（用户视角）

一个已登录 Cindy 账号、从未听说过 OMP 的用户，能在 3 分钟内：在新建对话工具条把引擎切成 OMP → 发一句"帮我看看这个仓库的结构" → 看到流式回答与工具调用 → 关掉应用再打开，继续这个对话。

---

## 2. 现状盘点

### 2.1 现有 OMP 代码（客户判定"跑偏"的部分）

| 位置 | 判定 |
| --- | --- |
| `packages/maker-core/src/agents/omp/rpc-client.ts` | **保留并扩展**（见 §2.3） |
| `packages/maker-core/src/agents/omp/jsonl-reader.ts` | **保留**（有界字节读、1 MiB 帧上限、严格 UTF-8） |
| `packages/maker-core/src/agents/omp/stream-transport.ts` | **保留**（专属流绑定、drain 语义） |
| `packages/maker-core/src/agents/omp/process-lifecycle.ts` | **保留**（starting/ready/draining/stopping/exit-unconfirmed/exited 六态 + 三级超时） |
| `packages/maker-core/src/agents/omp/process-host.ts` | **保留**（Node spawn、显式环境快照、进程树终止回调） |
| `packages/maker-core/src/agents/omp/commands.ts` | **保留**（P1 斜杠命令面板用） |
| `packages/maker-core/src/agents/omp/launch-plan.ts` | **重写**：从"沙箱探测计划"改成"生产会话启动计划"（见 §8.2） |
| `packages/maker-core/src/agents/omp/probe-controller.ts` | **删除**（探测专属） |
| `apps/desktop/src/main/maker-host/omp-probe-sandbox.ts` | **删除**（生产不需要每次新建沙箱） |
| `apps/desktop/src/main/maker-host/omp-probe-preflight.ts` | **删除**（探测专属配对逻辑） |
| `apps/desktop/src/main/maker-host/omp-probe-runtime.ts` | **重写为 `omp-runtime.ts`**：去掉 dev-only 限制，保留 pin 复核，接入受管运行时（见 §7） |
| `apps/desktop/src/main/maker-host/omp-isolated-probe-host.ts` | **删除**（被 OmpAgent 取代） |
| `tools/omp/latest.json` + `tools/omp/update.mjs` | **保留**：继续作为"上游核实基线 + dev pin"真源 |
| 各 `*.test.ts` | 协议层测试保留；探测层测试随实现删除 |

### 2.2 三个既有 agent 的统一抽象（架构师接入面）

| 契约 | 位置 | 说明 |
| --- | --- | --- |
| `AgentKind` | `packages/maker-core/src/types/common.ts:8` | `'claude-code' | 'codex' | 'pi'` → 加 `'omp'`。**这是最大改动面**：全仓约 20+ 个文件有该 union 的穷举（maker-shared、lizi-mcps、maker-remote-ssh、renderer）。 |
| `BaseAgent` | `packages/maker-core/src/agents/base-agent.ts:2351` | 抽象基类；唯一必须实现的是 `startSession()`。构造期校验 `deps.binaryPath` 非空。 |
| `AgentSessionHandle` | `base-agent.ts:2090` | 会话句柄。`send` / `abort` / `close` / `events` / `getUsageSnapshot` / `setInteractionResolver` 必实现，其余可选（`setModel` / `setPermissionMode` / `compactSession` / `exportSessionHtml` / `getSessionTree` …）。 |
| `StartSessionOptions` | `base-agent.ts:1710` | `workingDir` / `model` / `providerId` / `effort` / `permissionMode` / `resumeSessionId` / `sessionId` / `userPrompt` … |
| `Capabilities` | `packages/maker-core/src/types/capabilities.ts` | UI 据此降级渲染。`permissionModes` / `availableModels` / `effortLevels` / `planMode` / `multimodal` … |
| `InteractionRequest` / `InteractionDecision` | `packages/maker-core/src/types/events.ts:256 / 277` | 三种 kind：`permission` / `ask_user_question` / `plan_review`。agent 通过 `setInteractionResolver` 统一回调 host。 |
| 注册入口 | `apps/desktop/src/main/maker-host/index.ts:2690` `_registerPiAgent` → `_maker.registerAgent('pi', next)`；`:2770` `registerPiAgentIfAvailable()` 广播 `MAKER_PUSH.AGENTS_CHANGED` | OMP 照抄这条链路 |
| Agent 构造 | `apps/desktop/src/main/maker-host/pi-host.ts:1787` `buildPiAgent()` | 二进制缺失 → 返回 `null` → **不注册**（优雅降级先例） |
| Renderer 引擎表 | `apps/desktop/src/renderer/lib/agentVendors.ts` `SELECTABLE_VENDORS = ['cc','codex','pi']` | 加 `'omp'`；`components/new-chat/agentOptions.ts` 的 `VENDOR_PRESENTATION` 是 `Record<SelectableVendor, …>`，漏补 label/Mark 会**编译报错**（好门禁） |
| 引擎配色 | `apps/desktop/src/renderer/lib/modelHarnessPresentation.ts` `MODEL_HARNESS_COLOR` | `Record<AgentKind, string>`，加 `omp`，并补 `--engine-badge-omp` 主题变量（light/dark 双模式） |
| 权限选择器 | `apps/desktop/src/renderer/components/new-chat/PermissionSelector.tsx` | 选项完全来自 `capabilities.permissionModes`，**无需改组件**；只需补 i18n `newChat.permissionSelector.modes.omp.<id>.label/.description`（五语言） |
| 会话持久化 | `apps/desktop/src/main/localDb/schema.ts` `sessions.agentKind`（默认 `'cc'`）、`sessions.sdkSessionId`、`messages.agent_meta` | 加 `'omp'` 枚举值 |

### 2.3 现有 `rpc-client.ts` 的三个硬缺口（必须补，否则接不上）

1. **请求类型只有 4 个**：`REQUEST_TYPES = { get_available_commands, get_state, abort, prompt }`。生产需要 `steer` / `new_session` / `switch_session` / `set_model` / `get_available_models` / `compact` / `set_session_name` / `get_messages` 等（完整清单见 §4.3）。
2. **`respondToUi` 不回 `requestGeneration`**：上游 `docs/rpc.md` 明确要求"Response-bearing events carry a requestGeneration correlation token; clients must echo it in `extension_ui_response` so a late response cannot resolve a newer request that reused the same public ID"。**不补会在同 id 复用时把旧响应套到新请求上**（权限误放行风险）。
3. **v1 单帧 1 MiB 且不支持 `rpc_chunk`**：`jsonl-reader.ts` 目前把 `rpc_chunk` 当致命错误直接关连接。大工具输出 / 大历史有截断风险。P0 接受并在事件投影层做降级提示；v2 协商 + 重组列为 P1（见 §11-Q8）。

---

## 3. OMP 协议事实（已核实，v18.1.18）

来源：`docs/omp-integration.md` 的既有核实 + 上游 `docs/rpc.md` + `tools/approval.ts` 审批矩阵。

### 3.1 传输

- JSONL over stdio，`omp --mode rpc`；协议 v1（v2 需 `negotiate_protocol` 显式协商）。
- 单帧上限 **1 MiB**，并发请求上限 **64**（两侧一致）。
- 启动先写 `ready` 帧：`{ type:'ready', protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864 }`。
- **stdin 关闭即优雅退出**：挂起的 extension UI / host-tool / host-URI 请求被拒绝，已接受命令排空，进程以 0 退出。
- 错误帧：`{ type:'error', phase:'startup'|'run', code, message, exit_code }`，稳定 code 族含 `auth.missing_api_key` / `auth.invalid_api_key` / `auth.no_models_available`（**这是凭据 UX 的关键输入**）。
- 命令失败：`{ type:'response', success:false, error, code? }`；`prompt` 先 ACK 再可能同 id 二次报错（`omp_prompt_failure` 已在本仓处理）。

### 3.2 出站事件（→ Lex `AgentEvent`）

`agent_start` / `agent_end`（含 `isTerminal`）/`turn_start` / `turn_end` / `message_start` / `message_update`（内含 text / thinking / toolcall 增量）/ `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `auto_compaction_start` / `auto_compaction_end` / `auto_retry_start` / `auto_retry_end` / `model_changed` / `thinking_level_changed` / `todo_reminder` / `notice` / `extension_ui_request` / `ask_request` / `host_tool_call` / `host_tool_cancel` / `host_uri_request` / `host_uri_cancel` / `extension_error` / `available_commands_update` / `prompt_result` / `error`。

### 3.3 审批模型（**权限映射的关键**）

OMP 把工具分为三个 tier：**read / write / exec**。`tools.approvalMode` 有三个值（上游默认值是 **yolo**）：

| approvalMode | read | write | exec |
| --- | --- | --- | --- |
| `always-ask` | 自动放行 | 询问 | 询问 |
| `write` | 自动放行 | 自动放行 | 询问 |
| `yolo`（上游默认） | 自动放行 | 自动放行 | 自动放行 |

补充事实：

- `yolo` 下**用户 `tools.approval` 策略仍然权威**（显式 deny 仍生效），且危险命令的 `override` 提示在 `yolo` 下同样生效。
- `always-ask` **仍然自动放行 read tier** —— 这一点决定了"Lex Ask ≠ 每个工具都问"。
- `--approval-mode` 是 CLI flag，写进临时 settings override；`--config` 传的是配置文件路径（不是 key=value override）。
- 上游 `startup.setupWizard` / `startup.checkUpdate` / `mcp.enableProjectConfig` 默认均为 **true**。生产显式关闭前两项；项目 MCP 配置则与其它本地引擎一致，按 OMP 原生发现规则启用，不在 Lex 启动计划里强制关闭。

### 3.4 原生 UI 交互子协议

- 出站 `extension_ui_request`，`method` 含 `confirm` / `select` / `input` / `editor` / `cancel` / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` / `open_url`；可带 `timeout`（毫秒）。
- 入站 `extension_ui_response`，三选一：`{ value: string }` | `{ confirmed: boolean }` | `{ cancelled: true, timedOut?: boolean }`；未知 id 被忽略；超时/中止时 OMP 自行解析为默认值（**不会无限挂起**）。
- `ask_request` 单独一族（`questions[]` + `timeoutMs`），用 `ask_response` 回（`answers` / `dismissed`）。
- `setTitle` 在 RPC 模式默认被抑制（需 `PI_RPC_EMIT_TITLE=1`）。

> **未核实项（P0 前置 spike，见 §11-Q1）**：上游 `docs/rpc.md` 中**没有**"工具审批"专用帧，也没有 `--approval-mode` 的说明。工具审批是否复用 `extension_ui_request(method:'confirm')` 呈现，必须在真机上抓帧确认。本 PRD 的设计对该未知**fail-closed**。

---

## 4. GUI 形态

### 4.1 引擎选择器

- `apps/desktop/src/renderer/lib/agentVendors.ts` 的 `SELECTABLE_VENDORS` 加 `'omp'`。
- `agentOptions.ts` 的 `VENDOR_PRESENTATION` 加 `omp: { label: 'OMP', Mark: OmpMark }`（新图标 `components/icons/OmpMark.tsx`）。**品牌名不进 i18n**（与 Claude / Codex / Pi 同规则）。
- `MODEL_HARNESS_COLOR` 加 `omp: 'var(--engine-badge-omp)'`，并在 light/dark 双主题各补一个色值（仓库有 hardcoded-color 审计，必须走 CSS 变量）。
- `AgentSelect.tsx` / `ModelHarnessPicker.tsx` / `unifiedModelSelection.ts` 从同一张表派生，**无需改组件**；`AgentSelect` 的面板高度常量按 `AGENT_OPTIONS.length` 自动算，加一项不会截断。
- **运行时未就绪时的呈现**：OMP 条目照常显示但带"未安装"角标；点击不静默切走，而是弹出「OMP 运行时未安装（约 150–200 MB），是否现在下载？」确认框。下载中显示字节进度。失败则条目置灰 + tooltip 脱敏原因 + 「重试」。已存在的 OMP 会话打开时，composer 变只读并挂错误条，**不自动切回其它 agent**（会话身份是用户资产）。

### 4.2 会话界面

**完全复用现有同一套组件，不新建一套 OMP 会话页。** 三个既有 agent 共用 `CCAgentSessionView` / `MessageStream` / `AssistantMessage` / `ChatInput` / `PermissionSelector` / `ModelSelector`；OMP 只要把事件投影成标准 `AgentEvent`（§5）就自动接入。

OMP 特有、需要在 UI 上表达的只有四类：

| 项 | 表达 | 优先级 |
| --- | --- | --- |
| **权限语义差异** | 权限选择器三档的 description 文案必须写明"读取类工具始终自动放行"（见 §5.2），不能照抄 Pi 的文案 | P0 |
| **运行时未就绪** | 见 §4.1 | P0 |
| **OMP 原生斜杠命令** | 输入框 `/` 触发的命令面板，条目来自 `get_available_commands`（`OmpCommandCatalog` 已实现解析 + `resolve()` 身份校验） | P1 |
| **OMP 通知类帧** | `notice` / `todo_reminder` / `extension_error` → 复用 `SystemCard`，`extension_error` 只显示脱敏后的类别，不显示原文 | P1 |

### 4.3 命令/能力映射（供事件投影实现）

| Lex `AgentSessionHandle` | OMP RPC |
| --- | --- |
| `send()` | `prompt { message, images?, streamingBehavior }` |
| `steer()` | `steer { message }` |
| （排队消息） | `follow_up { message }` |
| `abort()` | `abort` |
| `setModel()` | `set_model { provider, modelId }` |
| `setEffort()` | `set_thinking_level { level }` |
| `compactSession()` | `compact { customInstructions }` |
| `exportSessionHtml()` | `export_html { outputPath }` |
| 新建会话 | `new_session { parentSession? }` |
| 续接会话 | `switch_session { sessionPath }` |
| 会话改名 | `set_session_name { name }` |
| 分支 | `branch { entryId }` + `get_branch_messages` |
| 停止 | 关闭 stdin → OMP 优雅退出（与 `process-lifecycle` 的 draining 语义天然契合） |

`fork`（Lex 语义）无直接对应 → 用 `branch` 实现；`rewind` 无对应 → P2。

---

## 5. 权限模型映射（最关键）

### 5.1 两套模型的本质差异

- **Lex**：权限档位（`ask` / `auto` / `bypassPermissions` …）+ **host 侧交互确认链**（`setInteractionResolver` → `InteractionRequest{kind:'permission'}` → GUI 弹窗 → `allow/deny` + 可选 `permissionUpdates` 做会话级"总是允许"）。
- **OMP**：静态 tier 门（`approvalMode`）+ 可选的用户 `tools.approval` 策略；交互确认（若存在）走 `extension_ui_request(method:'confirm')`，且**没有"本次会话总是允许"这一等语义**。

因此映射必须分两层：**档位层**（静态，P0）和 **交互层**（动态，P0 最小可用 / P1 完整）。

### 5.2 档位映射表（P0，唯一权威）

| Lex `PermissionMode` | OMP `approvalMode` | read | write | exec | 用户可见行为 |
| --- | --- | --- | --- | --- | --- |
| `ask`（默认权限） | `always-ask` | 自动放行 | 每次询问 | 每次询问 | 读文件不打扰；改文件、跑命令每次弹确认卡 |
| `auto`（自动审查） | `write` | 自动放行 | 自动放行 | 每次询问 | 读写自由；执行命令仍弹确认 |
| `bypassPermissions`（完全访问） | `yolo` | 自动放行 | 自动放行 | 自动放行 | 不再弹确认；用户显式 deny 规则与危险命令 override 仍然生效 |

硬约束：

1. **必须显式传 `--approval-mode` 并写进 settings YAML**，绝不能依赖 OMP 默认值（默认 `yolo` = 全放行）。
2. **不暴露 `default` / `acceptEdits` / `plan` 三档**。`capabilities.permissionModes` 只声明上表三档，与 Pi 一致；`capabilities.planMode` 声明 `supported:false`（P2 再评估）。
3. **UI 文案必须写明"读取类工具始终自动放行"**。OMP 的 `always-ask` 不等于"每个工具都问"，照抄 Pi 的 `ask` 文案会对用户撒谎。三档的 `description` 由 maker-core 的 `PermissionModeDescriptor` 提供（`agentOptions`/i18n 只做翻译层），五语言补齐。
4. `capabilities.turnPermissionPolicy` 声明 `{ supported: true, unsupportedPermissionModes: ['bypassPermissions'] }`（与 Pi 同口径：`yolo` 下 host 无从执行 per-turn 强制确认，不能给出无法兑现的承诺）。
5. 切换权限档走 `handle.setPermissionMode()` → OMP 侧改 settings + 下一 turn 生效；**会话中途切档需要重传 `config_update` 或重启进程**——实现上取"重启进程 + `switch_session` 续接"（OMP 设置是启动期加载的），并对用户显示一次"正在应用权限设置"的短暂状态。

### 5.3 交互层：OMP 主动发起请求时怎么办

统一走 `setInteractionResolver` → 现有 `PermissionPrompt` / `AskUserQuestion` 卡片，**不新建 UI**。

| OMP 帧 | method | 映射成 Lex | UI | 回给 OMP | 超时处理 |
| --- | --- | --- | --- | --- | --- |
| `extension_ui_request` | `confirm` | `InteractionRequest{kind:'permission', toolName, input, title, description}` | `PermissionPrompt`（复用） | `respondToUi({ confirmed: true/false })` + `requestGeneration` | 见 §5.4 |
| `extension_ui_request` | `select` | `kind:'ask_user_question'`，单题 `options = labels` | 选择卡 | `respondToUi({ value: <选中的 label> })` | 同 |
| `extension_ui_request` | `input` | `kind:'ask_user_question'`，单题无 options | 文本输入弹窗 | `respondToUi({ value })` | 同 |
| `ask_request` | — | `kind:'ask_user_question'`（多题，含 `multi`） | AskUserQuestion 卡 | `ask_response { answers }` | 用帧自带 `timeoutMs` |
| `extension_ui_request` | `notify` / `setStatus` / `setWidget` / `setTitle` | 不弹窗 | `SystemCard`（P1） | 不响应 | — |
| `extension_ui_request` | `open_url` | **不自动打开** | 提示卡 + 用户手动点击 | `respondToUi({ cancelled: true })` | — |
| `host_tool_call` / `host_uri_request` | — | P0 不注册 host tools / URI schemes | — | `host_tool_result { isError: true }` / `host_uri_result { isError: true }` | — |
| 其它未知 method | — | 不弹窗，记脱敏日志 | 无 | `respondToUi({ cancelled: true })` | — |

**fail-closed 硬规则（不可协商）：**

1. **绝不默认 allow**。未登记的 `requestId`、会话不匹配、请求所属 session 已关 → 不响应 + 脱敏日志。
2. **单会话同时只允许 1 个 pending permission**（与现有 `pendingPermission` 单值一致）。第二个到达的同会话请求立即 `respondToUi({ cancelled: true })`，避免两卡片串台。
3. **`respondToUi` 必须回传 `requestGeneration`**（§2.3-2）。
4. **不做"总是允许"桥接**。Lex 的 `permissionUpdates(destination:'session')` 在 OMP 侧没有等价物；P1 若要做，只能由 Lex 自己维护一张"本会话已放行的 toolName 集合"并在下一次同 toolName 请求时**代答 `confirmed:true`**（在 Lex 进程内闭环，不能要求 OMP 记住）。P0 不做。

### 5.4 超时与收口

| 场景 | 行为 |
| --- | --- |
| 帧自带 `timeout` | 取 `min(frame.timeout, 60_000)` 作为 Lex 弹窗倒计时 |
| 无 `timeout` | Lex 默认 **30 s** |
| 倒计时归零 | ① `respondToUi({ cancelled: true, timedOut: true })`；② emit `interaction_dismissed`（让 renderer 关对话框）；③ 消息流插一条 `SystemCard`「权限请求已超时，已按拒绝处理」。OMP 侧自行解析为默认值，不会挂死。 |
| 用户点 Stop / 会话 abort / 会话 close | 对所有 pending 立即 `respondToUi({ cancelled: true })`（**不带** `timedOut`），emit `interaction_dismissed`，与现有三 agent 的 dismissal 语义一致 |
| 挂起期间用户把档位调高（ask → auto / bypass） | emit `interaction_dismissed(resolvedAs:'allow')` → `respondToUi({ confirmed: true })` → 插系统卡说明"已按新权限档自动放行"（与 Claude 现有行为一致） |
| 进程在请求挂起时崩溃 / stdin 关闭 | OMP 自行拒绝挂起请求并退出；Lex 走 `exit-unconfirmed` → 会话置为可恢复，用户重发即可 |

---

## 6. 模型与 Provider 接入

### 6.1 唯一凭据真源是 Lex，不是 OMP

**P0 不接 OMP 自己的 `login` RPC 命令与 `auth.db`。** 理由：① 凭据一旦落在 OMP 自有目录，就脱离 Cindy 账号 / 订阅 / 用量计费体系；② OAuth 弹窗在 GUI 内无法承接；③ 与 Pi 的既有做法（`PiNativeProviderSpec.apiKeyEnvVar`，密钥只进子进程 env、不落盘）保持一致。

### 6.2 模型来源（推荐：P0 只走 Cindy 网关）

| 来源 | 落地方式 | 优先级 |
| --- | --- | --- |
| **Cindy 托管模型**（推荐 P0） | host 在受管 `omp-agent-home` 生成 provider 配置（models.yml 等价物），含一个 `cindy` provider 块：`baseUrl = http://127.0.0.1:<本地 anthropic-compat 代理端口>`，api 形态 `anthropic-messages`（**待 spike 核实**），密钥走 env 注入、不落盘。复用 `anthropic-compat-proxy-host.ts` 与 Pi 的会话令牌机制（`pi-proxy-session-token.ts`）。 | P0 |
| **BYOM**（用户在 Lex 设置里配的自有 provider） | 同一个生成路径追加 provider 块；API key 走 env（变量名 `OMP_<PROVIDER>_KEY`），绝不落盘，且不合并 `process.env`。 | P1 |
| OMP 原生 provider 目录（`get_available_models`） | 只做交叉校验与"未知模型"提示，不作为 Lex 的选择来源。 | P1 |

**模型清单 UI**：`capabilities.availableModels` 由 host 通过 `capabilityAdditions.availableModels` 注入（与 Pi 同机制），来源是 Lex 现有 catalog。用户看到的模型下拉与其它三个 agent 完全一致。

**运行时切模型**：`handle.setModel(model, { providerId })` → `set_model { provider, modelId }`。OMP 的 provider/model 是二维的，Lex 的 `model + providerId` 正好对上。

**凭据错误 UX**：捕获 `error` 帧的 `auth.*` code 族（`auth.missing_api_key` / `auth.invalid_api_key` / `auth.no_models_available`）→ 映射成现有 `ErrorBanner` 的凭据错误态（与 Claude / Codex 同文案体系），引导用户到设置页修 provider。**不要把 OMP 的原始 error 文本透给用户**（现有 rpc-client 已做脱敏，保持）。

### 6.3 模型能力与 effort

- `get_state` 提供当前 `model` / `thinkingLevel` / `sessionId` / `sessionFile` / `sessionName`。
- `effort` → `set_thinking_level`（`off` / `low` / `medium` / `high` / `xhigh` 等，具体枚举以 `get_state` 实际返回为准）。`capabilities.effortLevels` 按 host catalog 声明，不从 OMP 猜。
- `supportsFastMode`：OMP 无对应概念 → 不暴露 Fast 开关。

---

## 7. 会话体系

### 7.1 对齐关系

| Lex | OMP | 说明 |
| --- | --- | --- |
| `sessions` 表一行（conversation） | 一个 OMP session（磁盘上一个 JSONL 会话文件） | 1:1 |
| `sessions.agentKind` | — | 新值 `'omp'`（DB enum 需加） |
| `sessions.sdkSessionId` | **OMP 的 `sessionFile` 绝对路径** | 必须是路径而非 `sessionId`：`switch_session` 只接受 `sessionPath` |
| 历史消息列表 | Lex DB `messages` 表 | **与其它 agent 完全一致**，不读 OMP 的 JSONL |
| `get_messages` | 仅在 DB 缺失/不一致时用 | 兜底修复通道，不是正常路径 |

### 7.2 生命周期

- **新建**：spawn 进程（cwd = `StartSessionOptions.workingDir`）→ `ready` → `new_session`（可选，显式铸造干净起点）→ `get_state` 拿 `sessionFile` → 落库 `sdkSessionId`。
- **续接**：`startSession({ resumeSessionId })` → spawn → `switch_session { sessionPath: resumeSessionId }` → `get_state` 校验 `sessionId` 未漂移 → 正常收发。**校验失败的语义复用 `StartSessionOptions.onInvalidResumeSession` 的 CAS 回调**（不得静默 fresh fallback 覆盖已有会话）。
- **持久化**：OMP 会话文件落在 `app.getPath('userData')/omp-agent-home/sessions/…`（host 受管）。**理由**：随 Lex 数据一起备份/卸载清除，与其它 agent 一致，且不污染用户仓库。**绝不复用** `~/.omp` 或 Pi 的 `~/.pi`（`docs/omp-integration.md` 已明确禁止读取或迁移 Pi 凭证与配置）。
- **历史列表 / 搜索 / 归档 / 删除**：完全由 Lex DB 与现有 IPC 承担，OMP 无特殊逻辑。
- **`/clear`**：`new_session`，并把新 `sessionFile` 写回 DB。
- **会话标题**：Lex 自己生成（现有 `title-one-shot`），**不推给 OMP**（RPC 模式已默认禁用自动标题，`setTitle` UI 请求默认抑制，正好一致）。
- **不支持**：`fork`（用 `branch` + `get_branch_messages`，P1）、`rewind`（P2）、SSH 远程（P2）。

### 7.3 会话级隔离（保留沙箱中有价值的部分）

沙箱目录每次新建是错的（会话历史要持久），但**"配置根与用户真实 HOME 隔离"这件事是对的**，必须保留：

- `HOME` / `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` / `XDG_*` / `APPDATA` / `LOCALAPPDATA` → 全部指向受管 `omp-agent-home`（不是用户 `~`）。
- Windows 仍需显式注入非秘密的 `SystemRoot` / `WINDIR`（现有 launch-plan 已做，保留）。
- `cwd` = 真实会话 `workingDir`（**这是从探测转生产的关键改动**：现有 launch-plan 把 cwd 钉在 `<sandbox>/home/workdir`，生产必须是用户项目目录）。
- 环境快照由调用者 100% 显式提供，`startOmpProcess` 不合并 `process.env`（现有契约，保留 —— 这是防凭据泄漏的核心）。

---

## 8. 运行时分发

### 8.1 结论（推荐方案）

**双轨，但生产以 Lex 的固定 CDN runtime snapshot 为准；`tools/omp/latest.json` 继续作为唯一 pin 真源。**

| 阶段 | 来源 | 落点 |
| --- | --- | --- |
| 开发 | `pnpm install:omp`（→ `tools/omp/update.mjs`，从 GitHub Release 下载，sha256 + size + URL 三重复核） | `apps/omp-bin/<platform>/omp`（Windows `omp.exe`） |
| 打包发行 | Cindy CDN（`https://hotfix.cindy.app/cindy`）+ `config/lex-agent-runtime-assets.json` 新增 `omp` 字段 | `userData/omp/<version>/omp(.exe)` |

### 8.2 具体改动清单

1. **`scripts/ensure-agent-binaries.mjs`**：`KINDS.omp` 已存在（`binDir:'omp-bin'`、`defaultInstall:false`、`cdnFallback:false`、`strictPinnedRuntime:true`）。保留 `defaultInstall:false` —— OMP 单文件 135–201 MB，绝不能进默认 postinstall / dev 首启。
2. **`apps/desktop/src/main/agent-binaries/index.ts`**：
   - `AgentBinaryKind` 加 `'omp'`；`CONFIG` 加一项，字段沿用 `pi` 的形态：
     `vendorKey:'omp'`、`manifestField:'omp'`、`installSubdir:'omp'`、`binaryName: omp(.exe)`、`devBinDir:'omp-bin'`、`vendorTag:'omp'`、`artifactKind:'raw'`（上游产物是可执行裸文件，非 tar.gz 目录）、**`optionalAsset:true`**（缺字段/下载失败不阻塞启动）、`preserveLocalVersion:true`。
   - `types.ts` 的 `VendorKey` 加 `'omp'`。
   - `artifact` 是否需要 `gz` 取决于 CDN 侧是否压缩，由运维决定；`pi` 用 `tar-gz-dir` 是因为它是目录分发，OMP 是单文件，用 `raw` 或 `gz`。
3. **`config/lex-agent-runtime-assets.json`**：4 个平台（`win32-x64` / `darwin-arm64` / `darwin-x64` / `linux-x64`）各加 `omp: { version, file, sha256, size }`，值必须与 `tools/omp/latest.json` 的同平台条目逐字一致。
   - **平台缺口**：`tools/omp/latest.json` pin 了 6 个平台（多出 `linux-arm64` / `win32-arm64`），CDN snapshot 现在只有 4 个。需补 2 个平台或明确不支持（见 §11-Q9）。
4. **`omp-probe-runtime.ts` → 重写为 `omp-runtime.ts`**：去掉"仅 dev""打包版直接拒绝"的限制；保留从 pin 重建 descriptor、URL / sha256 / size / version 全量复核、`timingSafeEqual` 比对；接入 `agent-binaries` 的受管路径解析。spawn 前必须过 `isVettedAgentBinaryPath('omp', candidate)`。
5. **版本策略**：`OMP_COMPATIBILITY_BASELINE`（`commands.ts`）与 `tools/omp/latest.json` 的 `version` 必须同值（当前 18.1.18）。**本地存在更高版本一律拒绝启动，不静默升级也不静默降级**（见 §11-Q4）。

### 8.3 用户可见行为

| 情况 | 行为 |
| --- | --- |
| 首次使用（未下载） | 引擎选择器 OMP 条目带"未安装"角标；点击 → 确认框「OMP 运行时未安装（约 150–200 MB），是否现在下载？」→ 下载中显示字节进度与速度。**绝不放在启动 splash 阻塞链路上**（与其它必装 runtime 不同）。 |
| 下载失败 / sha256 不符 / size 不符 | 条目置灰 + tooltip「OMP 运行时不可用：<脱敏原因>」+ 「重试」。已有 OMP 会话 → composer 只读 + 错误条，**不自动切回其它 agent**。 |
| 版本不匹配（本地 `--version` ≠ pin） | 按校验失败处理，同上。不启动、不降级。 |
| 下载中途取消 | 清理半成品，回到"未安装"态。 |
| 已就绪 | 与其它 agent 无差别。 |

---

## 9. 事件投影（OMP 帧 → `AgentEvent`）

新建 `packages/maker-core/src/agents/omp/translator.ts`（对齐 `pi/translator.ts` 的职责边界）。**低层事件不是可信 GUI DTO，必须按类型逐项校验与投影，不得直接广播给 Renderer**（`docs/omp-integration.md` 既有结论，继续遵守）。

| OMP 帧 | AgentEvent | 备注 |
| --- | --- | --- |
| `message_update`（text delta） | 流式文本 | 按 clientId 归集 |
| `message_update`（thinking delta） | thinking（受 `displayReasoning` 控制） | |
| `message_update`（toolcall delta） | 工具参数增量 | |
| `tool_execution_start` | 工具卡（start） | toolName + input 摘要 |
| `tool_execution_update` | 工具卡（输出增量） | **有界**：按 1 MiB 帧上限截断并标注"输出已截断" |
| `tool_execution_end` | 工具卡（end，含 isError） | |
| `agent_end` | turn 结束 | **只有 `isTerminal !== false` 才算真结束**；`isTerminal:false` = 后台仍有工作，会话会自行恢复 |
| `auto_compaction_start` / `_end` | `compact_boundary` | |
| `auto_retry_start` / `_end` | 进度区状态说明 | 复用 `shared/overload-error.ts` 的现有语义 |
| `model_changed` | 模型变更 | 回写 DB |
| `thinking_level_changed` | effort 变更 | 回写 DB |
| `notice` / `todo_reminder` | SystemCard | P1 |
| `extension_error` | SystemCard（脱敏） | 不显示原始 error 文本 |
| `error` 帧 | 终态错误 → `ErrorBanner` | 按 `code` 族映射（auth / config / provider / tool / usage …） |
| `prompt_result` | 不合成任务完成事件（既有结论，保留） | |

`stderr` 继续只 drain、不解析、不输出原文（现有 process-host 契约，保留）。

---

## 10. MVP 范围切分

### P0 —— 能用起来（要小到一轮实现能做完）

1. **`AgentKind 'omp'` 全链路穷举补齐**：`types/common.ts`、maker-shared、lizi-mcps、maker-remote-ssh（声明为不支持）、renderer `SELECTABLE_VENDORS` / `MakerVendor` / `MODEL_HARNESS_COLOR` / `OmpMark` / i18n 五语言（权限三档文案 + 引擎名不翻译）、`sessions.agentKind` DB enum。
2. **`OmpAgent`**（新 `packages/maker-core/src/agents/omp/index.ts`）：实现 `BaseAgent` + `AgentSessionHandle` 最小面 —— `startSession`（含 `new_session` / `switch_session`）、`send`、`steer`、`abort`、`close`、`events`、`getUsageSnapshot`、`setInteractionResolver`、`setModel`、`setPermissionMode`。
3. **`translator.ts`**：§9 表中 P0 标记的事件（文本 / thinking / 工具三段 / turn 结束 / compaction / 错误）。
4. **生产 launch plan**：重写 `launch-plan.ts`（参数化 cwd + 受管 omp-agent-home + `approvalMode` 注入 + 关掉 setupWizard/checkUpdate/projectConfig），删除 sandbox / preflight / probe-host 三层。
5. **权限**：§5.2 三档映射 + §5.3 fail-closed + §5.4 超时/abort 收口。`rpc-client.ts` 补 `requestGeneration` 与必要请求类型。
6. **模型**：Cindy 网关 provider（复用本地 anthropic-compat 代理 + 会话令牌）+ `set_model` + `capabilities.availableModels`。
7. **会话**：`sdkSessionId = sessionFile`，新建 / 续接 / 历史列表走 DB。
8. **运行时**：`agent-binaries` 加 `'omp'` 条目 + `omp-runtime.ts` + §8.3 的三种用户可见态。
9. **注册**：`_registerOmpAgent` + `registerOmpAgentIfAvailable` + `MAKER_PUSH.AGENTS_CHANGED`（照抄 Pi 链路）。

### P1 —— 用得好

- 交互权限桥完整形态：`select` / `input` / `ask_request` 卡片；Lex 侧代答的"本会话总是允许"白名单。
- 原生斜杠命令面板（`OmpCommandCatalog` + `get_available_commands` + `resolve()` 身份双校验，屏蔽被遮蔽条目）。
- `/clear`（`new_session`）、`compact`、`export_html`、`set_session_name`。
- BYOM 自有 provider。
- 会话分支树（`branch` + `get_branch_messages`）。
- `get_available_models` 交叉校验与刷新。
- 图片 / 文件附件（`prompt { images }`）。
- `notice` / `todo_reminder` / `extension_error` 的 SystemCard 呈现。

### P2 —— 以后再说

- SSH 远程 OMP；Cindy Device Link；IM 渠道；Orca 子代理 / 协同；Mobile。
- 扩展 / 技能 / MCP 桥（`set_host_tools` / `host_tool_call`）—— 先做信任模型再开。
- protocol v2 / `rpc_chunk` 大帧重组。
- rewind、plan mode。
- OMP 运行时自更新。

### P0 验收清单

- [ ] 全新会话：引擎切 OMP → 发消息 → 看到流式文本 + 工具卡（start/update/end）→ 正常收尾。
- [ ] 续接：退出应用再打开 → 打开同一会话继续聊，历史完整无重复。
- [ ] 权限（Ask 档）：改文件 / 跑命令弹确认；拒绝 → 工具错误正确回给模型（不是崩溃）。
- [ ] 权限（超时）：30 s 无操作 → 自动拒绝 + 系统卡 + UI 对话框关闭，OMP 不挂死。
- [ ] 权限（切档）：会话中切 Auto → 写类不再弹；切 Full access → 全部不弹。
- [ ] 模型：切换模型生效并回写 DB；凭据错误时给出可操作的 ErrorBanner（不是 OMP 原文）。
- [ ] 运行时：删掉 `apps/omp-bin` 后 dev 启动 → 提示 `pnpm install:omp`，不崩；打包版未下载时不阻塞启动。
- [ ] 门禁全过：`pnpm check:brand-terminology`、DCO（commit `-s`）、prettier 单引号、ESLint、单元测试、`@cindy/maker-core build`、`desktop typecheck`、hardcoded-color 审计、light/dark 双模式。

---

## 11. 需要客户拍板的开放问题

> 每条都给了推荐选项与理由。请逐条确认或改选。

**Q1（阻断级，最高优先级）OMP 的工具审批在 `--mode rpc` 下究竟以哪种帧呈现？**
上游 `docs/rpc.md` **没有**工具审批专用帧，也没有 `--approval-mode` 说明；只有通用的 `extension_ui_request(method:'confirm')`。
- **推荐**：P0 开工前先做 1 天真机 spike —— 起 v18.1.18，`always-ask` 下触发一次 write、一次 exec，抓 stdout 帧确认。
- 若确实是 `extension_ui_request` → §5.3 全表按 P0 实现。
- 若**不是**（审批只在 TTY 下发生、RPC 下直接按 tier 放行或阻断）→ P0 权限只剩 §5.2 三档静态门，**交互确认降级为 P1**，且 Ask / Auto 档的实际保护弱于其它三个 agent，必须在权限选择器文案与首次使用提示中**明示**这一差异，不能对用户撒谎。

**Q2 是否接受把 OMP 纳入 Cindy 固定 CDN runtime snapshot？**
需要运维把 6 平台 × 135–201 MB 的二进制镜像到 `hotfix.cindy.app/cindy`，并更新 `config/lex-agent-runtime-assets.json`。
- **推荐：是**。否则打包版用户根本拿不到二进制（GitHub Release 在国内网络与供应链审计上都不合格），OMP 只会是 dev-only 玩具。

**Q3 P0 是否必须支持 Cindy 托管模型（走本地 anthropic-compat 代理）？**
- **推荐：是**。绝大多数 Lex 用户是 Cindy 登录态 + 订阅；只有 BYOM 用户能用 = 等于不可用。
- 替代（更快但面更小）：P0 仅 BYOM，Cindy 网关放 P1。
- 前置核实：OMP 的 provider 配置是否支持 `anthropic-messages` 形态、能否指向 loopback 代理并注入 per-request header。

**Q4 版本策略：锁死 18.1.18，还是允许本地更高版本？**
- **推荐：锁死**。`OMP_COMPATIBILITY_BASELINE` 与 pin 同值，本地更高版本一律拒绝启动。OMP 上游迭代极快（仓库已到 v18.x），协议漂移风险高；跟随上游必须每次重跑协议审查 + 更新 pin + 更新本 PRD 的 §3。

**Q5 OMP 会话文件放哪？**
- **推荐：Lex `userData/omp-agent-home/sessions/`**（与其它 agent 一致，随 Lex 备份/卸载走，不污染用户仓库）。
- 替代：跟随项目（`.omp/` 目录）——好处是会话跟着仓库走，坏处是污染用户仓库且无法跨设备。

**Q6 是否允许 OMP 复用 Pi 的用户目录（`~/.pi` / 原生 `~/.omp`）？**
- **推荐：绝不复用**。`docs/omp-integration.md` 已明确禁止读取或迁移 Pi 的凭证；且两个引擎共享配置根会造成难以诊断的串扰。

**Q7（已决）是否允许 OMP 加载项目级配置 / MCP / 扩展 / 技能 / rules / LSP / PTY？**
- **决定：允许，按 Claude Code、Codex、Pi 的本地引擎范式对齐。** 早期分阶段实施的 `--no-extensions` / `--no-skills` / `--no-rules` / `--no-lsp` / `--no-pty` 与 `mcp.enableProjectConfig:false` 已移除；OMP 在真实工作目录中按原生规则发现这些能力。
- Lex 仍保留跨引擎一致的托管边界：每个 live runtime 有独立 HOME 和 OMP config / session 根，模型和认证经受管 `cindy` provider 代理，环境只传明确的可执行白名单，Lex 继续拥有任务标题和进程生命周期。共享 `~/.agents/skills` 会投影进受管 HOME；不复用 Pi 或用户 `~/.omp` 的认证 / 配置。
- 这不是把原生项目扩展、MCP server 或工具行为描述为 OS 沙箱或额外的 Lex 授权层；其能力和副作用遵循上游 OMP 与用户选择的项目上下文。

**Q8 单帧 1 MiB 上限带来的大输出截断，P0 接受吗？**
- **推荐：P0 接受**（在工具卡片上标注"输出已截断"），v2 协商 + `rpc_chunk` 重组放 P1。当前 `jsonl-reader.ts` 把 `rpc_chunk` 当致命错误关连接，改它需要独立的字节边界测试。

**Q9 Linux-arm64 / Win32-arm64 是否需要支持？**
`tools/omp/latest.json` pin 了 6 平台，但 `config/lex-agent-runtime-assets.json` 现有只有 4 平台（`win32-x64` / `darwin-arm64` / `darwin-x64` / `linux-x64`）。
- **推荐：P0 只做现有 4 平台**，另外 2 平台在 `omp-runtime.ts` 返回明确的"平台不支持"，避免用户看到下载到一半失败。若需要补齐，请一并在 Q2 里告知运维。

**Q10 OMP 引擎图标与品牌色**
`OmpMark` 图标与 `--engine-badge-omp`（light/dark 两个值）需要设计输入。
- **推荐**：先用一个中性几何 mark 占位（与 `PiMark` / `CodexMark` 同族、同视觉重量），品牌色取一个不与现有三色（cc / codex / pi）撞的色相；正式视觉资产走一次设计评审再替换。
