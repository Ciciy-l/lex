# C2 模型目录来源台账

状态：C2 数据核实与窄实现台账；不把原提交前的门禁追溯改写为通过，也不宣称外部服务已同步。本文与 C2 实现同一原子变更集提交；提交 SHA/tree 在完成报告中记录。

## 快照与边界

- 基线：aad281ca627faceecab00ec86f20a6dfcf4c6b26，40 个既有提交，基线 tree 为 d8d76568927c6c0eab99a9b99cfbd9ed0b3a07e1；保留历史，不 reset/amend/push。
- 数据边界：只采用上游 #5039（235c3953e3afb60447a29a692d5a3b23e28bcd53）与 v0.1.96 tag f7f265ef2e4316d37a7ce6d4e03006a826e397e4 内、经实际 diff 定位的 #5050/#5060/#5063/#5119/#5145 hunk；不吸收 tag 之后模型。
- C1 机制来源与 6e7f01b 主候选、87ce800 preset 候选的根门禁证据仍见 C1 台账（c1-model-catalog-source-ledger.md），C2 不将其旧失败快照改写。
- Registry 参考价只用于本地展示/比较；XD Gateway 实际计费、账号套餐价值与路由收款不由此推导。没有下载权重、在线同步 Pi 目录、登录账号或修改外部服务。

## 一级材料与写入事实

| 范围 | 一级材料/通道 | 本轮写入 | 未写入或仍未知 |
| --- | --- | --- | --- |
| #5039 本地候选 | Qwen3.8 Flash-Next 官方模型卡（https://huggingface.co/Qwen/Qwen3.8-Flash-Next/raw/main/README.md）、官方 Ollama tags（https://ollama.com/library/qwen3.8-flash-next/tags）、Rapid-MLX 记录（https://huggingface.co/rapid-mlx/Qwen3.8-Flash-Next-4bit）；Laguna S 2.1 官方模型卡（https://huggingface.co/poolside/Laguna-S-2.1/raw/main/README.md）、官方 Ollama tags（https://ollama.com/library/laguna-s-2.1/tags） | 8 个本地候选；Flash-Next 的 MLX/Q4 标签与下载字节；Laguna 的 118B/8B active/1,048,576 原生窗口、NVFP4/Q4 标签与下载字节；featuredIds 仍只有 qwen38-27b。 | Ollama 加载/速度/峰值内存/工具多轮、满窗口稳定性、量化后能力和固定 digest；门槛是产品提示，不是最低运行内存证明。 |
| #5060 Grok 4.7 Fast | xAI 官方 pricing（https://docs.x.ai/developers/pricing.md），匿名 GET，HTTP 200；2026-10-02/2026-10-04 均只核对当前页面 | Grok 4.7 500K 窗口；standard global `<200K` 与 `>=200K` 参考价（2/6/0.5、4/12/1 USD/M）；Fast 保留独立身份与 OAuth/Build 目标映射，但不写 Fast 参考价。 | Fast 数值表虽可见（4/12/1、6/18/1.5），页面没有可追溯的历史 `effectiveFrom`；tag 日期 `2026-09-24` 不是生效证据，已删除该日期的 Fast 价格段。Fast 不在公共 xAI API；Cursor/Grok Build 由计划计费；US `us.api.x.ai` 的 1.1x 与未知区域价不套 global。 |
| #5119 推荐预设 | Kimi K3 官方 pricing/quickstart（https://platform.kimi.ai/docs/pricing/chat-k3.md）、Google Gemini pricing（https://ai.google.dev/gemini-api/docs/pricing）、Meta pricing/rate limits（https://dev.meta.ai/docs/pricing-rate-limits）；2026-10-02/2026-10-04 匿名 GET 与 tag diff | 共享顶层 `models` 只展开声明的 claude-code/codex/pi/omp；旧 runtime URL、协议、discovery、Pi catalog 保留；engine override 与 Codex 图片桥接边界保留。Gemini 3.8 只保留官方页明确的 `2027-01-01` Standard 价格段；当前段仍未知，不伪称已覆盖。Kimi K3 现有价格段不变。 | Meta 页面只确认 Muse 名称/tiers，详细 numeric rates 的后续请求 TLS 失败，故 Muse 1.2/1.3 不写数值；Kimi K2.8 未新增 numeric price 或历史生效日期；Kimi K3 当前页不证明既有历史起点。`aad281ca..HEAD` 的参考价差异仅为 Gemini 未来段；本轮工作树另删除无历史生效日的 Fast 段。 |
| #5050/#5063/#5145 | 原始 Git 对象完整消息与实际 tag diff；C1 机制实现已在基线历史 | 保留已授权 Sub2API/sparse metadata、XD identity、账号成员权威与 discovery 机制；C2 只带数据/route/preset 边界需要的 hunk，沿用既有 auth/route 合同。 | 不引入 native CLI 登录重写、凭空新增 Gateway 成员、把 Registry 参考价当真实 XD 计费。 |

## source → hunk → local target

目标为从 aad281ca 生成的同一 C2 原子变更集；本文件不预写未知的未来 commit SHA，完成报告记录真实 commit/tree。旧 C2 根 meta `C2-aad281ca-root-unit-related-20261004-034157.meta.log` 的 `base-commit=aad281ca...` 与 `tree=aad281ca...` 是基线快照，不能冒充候选 tree；该原文件保留不改。新的冻结 runner 必须独立记录 `baseCommit`、冻结候选 `tree`、起止时间和真实 exit，完成报告再同时给出候选 tree 与本地提交最终 tree。

- 235c3953e3 / #5039 → packages/model-providers/catalog/model-registry.json 的 localModels 增量（8 个逻辑候选、Flash-Next Q4、Laguna）、apps/desktop/src/shared/localModelRuntime.ts 的 nvfp4/Q4 识别与回归、docs/local-model-audit-2026-09-24.md 的事实/未知台账。
- d6cd6f3d11 / #5050 → 以基线已有的 Sub2API/sparse metadata 机制为依赖；tag diff 中只保留已授权 provider metadata/协议边界，不新增与 Lex auth 不相容的架构。
- 2770145bab / #5060 → packages/model-providers/catalog/model-registry.json 的 xai/grok-4.7-build-fast 独立 base/route/reference-price 与 packages/model-providers/catalog/providers.json 的 fastModelId，并由既有 public-API guard 维持公共 xAI 无 Fast。
- #5063/#5119/#5145 → C1 台账已有机制映射；本 C2 树只承接 tag 内 XD 拆分条目、DeepSeek route identity、共享 preset 推荐数据与旧/新 preset parse/expand 消费，详见对应测试与本台账未知项。
- 当前代码消费边界：expandPresetModels 结果在 sanitize/parse/builtin/Pi augmentation 处使用；runtime 缺 models 时不以旧空数组覆盖顶层声明；畸形 scope 整条拒绝且不变异输入。

## 冻结候选与根门禁 tree 证据

本轮根门禁针对冻结源码与索引运行；不要把旧基线 meta 的 `tree=aad281ca...` 当作候选 tree。可复核记录如下：

- `base-commit=8a28edd493d2df6f3959716983ebac7b91cffd3f`，其基线 tree 为 `a6c56dbdd2b5073f304c42571415cb3e7a7244b1`。
- 冻结候选由 `git write-tree` 记录；根门禁 meta 的 `candidate-tree` 字段是该冻结值，不能用基线 commit 或基线 tree 代替。
- 本轮根门禁 meta：`F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/C2-final-root-unit-related-20261004-055100.meta.log`；stdout：同前缀 `.stdout.log`。
- 命令：`pnpm 10.33.2 test:unit:related (Node 22.22.3)`；UTC 起止、`exit` 和 workspace 汇总以该 meta/stdout 的实际记录为准。
- 该 meta 的 `base-commit`、冻结 `candidate-tree`、起止时间和退出码分别核对；旧的 `C2-aad281ca-root-unit-related-20261004-034157.meta.log` 保留原样，仅代表基线快照。提交前后分别用 `git write-tree` 与 `git show --format=%T` 核对冻结候选 tree 和最终 commit tree；若不一致，不能沿用本证据。

## 价格日期与 resolver 边界核对

- `aad281ca..HEAD` 的 `baseModels[].referencePriceGroups` 实际差异只有 `google/gemini-3.8-flash` 的 Standard 未来段：官方页观察到 `2027-01-01` 起为 input `1.5` / output `7.5` / cache-read `0.15` USD/M；`2026-12-31` 没有可写入的当前段，因为本轮没有证实其历史起始日。现有测试在 `2026-12-31` 断言 `undefined`，在 `2027-01-01` 断言该未来段。tag 中的 `2026-09-23` 不能代替历史生效证据。
- Grok 4.7 Standard 的既有历史段没有改写：`199999` 选择 2/6/0.5，`200000` 和 `200001` 选择 4/12/1；这是 resolver 的 `[minInputTokens,maxInputTokens)` 合同与 xAI 当前表（`>=200K`）的交集。Fast 页面虽然给出数值表，但未给历史 `effectiveFrom`，因此本候选删除 Fast 的两段参考价；`200000`/`200001` 对 Fast 都返回 `undefined`，不把观察日或 tag 日期伪装成生效日。
- 因 Fast 没有可解析的参考价组，`xai/grok-4.7-build-fast` 的 route 也不再声明 `referencePriceGroup`；独立模型身份、route、OAuth/Build 目标约束仍保留，避免把“无价”错误解析成 unresolved 或 global 价格。
- Kimi K3 在本轮没有价格 hunk：global 的既有历史段（含其既有日期）保持原样；2026-10-04 访问当前官方页只能确认当前价格/窗口，不能回溯其历史 cutoff 或 cache-write 起点。没有为 Kimi 新造日期，也没有把当前页观察日写入 registry。
- 参考价只走既有 route/base resolver，不进入 Gateway receipt 或实际套餐计费；未知区域（尤其 US）不套 global。

## XD 旧 route → 独立 entry → provider/upstream 映射

以下是当前 `model-registry.json` 中每一条 `entry.id` 以 `xd/` 开头的 route；每行都保留旧 `route.modelId` 供存量配置解析，entry 名称仍是用户可读名称。最后一列是 Registry 的 `modelRef`，不是对 XD 实际收款/上游可用性的推断；标为 `self/unknown` 的值不再猜 vendor。

- `gpt-5.6-sol` → `xd/gpt-5.6-sol` → `xd` / `openai/gpt-5.6-sol`；`gpt-5.6-terra` → `xd/gpt-5.6-terra` → `xd` / `openai/gpt-5.6-terra`；`gpt-5.6-luna` → `xd/gpt-5.6-luna` → `xd` / `openai/gpt-5.6-luna`。
- `gpt-5.5` → `xd/gpt-5.5` → `xd` / `openai/gpt-5.5`；`gpt-5.4` → `xd/gpt-5.4` → `xd` / `openai/gpt-5.4`；`gpt-5.4-mini` → `xd/gpt-5.4-mini` → `xd` / `openai/gpt-5.4-mini`。
- `codex/gpt-5.6-luna` → `xd/codex-gpt-5.6-luna` → `xd` / `openai/gpt-5.6-luna`；`codex/gpt-5.6-sol` → `xd/codex-gpt-5.6-sol` → `xd` / `openai/gpt-5.6-sol`；`codex/gpt-5.6-terra` → `xd/codex-gpt-5.6-terra` → `xd` / `openai/gpt-5.6-terra`。
- `codex/gpt-5.5` → `xd/codex-gpt-5.5` → `xd` / `openai/gpt-5.5`；`codex/gpt-5.4` → `xd/codex-gpt-5.4` → `xd` / `openai/gpt-5.4`；`codex/gpt-5.4-mini` → `xd/codex-gpt-5.4-mini` → `xd` / `openai/gpt-5.4-mini`；`codex/gpt-5.5:auto` → `xd/codex-gpt-5.5-auto` → `xd` / `openai/gpt-5.5-auto`。
- `z-ai/glm-5.3-flash` → `xd/z-ai-glm-5.3-flash` → `xd` / `self/unknown`；该 entry 的 `modelRef` 也是 `xd/z-ai-glm-5.3-flash`，本台账不把它改写为 z.ai 路由。
- `moonshot/kimi-k3`、`moonshotai/kimi-k3` → `xd/moonshotai-kimi-k3` → `xd` / `self/unknown`；旧 Kimi alias 仍列在 entry aliases，显式 user metadata 优先。
- `deepseek/deepseek-v4-pro` → `xd/deepseek-deepseek-v4-pro` → `xd` / `deepseek/deepseek-v4-pro`；`deepseek/deepseek-v4-flash` → `xd/deepseek-deepseek-v4-flash` → `xd` / `deepseek/deepseek-v4-flash`。
- `deepseek/deepseek-v4-flash-vision-exp` → `xd/deepseek-deepseek-v4-flash-vision-exp` → `xd` / `self/unknown`；`tencent/hy4-preview` → `xd/tencent-hy4-preview` → `xd` / `self/unknown`。
- `claude-fable-5` → `xd/claude-fable-5` → `xd` / `anthropic/claude-fable-5`；`claude-opus-5` → `xd/claude-opus-5` → `xd` / `anthropic/claude-opus-5`；`claude-opus-4-8` → `xd/claude-opus-4-8` → `xd` / `anthropic/claude-opus-4-8`。
- `claude-opus-4-7` → `xd/claude-opus-4-7` → `xd` / `anthropic/claude-opus-4-7`；`claude-opus-4-6` → `xd/claude-opus-4-6` → `xd` / `anthropic/claude-opus-4-6`；`claude-opus-4-5` → `xd/claude-opus-4-5` → `xd` / `anthropic/claude-opus-4-5`。
- `claude-sonnet-5` → `xd/claude-sonnet-5` → `xd` / `anthropic/claude-sonnet-5`；`claude-sonnet-4-6` → `xd/claude-sonnet-4-6` → `xd` / `anthropic/claude-sonnet-4-6`；`claude-sonnet-4-5` → `xd/claude-sonnet-4-5` → `xd` / `anthropic/claude-sonnet-4-5`；`claude-haiku-4-5` → `xd/claude-haiku-4-5` → `xd` / `anthropic/claude-haiku-4-5`。
- `gpt-5.4-nano` → `xd/gpt-5.4-nano` → `xd` / `openai/gpt-5.4-nano`。

`packages/model-providers/src/__tests__/modelRegistry.test.ts` 的显式用例覆盖 Claude/DeepSeek/GPT Nano、Kimi alias、entry label 和用户 override；动态用例再遍历以上全部 31 条 split route，核对旧 route、独立 entry、`modelRef` 与 provider。`findModelRegistryRoute` 保留旧 `providerId/modelId`，`resolveModelMetadata` 按 user layer 优先；没有凭 Registry 增加 Gateway 成员。

## `providers.json` 实际语义 diff 与一级页面核对

`8a28edd4^..8a28edd4` 的 2882 行变化不是 28 个预设全部换端点：它把每个预设的推荐型号从各 runtime 的旧 `runtimes.*.models` 投影为一份顶层 `models`，再由 `expandPresetModels` 按 `engines`/`engineOverrides` 展开。下表的“旧 runtime 移除”是源格式中的旧数组成员；同名成员由展开结果继续提供，不等同于供应商下线。`+` 是顶层推荐清单新增/替换的型号；`w` 是候选记录的窗口，`img` 是图片字段，`R` 是 Pi reasoning 档位，`?` 是该字段未声明。窗口、图片和努力字段来自 tag-bounded source hunk；若页面核对没有给出同一精确值，台账将其作为 tag snapshot/unknown，不把观察日或服务端当前清单写成历史事实。

| 预设 | 顶层 `models`（+ 型号；`w`/`img`/`R`） | 旧 runtime 型号移除（union） | 保留的协议/路由字段 |
| --- | --- | --- | --- |
| `sub2api` | `models: []` | 无 | 三个 runtime 仍为 `{endpoint}/v1`、`openai-responses`、models URL。 |
| `openrouter` | `z-ai/glm-5.2(w1048576,img0)`、`moonshotai/kimi-k2.6(262144,1)`、`deepseek/deepseek-v4-pro(1048576,0,E=claude-code|pi)`、`qwen/qwen3.8-27b(1000000,1)`、`qwen/qwen3.8-2.4t-a95b(1048576,0)`、`qwen/qwen3.8-flash(1000000,1)` | `z-ai/glm-5.2`, `moonshotai/kimi-k2.6`, `deepseek/deepseek-v4-pro` | Claude/OpenAI-compatible base URLs、Pi `openai-chat` 与 models URL不变。 |
| `deepseek` | `deepseek-flash(1048576,1,R=low|high|max→high)`、`deepseek-v4-pro(1048576,0,R=high|max→high)` | `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro` | Claude Anthropic endpoint；Codex/Pi `openai-chat`、models URL、Pi catalog `deepseek` 不变。 |
| `zhipu-glm-cn` / `zhipu-glm-global` | `glm-5.3-flash(1000000,1)`、`glm-5.3(1000000,0)`、`glm-5.2(?)`、`glm-5.1(?)` | 两区均 `glm-5.2`, `glm-5.1` | Claude Anthropic；Codex/Pi `openai-chat`；各自区域 base URL 不变。 |
| `moonshot-kimi-cn` / `moonshot-kimi-global` | `kimi-k3(1048576,1,R=low|high|max→max)`、`kimi-k2.7-code(262144,1)`、`kimi-k2.7-code-highspeed(262144,1)`、`kimi-k2.6(262144,1)` | `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`，以及 Pi 旧专属 `kimi-k2-0711-preview`, `kimi-k2-0905-preview`, `kimi-k2-thinking`, `kimi-k2-thinking-turbo`, `kimi-k2-turbo-preview`, `kimi-k2.5` | Claude/Kimi Anthropic endpoints；Codex/Pi `openai-chat`、区域 models URL、Pi catalog 不变。 |
| `moonshot-kimi-code` | `kimi-for-coding(1048576,1,R=low|high|max→max)`、`kimi-for-coding-highspeed(262144,1)`、`k3(262144,1,R=low|high|max→high)` | `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k`（Pi 旧清单） | Claude/Codex endpoints、Codex `openai-chat`、Pi `anthropic-messages` 与 `kimi-coding` catalog 不变。 |
| `minimax-cn` / `minimax-global` | `MiniMax-M3(1000000,1)`；`MiniMax-M2.7`, `M2.7-highspeed`, `M2.5`, `M2.5-highspeed`, `M2.1`, `M2.1-highspeed`, `M2` 均 `(204800,0)` | `MiniMax-M3`, `MiniMax-M2.5`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`（按 runtime 实际列表） | Claude/Codex base URL；Pi `anthropic-messages` 与区域 Pi catalog 不变。 |
| `aliyun-bailian-coding` | `qwen3.7-plus(983616,1)`, `qwen3.6-plus(983616,1)`, `kimi-k2.5(229376,1)`, `glm-5(169984,0)`, `MiniMax-M2.5(196608,0)`, `qwen3-coder-next(204800,0)`, `qwen3-coder-plus(997952,0)` | `qwen3.7-plus`, `qwen3-coder-next`, `qwen3-coder-plus` | Claude Anthropic、Codex/Pi `openai-chat`；Coding Plan base/model URL 保留。 |
| `aliyun-bailian-token-plan-cn` | `qwen3.8-max(983616,1,R=low|medium|xhigh→medium)`, `qwen3.8-flash(983616,1,R=low|medium|xhigh→medium)`, `qwen3.7-max(983616,0)`, `qwen3.7-plus(983616,1)`, `qwen3.6-flash(983616,1)`, `deepseek-v4.1-flash(1000000,1)`, `deepseek-v4-pro(1000000,0,R=high|max→high)`, `glm-5.3(1048576,0)`, `glm-5.2(1048576,0,R=high|max→high)` | `qwen3.8-max-preview`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `glm-5.2`, `deepseek-v4-pro`, 以及 Pi 旧 `MiniMax-M2.5`, `deepseek-v3.2`, `deepseek-v4-flash`, `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`, `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`, `qwen3.8-flash`, `qwen3.8-max` | Claude Anthropic、Codex/Pi `openai-chat`、Token Plan models URL 与 Pi catalog 保留。 |
| `aliyun-bailian-token-plan-team-cn` | `qwen3.8-max(983616,1,R=low|medium|xhigh→medium)`, `qwen3.8-flash(983616,1,R=low|medium|xhigh→medium)`, `qwen3.7-max(983616,0)`, `qwen3.7-plus(983616,1)`, `qwen3.6-plus(983616,1)`, `qwen3.6-flash(983616,1)`, `deepseek-v4.1-flash(1000000,1)`, `deepseek-v4-pro(1000000,0,R=high|max→high)`, `deepseek-v4-flash(1000000,0,R=high|max→high)`, `kimi-k2.7-code/k2.6/k2.5(229376,1)`, `glm-5.3/glm-5.2(1048576,0；5.2 R=high|max→high)`, `glm-5.1/glm-5(169984,0,R=high|max→high)`, `MiniMax-M2.5(196608,0)` | `qwen3.8-max-preview`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.2`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`, `glm-5.2`, `glm-5.1`, `glm-5`, `MiniMax-M2.5`, 以及 Pi 的 `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`, `qwen3.8-flash`, `qwen3.8-max` | Claude Anthropic、Codex/Pi `openai-chat`、Token Plan models URL 与 Pi catalog 保留。 |
| `google-gemini-api` | `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite` 均 `w1000000,img=?` | 同三型号从 Codex/Pi 旧 runtime 数组移出 | OpenAI-compatible endpoint、Codex/Pi `openai-chat` 与 models URL保留。 |
| `litellm` / `lmstudio` / `llamacpp` / `vllm` | 均 `models: []`，无新增事实 | 无 | 本地 endpoint、协议和 `baseUrlEditable` 不变。 |
| `longcat` | `LongCat-2.0(w1000000,img=?)` | `LongCat-2.0` | Claude/Codex endpoint 与 Pi `openai-chat` 保留。 |
| `zhipu-coding-plan-cn` / `zai-coding-plan-global` | `glm-5.3[1m](1000000,0,E=claude-code)`, `glm-5.3-flash[1m](1000000,1,E=claude-code)`, `glm-5.3(1000000,0,E=codex|pi,R=low|high|max→high)`, `glm-5.3-flash(1000000,1,E=codex|pi,R=low|high|max→high)` | CN 旧清单含 `glm-5.3[1m]`, `glm-5.2[1m]`, `glm-5.2`, `glm-5.1`；Global 同前但无 CN 专属 catalog 型号 | Claude Anthropic；Codex/Pi `openai-chat`；CN Codex discovery 与各自 Pi catalog 保留。 |
| `xiaomi-mimo-api-cn` | `mimo-v2.6-pro(1048576,1)`, `mimo-v2.6-flash(1048576,1)`, `mimo-v2.6-pro-ultraspeed(1048576,1)` | 三型号从 Claude/Codex/Pi 旧数组移出 | Claude endpoint；Codex/Pi `openai-chat`、Pi catalog `xiaomi` 不变。 |
| `xiaomi-mimo-token-plan-cn` | `mimo-v2.6-pro(1048576,1)`, `mimo-v2.6-flash(1048576,1)` | 两型号从三 runtime 旧数组移出 | Token Plan endpoints、Codex/Pi `openai-chat`、Pi catalog 不变。 |
| `volcengine-agent-plan` / `volcengine-coding-plan` | `ark-code-latest(w=?,img=?)` | `ark-code-latest` | 各 Agent/Coding Plan base URL 与 Codex/Pi `openai-chat` 保留。 |
| `tencentcloud-coding-plan` | `tc-code-latest`, `glm-5`（窗口/图片均 `?`） | `tc-code-latest`, `glm-5` | Claude Anthropic；Codex/Pi `openai-chat`；官方页面明确 Coding Plan 暂不支持多模态，因此不写图片 `true`。 |
| `opencode-go` | `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`（E=claude-code|pi，Pi Anthropic route）；`grok-4.5`, `glm-5.2`, `glm-5.1`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`, `hy3`（E=codex|pi）；`mimo-v2.6-pro/flash(1048576,1,E=codex|pi)` | Codex/Pi 旧列表中的 `mimo-v2.5`, `mimo-v2.5-pro` 被 V2.6 替换；其余旧 IDs 从 runtime 数组移到顶层 | Go base/model URLs、Codex/Pi `openai-chat`，以及 MiniMax/Qwen 的 Pi Anthropic route override 保留。页面写明列表可能变化，不作历史生效承诺。 |
| `vercel-ai-gateway` | `anthropic/claude-sonnet-4.6`, `openai/gpt-5.4`, `xai/grok-4.5`（窗口/图片 `?`） | 三型号从三 runtime 旧数组移出 | Gateway base/model URLs、Pi `openai-chat` 保留；不把 Vercel 清单当厂商价格或可用性证明。 |

上述 `w/img/R` 是本地 tag snapshot 的字段清单，不是“线上服务端推荐清单”或外部同步结果。2026-10-04 匿名 GET 的可追溯结果如下；HTTP 200 只证明页面可访问和当日页面内容，不能把当日页面倒推成 `2026-09-26` 历史事实：

| 标号 | 官方一级 URL | 观察结果（2026-10-04） |
| --- | --- | --- |
| P1 | https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration | HTTP 200；页面为动态当前内容，未提供本 tag 每个型号窗口/图片历史证据。 |
| P2 | https://api-docs.deepseek.com/guides/anthropic_api | HTTP 200；明确 Claude 名称映射到 `deepseek-v4-pro` / `deepseek-flash`；未给出本目录全部窗口历史。 |
| P3 | https://docs.bigmodel.cn/cn/guide/develop/claude；https://docs.z.ai/devpack/tool/claude | 均 HTTP 200；确认 GLM-5.3/Flash 文档入口；精确窗口与本 tag 历史未由页面回溯。 |
| P4 | https://platform.moonshot.cn/docs/guide/agent-support；https://platform.moonshot.ai/docs/guide/agent-support；https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents | 均 HTTP 200（有跳转）；确认 Kimi K3/K2.7/K2.6/Kimi Code 型号名称；K2.8 历史起点与套餐窗口仍未知。 |
| P5 | https://platform.minimaxi.com/docs/api-reference/responses-create；https://platform.minimax.io/docs/api-reference/responses-create | 均 HTTP 200；当前示例显示更新中的 MiniMax 型号，不能证明 tag 中 M2.* 窗口的历史生效日。 |
| P6 | https://help.aliyun.com/zh/model-studio/coding-plan；https://help.aliyun.com/zh/model-studio/token-plan-personal-overview；https://help.aliyun.com/zh/model-studio/token-plan-team-overview | 均 HTTP 200；Coding Plan 页面明确 Qwen 3.7/3.6、Kimi K2.5、GLM-5、MiniMax M2.5 及图片理解；Token Plan 页面明确 Qwen3.8/DeepSeek 型号和 preview 下线替代；精确窗口仍按 tag snapshot，未以观察日作生效日。 |
| P7 | https://ai.google.dev/gemini-api/docs/openai；https://ai.google.dev/gemini-api/docs/pricing | HTTP 200；OpenAI-compatible endpoint 与价格页可访问，价格日期只采用 pricing 页明确的 `2027-01-01` 段。 |
| P8 | https://longcat.chat/platform/docs/zh/；https://docs.volcengine.com/docs/82379/2373738；https://www.volcengine.com/docs/82379/1925114 | 均 HTTP 200；页面确认产品入口/型号或套餐路由，未提供本目录精确窗口/图片历史。 |
| P9 | https://docs.bigmodel.cn/cn/coding-plan/quick-start；https://docs.z.ai/devpack/overview | 均 HTTP 200；确认 coding-plan 文档入口和 GLM-5.3/Flash 线索，精确字段按 tag snapshot；未知不补造。 |
| P10 | https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call | HTTP 200；确认 MiMo API 示例与 `mimo-v2.6-pro`，未给出本目录全部窗口历史。 |
| P11 | https://cloud.tencent.com/document/product/1823/130092 | HTTP 200；列出 `tc-code-latest`、`glm-5`，并明确 Coding Plan 暂不支持多模态；故代码不新增图片能力。 |
| P12 | https://opencode.ai/docs/go/；https://vercel.com/docs/ai-gateway/coding-agents | 均 HTTP 200；OpenCode 页面明确推荐列表可能变化，Vercel 页面为动态 Gateway 文档；不把页面当前列表同步成 Lex 事实。 |

未能从以上页面精确核实的窗口、图片、effort、下线历史和区域路由都保持 `?` 或沿用既有 source snapshot，未新增价格/effectiveFrom；若后续需要把这些 tag 字段升级为当前事实，必须重新取得对应一级材料并单独变更。

## 本轮来源 subset、作者与可追溯完整消息

本地 C2 综合提交由真实本地提交者 Poker authored/committed；这不伪称保留了每个上游 source commit 的 Git Author/AuthorDate。三个 C1 机制来源的完整 `%B`、signoff/coauthor 原文继续由 C1 台账保存，下面给出精确 SHA、作者/日期、subset 映射和可追溯 heading：

| PR | source SHA | 原作者 / AuthorDate | 本地承接 subset | 完整原文位置 |
| --- | --- | --- | --- | --- |
| #5063 | `061568865f85dce7e075644f69588633cdb93f76` | Chris Zhang `<chrisz83@gmail.com>` / `2026-09-25T04:51:19+09:00` | sparse import metadata、generation/capability inheritance、native model identity、Pi Fast preference 与同连接 scope；机制沿用 C1，C2 只引用模型/route/preset 消费边界。 | [C1 台账 #5063](c1-model-catalog-source-ledger.md#061568865f85dce7e075644f69588633cdb93f76)；保留完整上游 `%B`、`Signed-off-by: zqchris`。 |
| #5119 | `4c8c031c47b9b988bb6eea3a7a78c6ff6f16df45` | Dash `<125997726+dashhuang@users.noreply.github.com>` / `2026-09-27T03:17:30+13:00` | XD 独立 entry、旧 route 解析与 alias/override 兼容、顶层 preset models、engines/engineOverrides、DeepSeek route alias、Codex 图片桥接边界；本轮 providers 语义 diff 见上表。 | [C1 台账 #5119](c1-model-catalog-source-ledger.md#4c8c031c47b9b988bb6eea3a7a78c6ff6f16df45)；保留完整上游 `%B` 与所有 source signoff。 |
| #5145 | `4a2bed4edb84e5a18bfabbf4e8ca2ee6f53b75f2` | Dash `<125997726+dashhuang@users.noreply.github.com>` / `2026-09-27T20:40:12+13:00` | 账号实际成员/排序、Claude supported-model discovery 与 stale snapshot 规则；C2 不重复搬 auth 生命周期，只核对 registry route 与旧选择显示。 | [C1 台账 #5145](c1-model-catalog-source-ledger.md#4a2bed4edb84e5a18bfabbf4e8ca2ee6f53b75f2)；保留完整上游 `%B`、source signoff/coauthor。 |

`#5039/#5050/#5060` 的完整 `%B` 已在本文件下方直接由 Git object 写入；`#5063/#5119/#5145` 以上述 C1 原文链接作为完整消息唯一来源，避免复制时丢失 signoff/coauthor。提交正文必须继续使用真实 Poker DCO，并列出这些真实 source SHA；不添加伪造的上游作者签名。

## 未知项与外部边界

- 未由官方一级材料确认的 numeric price、effective date、region multiplier、模型路由或上下文窗口保持缺省/未知，不用全球价补齐 US/未知区域。
- 参考价不进入 Gateway receipt/actual usage billing；真实 OAuth/Build 路径是否可用仍由运行时授权与端点合同决定。
- 本地包装大小来自记录时的公开 tag/manifest 观察，标签可变；不宣称权重 digest、自动下载、自动安装或推理通过。
- C2 未执行 Pi 在线同步、模型下载、账号请求、外部发布或部署；DCO/提交身份由真实 Poker 提交时检查。

## 完整上游 %B（由 Git object 读取）

下列正文分别直接来自 git show -s --format=%B <SHA>。生成阶段使用明确的字符串 join('\n')，以 UTF-8 写入；提交前会检查本文件和 commit message 不含 PowerShell 对象数组占位文本。Author/AuthorDate、Committer/CommitDate 与 signoff/coauthor 按 Git object 原样保留。

### 235c3953e3afb60447a29a692d5a3b23e28bcd53

- source SHA: 235c3953e3afb60447a29a692d5a3b23e28bcd53
- Author: Dash <125997726+dashhuang@users.noreply.github.com>
- AuthorDate: 2026-09-25T02:18:18+12:00
- Committer: GitHub <noreply@github.com>
- CommitDate: 2026-09-24T22:18:18+08:00

~~~text
feat(models): 补齐大内存本地候选并更新推荐证据 (#5039)

* feat(models): 补齐大内存本地候选并更新推荐证据

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(models): 补齐 NVFP4 与 Q4 包装格式标记

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

---------

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>
~~~

### d6cd6f3d11dc5906dd896936349fa2150ebdb508

- source SHA: d6cd6f3d11dc5906dd896936349fa2150ebdb508
- Author: Chris Zhang <chrisz83@gmail.com>
- AuthorDate: 2026-09-25T03:31:03+09:00
- Committer: GitHub <noreply@github.com>
- CommitDate: 2026-09-25T02:31:03+08:00

~~~text
feat(providers): 完善 Sub2API 接入与新模型代际继承 (#5050)

* fix(providers): complete Sub2API discovery and runtime capabilities

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* feat(providers): inherit defaults for new model generations

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(providers): normalize endpoint slashes in linear time

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(providers): reject connection capacity in registry metadata

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(providers): preserve working windows across discovery and Pi launch

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* docs(models): align generation inheritance contract with approved behavior

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(models): preserve inherited window provenance

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(models): exclude mode from generation inheritance

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(pi): preserve durable Fast preferences and hide control paths

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(models): use max-only windows and exact relay adapters

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(models): preserve exact metadata and discard stale inherited capacity

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(models): clear inherited image input on explicit denial

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

* fix(models): honor reduced capacity and current resume Fast capabilities

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>

---------

Signed-off-by: Chris <4436110+zqchris@users.noreply.github.com>
Co-authored-by: Chris <4436110+zqchris@users.noreply.github.com>
~~~

### 2770145bab0407fe0a59ffb10e88766ff0bc84e8

- source SHA: 2770145bab0407fe0a59ffb10e88766ff0bc84e8
- Author: Chris Zhang <chrisz83@gmail.com>
- AuthorDate: 2026-09-25T02:17:59+09:00
- Committer: GitHub <noreply@github.com>
- CommitDate: 2026-09-25T01:17:59+08:00

~~~text
fix(models): 同步 xAI 真实资料并接通 Grok 4.7 Fast (#5060)

* fix(models): sync xAI metadata and route Grok 4.7 Fast across harnesses

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): clear xAI Fast tier when target is unavailable

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): preserve cache prices during sparse xAI sync

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): keep sparse xAI tariffs stable across JSON sync

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): retain bundled Fast visibility with older catalogs

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): price xAI fallback usage by actual execution

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): reject xAI Fast flags without an execution mapping

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): negotiate uncompressed xAI usage responses

Signed-off-by: zqchris <chrisz83@gmail.com>

---------

Signed-off-by: zqchris <chrisz83@gmail.com>
~~~
