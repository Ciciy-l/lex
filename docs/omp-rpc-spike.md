# OMP RPC 真机 Spike 报告

> 真机抓取，非文档推断。环境：`apps/omp-bin/win32-x64/omp.exe`（v18.1.18，SHA-256 `d9cf77…4378` 逐字节匹配 pin）。
> 抓取方式：隔离沙箱 HOME + dummy OpenAI key 骗过启动模型门，spawn `--mode rpc` / `--mode rpc-ui`，逐行抓 JSONL 帧。
> 日期：2026-09-13。

## 0. 结论速览

| 验证项 | 结果 | 依据 |
|---|---|---|
| `--version` 输出 | ✅ `omp/18.1.18`（严格匹配 `OMP_COMPATIBILITY_BASELINE`） | 直接运行 |
| `--approval-mode` 参数 | ✅ **真实存在**，取值 `always-ask \| write \| yolo` | `--help` 输出 |
| `--mode rpc` / `rpc-ui` | ✅ 两种都存在，握手与 UI 请求通道**完全一致** | 两种模式各跑一遍 |
| 握手帧 `ready` | ✅ 协议 v1，**支持 v1+v2**，1 MiB 帧，64 MiB 重组 | FRAME 1 |
| `extension_ui_request` 通道 | ✅ 真实存在（抓到 `method: setWidget`） | FRAME 2/14 |
| 动态命令目录 | ✅ 巨大，source 分 `builtin/extension/file` 三类 | FRAME 3/5 |
| prompt 事件流 | ✅ `agent_start→turn_start→message_start/end→turn_end→agent_end(isTerminal)` | FRAME 6-15 |
| 错误路径 | ✅ `stopReason:"error"` + `errorStatus:401` + `errorMessage` | FRAME 11-13 |
| **工具审批帧形态** | ✅ **已抓到，是 `method: select` 不是 `confirm`** | live spike §9 |
| **`requestGeneration` 字段是否存在** | ✅ **已确认不存在**（v18.1.18） | live spike §9 |
| **`models.yml` 自定义 provider 注入** | ✅ **真机验证通过** | live spike §9 |

**Q1（PM 头号阻断项）状态：已全部告破（2026-09-13 live spike）。** 工具审批帧、requestGeneration、`models.yml` provider 兼容性全部真机验证通过，见 §9。

## 1. 握手帧

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],
 "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

- `protocolVersion: 1`，但 `supportedProtocolVersions: [1,2]`。
- `maxFrameBytes: 1048576`（1 MiB）—— 与代码 `OMP_MAX_FRAME_BYTES` 一致。
- `maxReassembledFrameBytes: 67108864`（64 MiB）—— **说明 v2 有分块重组**（`rpc_chunk`），v1 收到 `rpc_chunk` 应关连接（现有 `rpc-client.ts:233` 行为正确）。

## 2. `extension_ui_request` 帧

抓到的真实帧（两个，均在 prompt 前后自发出现）：

```json
{"type":"extension_ui_request","id":"157cef2507e8562c","method":"setWidget","widgetKey":"autoresearch"}
```

- **确实存在**，在 `rpc` 与 `rpc-ui` 两种模式下都会出现。
- `id` 是 16 位 hex（如 `157cef2507e8562c`），**无 `requestGeneration` 字段**。
- 目前只抓到 `method: setWidget`（fire-and-forget 性质）。`method: confirm`（工具审批）**未抓到**。
- 现有 `rpc-client.ts` 的 `respondToUi` 只回传 `{...payload, type:'extension_ui_response', id}`，**不含 generation**。若 `confirm` 帧带 generation 而宿主不回传，旧响应会套到新请求上——此风险仍需 `confirm` 帧实证。

## 3. 动态命令目录

`get_available_commands` 返回约 40 个命令，节选：

```
security, model(models), switch, fast, skillful, extended-context, computer,
prewalk, advisor, export, trace, dump, share, browser, todo, session, jobs,
usage, stats, changelog, tools, context, mcp, ssh, fresh, compact, shake,
handoff, pin, retry, memory, rename, move, wt(worktree), add-dir, remove-dir,
dirs, marketplace, plugins, reload-plugins, force, autoresearch, init
```

- `source` 字段三类：`builtin`（绝大多数）/ `extension`（如 `autoresearch`）/ `file`（如 `init`）。
- 与 Lex 现有 `/` 命令面板的分组模型（builtin/skill/extension/custom/mcp_prompt/file）可对齐。

## 4. prompt 事件流（真实顺序）

```
FRAME 6:  {id:"q-prompt", type:"response", command:"prompt", success:true}   ← 请求被接受
FRAME 7:  {type:"agent_start"}
FRAME 8:  {type:"turn_start"}
FRAME 9:  {type:"message_start", message:{role:"user", content:[{type:"text",...}], attribution:"user"}}
FRAME 10: {type:"message_end",   message:{role:"user", ...}}
FRAME 11: {type:"message_start", message:{role:"assistant", stopReason:"error", errorStatus:401, errorId, errorMessage}}
FRAME 12: {type:"message_end",   message:{...}}
FRAME 13: {type:"turn_end",      message:{...}, toolResults:[]}
FRAME 14: {type:"extension_ui_request", method:"setWidget", ...}
FRAME 15: {type:"agent_end", messages:[...], isTerminal:true}
```

- 事件粒度：`agent_*` > `turn_*` > `message_*`。`agent_end.isTerminal` 是终态标志。
- 与 Lex `AgentEvent` 的映射关系需由 translator 建立（text/thinking/tool_use/tool_result/status/done/error 等）。

## 5. 错误路径

401 错误帧结构（dummy key 触发）：

```json
{"role":"assistant","api":"openai-responses","provider":"openai","model":"gpt-5.5",
 "stopReason":"error","errorStatus":401,"errorId":16781312,
 "errorMessage":"401 Incorrect API key provided: dummy-ke*******pike. ...",
 "usage":{...},"cost":{...}}
```

- 错误信息**带 key 前缀遮蔽**（`dummy-ke*******pike`），OMP 自己做脱敏。
- `stopReason:"error"` + `errorStatus` + `errorId` + `errorMessage` 是 translator 识别错误的依据。

## 6. `get_state` 返回（重点）

一次返回四大块：

**a) 模型目录条目**（节选，含完整 compat 能力标志）：
```json
{"model":{"id":"gpt-5.5","name":"GPT-5.5","api":"openai-responses","provider":"openai",
  "baseUrl":"https://api.openai.com/v1","reasoning":true,"input":["text","image"],
  "cost":{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0},
  "contextWindow":1050000,"maxTokens":128000,
  "thinking":{"mode":"effort","efforts":["low","medium","high","xhigh"]},
  "compat":{"supportsToolChoice":true,"supportsReasoningEffort":true, ...}}}
```
- `compat` 下有数十个 `supports*` 布尔标志，是 OMP 模型能力的真实结构。

**b) 会话状态**：`sessionId`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`、`interruptMode`、`autoCompactionEnabled`、`fastModeEnabled` 等。

**c) 内置工具目录**：`glob / grep / task / hub / todo / web_search / write`（带完整 JSON Schema 参数定义）。

**d) 完整 system prompt**（Oh My Pi coding harness 角色定义）。

## 7. 潜在障碍（对接 Cindy 托管需注意）

- `OPENAI_BASE_URL=http://127.0.0.1:9/v1` **未生效**：dummy key 的 401 来自 `https://api.openai.com/v1` 官方端点，`get_state` 里 `baseUrl` 也是官方地址。
- **含义**：OMP 可能不读 `OPENAI_BASE_URL` 环境变量，或需经 `models.yml` / `--config` 显式配置 baseUrl。接入 Cindy 托管端点时，自定义 baseUrl 的注入路径需要另行验证，不能假设环境变量可用。

## 8. 下一步（破 confirm 帧）

抓 `method: confirm` 帧需一个能真正执行到"决定调工具"的可用 provider：

1. 任一可用 key（OpenAI / Anthropic / Gemini）或 Cindy 托管端点凭据。
2. 设 `--approval-mode always-ask`，prompt 一个必然触发写操作的任务（如"Create hello.txt"）。
3. 观察 OMP 是否发出 `extension_ui_request(method: confirm)`，记录其完整字段（重点：`requestGeneration`、超时、工具名、输入）。

在此之前，权限桥的 `confirm` 帧字段级设计保持待定。

---

## 9. Live Spike（真实 provider，2026-09-13）— Q1 全部告破

provider：MiniMax anthropic-compat 端点（`https://api.minimaxi.com/anthropic`），经 `models.yml` 注入（provider id `cindy`，`apiKey` 按环境变量名解析，不落盘）。模型 `MiniMax-M2`。本次 spike 的全部密钥仅经进程 env 传递，未落盘、未入档。

### 9.1 `models.yml` provider 真机生效

`get_state` 返回：

```json
{"model":{"id":"MiniMax-M2","api":"anthropic-messages","provider":"cindy",
  "baseUrl":"https://api.minimaxi.com/anthropic","isOAuth":true,
  "identity":{"class":"minimax","family":"m2"}}}
```

- `provider` / `baseUrl` / `api` 全部来自 `models.yml` → **架构方案的 provider 注入路径真机验证通过**。
- 注意 `"isOAuth":true`：OMP 的 anthropic-messages 适配器把自定义 provider 判定为 OAuth 形态（印证架构对"key 形态判定"风险的预测），但 `x-api-key` 鉴权仍正常工作 → 该判定不影响功能，实现时留意即可。
- §7 的"OPENAI_BASE_URL 未生效"疑虑闭环：自定义端点必须走 `models.yml`（base-url 环境变量只覆盖本地引擎），与上游设计一致。

### 9.2 工具审批帧 = `method: select`（不是 `confirm`）

`write` 工具在 `always-ask` 档触发：

```json
{"type":"extension_ui_request","id":"157cf60a9ce9ac08","method":"select",
  "title":"Allow tool: write\nPath: hello.txt\nContent:\nhi",
  "options":["Approve","Deny"]}
```

- **method 是 `select`**，带 `title`（人性化描述）+ `options`（字符串数组）。
- **无 `requestGeneration`**（keys 仅 `type/id/method/title/options`）—— v18.1.18 无 generation 概念。架构的"有才 echo"防御设计保留即可，不会误传。
- **响应格式按 method 区分**（实证）：
  - `select` → `{type:'extension_ui_response', id, value:<option 字符串>}`（回 `value:"Approve"` 成功；误回 `{confirmed:true}` 被当 deny，OMP 报 "Tool call denied by user"）
  - `confirm` → `{..., confirmed:true|false}`
  - `input` → `{..., value:<文本>}`
- 现有 `rpc-client.ts` 的 `respondToUi` 已支持三种变体（`value`/`confirmed`/`cancelled`），与实测一致——协议层无需为此改动。

### 9.3 read tier 自动放行（铁律③实证）

同一 session 内：`write` 触发 `select` 审批帧；随后的 `read`（读回校验）**没有**发审批帧、直接执行。坐实"always-ask 下 read 始终自动放行"——UI 文案必须如实写明，不得称"已受 Lex 保护"。

### 9.4 完整工具事件流（含流式）

```
tool_execution_start  {toolCallId, toolName, args, intent}
tool_execution_update {toolCallId, partialResult, details.resolvedPath}
tool_execution_end    {toolCallId, result, isError}
```

- `intent`（如 "Create hello.txt with text hi"）是工具意图的人性化描述，可直接用于 GUI 工具卡标题。
- `tool_execution_update.partialResult` 提供流式工具输出。
- `details.resolvedPath` 是工具实际操作的绝对路径。

### 9.5 流式 `message_update`（`assistantMessageEvent` 子类型）

```
thinking_delta / thinking_end / toolcall_start / toolcall_delta / toolcall_end / text_start / text_delta
```

这是 translator 映射 `thinking` / `text` / 工具参数增量的依据。`stopReason` 实证取值：`"toolUse"` / `"stop"` / `"error"`。

### 9.6 OMP 的被拒重试行为

误回 `{confirmed:true}`（=deny）后，OMP 依次换 `write` → `bash(echo hi > hello.txt)` → `eval(Bun.write)` 三种方式重试，每次各发一个独立审批帧。含义：deny 非终态，OMP 会寻找替代路径继续完成任务；每次替代都重新经过权限链 → 无绕过风险，但 GUI 会看到连续多个审批卡。

### 9.7 端到端确认

真实写入成功：`hello.txt` 落盘 workdir（内容 `hi`），`tool_execution_end.isError:false`。

---

## 10. Header 插值实验（判定性，2026-09-14）

### 10.1 目的

`models.yml` 的 `apiKey` 按环境变量名解析（§0.1-2），那 `headers` 的值是否也支持
`$VAR` / `${VAR}` 插值？这一点决定 **Cindy 会话 token 能不能放进 headers**：
若不插值，把 token 写进 `models.yml` 就等于密钥明文落盘，与"凭证只进子进程 env、
不落盘"的口径直接冲突。

### 10.2 方法

- 脚本：`F:\Projects\lex\tmp\omp-spike-headers.mjs`（可复现；本地 `omp.exe`
  v18.1.18 + 本地 HTTP 回显服务器，把三种写法同时放进同一个 provider 块，
  打印 OMP 实际发出的头）。
- 三种写法：`headers: { x-spike-dollar: $SPIKE_TOKEN }`、`{ x-spike-brace: ${SPIKE_TOKEN} }`、
  `{ x-spike-literal: LITERAL-VALUE }`；同时 `apiKey: SPIKE_TOKEN`（env 名），
  进程 env 里 `SPIKE_TOKEN=RESOLVED-SECRET-VALUE`。
- 结果抓取：回显服务器记录全部请求头，日志落 `%TMP%/omp-header-spike.json`。

### 10.3 结果（5 次请求一致）

| models.yml 写法 | OMP 实际发出 |
| --- | --- |
| `x-spike-dollar: $SPIKE_TOKEN` | `x-spike-dollar: $SPIKE_TOKEN`（**原样，不插值**） |
| `x-spike-brace: ${SPIKE_TOKEN}` | `x-spike-brace: ${SPIKE_TOKEN}`（**原样，不插值**） |
| `x-spike-literal: LITERAL-VALUE` | `x-spike-literal: LITERAL-VALUE`（原样） |
| `apiKey: SPIKE_TOKEN`（env 名） | `Authorization: Bearer RESOLVED-SECRET-VALUE`（**按 env 名解析**） |

**结论：OMP 对 header 值不做任何环境变量插值，但对 `apiKey` 的 env 名解析生效。**

### 10.4 对实现的约束（T02 已落地，T04 照此实现）

1. **秘密一律走 `apiKeyEnv`**：只写 env 名，值由 host 注入子进程 env，
   `models.yml` 里不含任何密钥。
2. **headers 只放非敏感标识**（provider id、session id）。Cindy 的**会话 token
   不放 headers**，而是作为 `apiKeyEnv` 指向的环境变量值注入 —— OMP 会以
   `Authorization: Bearer <token>` 发出，本地 `anthropic-compat-proxy-host.ts`
   从该头取回（proxy 在我们自己手里，可以这么约定）。
3. `models-config.ts` 对 header 值做硬校验：`$VAR` / `${VAR}` 形态**直接抛错**，
   报错信息指明"OMP 不插值，密钥请走 apiKeyEnv"。这类写法不会插值却极易被误以为会，
   属于会骗人的写法。
