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
| #5060 Grok 4.7 Fast | xAI 官方 pricing（https://docs.x.ai/developers/pricing.md），匿名 GET，HTTP 200，观察记录见 primary checks（../cindy-v0.1.96-primary-source-checks.md） | Grok 4.7 500K 窗口；standard global <200K 与 >=200K 参考价；Fast 作为单独身份，global 参考价 4/12/1 与 6/18/1.5，沿用 tag 的 effectiveFrom=2026-09-24，观察日记为 2026-10-02；仅 OAuth/Build 目标允许映射。 | Fast 不在公共 xAI API；Cursor/Grok Build 由计划计费；US us.api.x.ai 的 1.1x 与任何未知区域价不套 global；页面叙述的 200K 边界歧义未另造新阈值。 |
| #5119 推荐预设 | Kimi K3 官方 pricing/quickstart（https://platform.kimi.ai/docs/pricing/chat-k3.md）、Google Gemini pricing（https://ai.google.dev/gemini-api/docs/pricing）、Meta pricing/rate limits（https://dev.meta.ai/docs/pricing-rate-limits）；tag 内完整推荐清单与实际 diff | 共享顶层 models 只展开声明的 claude-code/codex/pi/omp；旧 runtime URL、协议、discovery、Pi catalog 保留；engine override 与 Codex 图片桥接边界保留。Gemini 3.8 只保留官方页明确的 2027-01-01 Standard 价格段。Kimi K2.8 的 tag 窗口/图片/effort 字段随身份保留，默认按 Lex 通用 high 收口。 | Meta 页面本次只确认 Muse 名称/tiers，详细 numeric rates 的后续请求 TLS 失败，故 Muse 1.2/1.3 不写数值；Kimi K2.8 未新增 numeric price 或历史生效日期；Kimi K3 的历史 cutoff/新 cache-write 生效日不由当前页反推。 |
| #5050/#5063/#5145 | 原始 Git 对象完整消息与实际 tag diff；C1 机制实现已在基线历史 | 保留已授权 Sub2API/sparse metadata、XD identity、账号成员权威与 discovery 机制；C2 只带数据/route/preset 边界需要的 hunk，沿用既有 auth/route 合同。 | 不引入 native CLI 登录重写、凭空新增 Gateway 成员、把 Registry 参考价当真实 XD 计费。 |

## source → hunk → local target

目标为从 aad281ca 生成的同一 C2 原子变更集；本文件不预写未知的未来 commit SHA，完成报告记录真实 commit/tree。

- 235c3953e3 / #5039 → packages/model-providers/catalog/model-registry.json 的 localModels 增量（8 个逻辑候选、Flash-Next Q4、Laguna）、apps/desktop/src/shared/localModelRuntime.ts 的 nvfp4/Q4 识别与回归、docs/local-model-audit-2026-09-24.md 的事实/未知台账。
- d6cd6f3d11 / #5050 → 以基线已有的 Sub2API/sparse metadata 机制为依赖；tag diff 中只保留已授权 provider metadata/协议边界，不新增与 Lex auth 不相容的架构。
- 2770145bab / #5060 → packages/model-providers/catalog/model-registry.json 的 xai/grok-4.7-build-fast 独立 base/route/reference-price 与 packages/model-providers/catalog/providers.json 的 fastModelId，并由既有 public-API guard 维持公共 xAI 无 Fast。
- #5063/#5119/#5145 → C1 台账已有机制映射；本 C2 树只承接 tag 内 XD 拆分条目、DeepSeek route identity、共享 preset 推荐数据与旧/新 preset parse/expand 消费，详见对应测试与本台账未知项。
- 当前代码消费边界：expandPresetModels 结果在 sanitize/parse/builtin/Pi augmentation 处使用；runtime 缺 models 时不以旧空数组覆盖顶层声明；畸形 scope 整条拒绝且不变异输入。

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
