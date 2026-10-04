# C1 model-catalog source ledger

状态：来源与门禁证据台账；不单独宣称 C1 验收通过。

## 本地候选边界

- 主候选：6e7f01b37dba1c84f818df86e4c86a82fc5875bf，组合 #5063/#5119 必要账号排序与 default 消费/#5145 账号成员权威和主动发现。
- 预设候选：87ce800716ef36f597656643f8625717f1f35830，仅包含 #5119 剩余共享 models 清单、expander、类型与 parser 消费；它是最终树的 preset 增量。
- 当前分支 lex/cindy-v0.1.96-selective-integration 相对 origin/main 为 39 个提交；当前 HEAD 为 87ce800716ef36f597656643f8625717f1f35830，工作树干净。
- 既有主候选提交正文保留了来源 SHA/作者/日期与组合理由，但其生成时把完整嵌入消息写成了对象数组占位文本；本台账补上真实完整 %B，不伪称原提交正文已修复，也不改写历史。

## 根门禁证据

旧 detached runner 的失败记录必须保留为失败事实，不能由局部成功推导整体成功：

- F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/C1-lead-detached-20261003-231822.meta.log：tree fe77924663911641ab8588b07ce403be38f61507，pnpm 10.33.2 test:unit:related，2026-10-03T15:18:24.0509941Z–2026-10-03T15:42:00.9009256Z，exit=1。

6e7 主候选精确树的根门禁已经单独运行：

- meta：F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/C1-6e7f01b-root-unit-related-20261004.meta.log
- stdout：F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/C1-6e7f01b-root-unit-related-20261004.stdout.log
- 命令：pnpm test:unit:related（pnpm 10.33.2）；tree 6e7f01b37dba1c84f818df86e4c86a82fc5875bf；2026-10-03T16:58:39.4126729Z–2026-10-03T17:21:35.1696402Z；exit=0。该树不含 preset 候选，证明主候选自身的根门禁。

87ce 最终树（含 preset 消费修复）的根门禁也已单独运行：

- meta：F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/C1-87ce8007-root-unit-related-20261004.meta.log
- stdout：F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/C1-87ce8007-root-unit-related-20261004.stdout.log
- 命令：pnpm test:unit:related（pnpm 10.33.2）；tree 87ce800716ef36f597656643f8625717f1f35830；2026-10-03T17:22:20.8082410Z–2026-10-03T17:45:06.1431547Z；exit=0。stdout 的 model-providers command 明确包含 src/__tests__/presetModels.test.ts 与 src/presetModels.ts。

上面两次精确树根门禁都独立于先前 partial workspace 输出；6e7 的成功不能替代 87ce，87ce 的成功也不能改写旧失败事实。

## 受影响包与门禁补证

以下均以最终 tree 87ce800716ef36f597656643f8625717f1f35830 运行，meta/stdout 同前缀 F:/Projects/lex/ci-logs/cindy-v0196-integration-66b7a5cb-20261002/：

- C1-87ce8007-model-providers-build-20261004.{meta,stdout}.log：pnpm --filter @cindy/model-providers run build，exit=0。
- C1-87ce8007-maker-core-build-20261004.{meta,stdout}.log：pnpm --filter @cindy/maker-core run build，exit=0。
- C1-87ce8007-desktop-typecheck-20261004.{meta,stdout}.log：pnpm --filter desktop typecheck，exit=0。
- C1-87ce8007-tools-pi-typecheck-20261004.{meta,stdout}.log：两个 node --check 与 catalog-format.d.mts 的 bundler tsc --noEmit，exit=0。
- C1-87ce8007-i18n-20261004.{meta,stdout}.log：pnpm check:i18n，exit=0；有既有 warning 但五语言 key 一致。
- C1-87ce8007-glossary-20261004.{meta,stdout}.log：pnpm check:i18n-glossary，exit=0；18 个 proposed harness/lead 告警按脚本契约不阻断。
- C1-87ce8007-design-inventory-20261004.{meta,stdout}.log：pnpm check:design-inventory，exit=0。
- C1-87ce8007-diff-check-20261004.{meta,stdout}.log：git diff --check origin/main..HEAD，exit=0。
- C1-87ce8007-dco-20261004.{meta,stdout}.log：pnpm check:dco，exit=0，39 commits signed off。

meta 文件使用明确的字符串数组与 String.Join(([char]10), $lines) 写成 UTF-8；没有 PowerShell 数组字符串化，所有相关 meta/stdout 与本台账均核对不含对象数组占位文本。

## source → hunk 映射

### #5063 — 061568865f85dce7e075644f69588633cdb93f76

保留到主候选 6e7f01b37 的机制 hunk：

- packages/model-providers/src/modelDiscovery.ts：兼容稀疏模型字段与 native metadata；tools/pi/catalog-format.{mjs,d.mts}、tools/pi/sync-model-catalog.mjs：Pi catalog metadata、partial source 与原子保留。
- packages/model-providers/src/modelMetadataLayers.ts、providerModelCatalog.ts、piNativeCatalog.ts、user-provider.ts、types.ts：generation/capability inheritance、context-window provenance、adapter/native projection、runtime metadata persistence。
- apps/desktop/src/main/provider-import/providerImport.ts、apps/desktop/src/shared/piRuntimeInitialization.ts、renderer custom-provider fill/save：导入验证、跨 runtime effort adaptation、metadata round-trip。
- apps/desktop/src/main/maker-host/pi-provider-transport.ts、pi-gateway-model-catalog.ts、codex-proxy-host.ts 与对应 tests：已有 transport 的协议/能力边界。

排除/改写：不把上游与 Lex auth/账号生命周期不相容的架构直接搬入；价格仍复用 route-scoped pricing/no-cost 合同。

### #5119 — 4c8c031c47b9b988bb6eea3a7a78c6ff6f16df45

保留到主候选 6e7f01b37 的必要运行机制：

- apps/desktop/src/main/maker-host/active-catalog.ts 与 modelPlane.test.ts：账号返回位置覆盖 Registry/用户排序，连续 sortOrder 及 defaultEnabled 消费；不让 Registry 凭空创造账号成员。
- apps/desktop/src/renderer/components/settings/AddProviderWizard.tsx、renderer/lib/customProviders.ts、customProviderRuntimeFill.ts、shared/piRuntimeInitialization.ts：选择只保存显式用户关闭，原生/兼容 runtime 默认策略和 portable metadata。
- packages/model-providers/src/catalog.ts：OMP agent kind 接线；相关 model-provider tests 保留。

明确排除到独立 preset 候选 87ce80071 的格式 hunk：packages/model-providers/src/presetModels.ts、presetModels.test.ts、ProviderPresetModel/ProviderPreset.models 类型、catalog.ts 的 expandPresetModels/sanitizePresets 消费、index.ts exports。该拆分树不把 preset 格式假设混入主候选。

### #5145 — 4a2bed4edb84e5a18bfabbf4e8ca2ee6f53b75f2

保留到主候选 6e7f01b37 的成员权威与生命周期 hunk：

- apps/desktop/src/main/maker-host/active-catalog.ts、modelPlanePolicy.ts：只投影真实账号成员，canonical parent/consumer addition 门控，保留 user overrides/selected models。
- apps/desktop/src/main/maker-host/model-discovery/anthropic.ts、新增 model-discovery-pages.ts、bootstrap-electron.ts、createDesktopProviderService.ts、index.ts、generic-oauth.ts：主动 supportedModels probe、generation/auth lifecycle、safe pagination/partial LKG。
- 对应 discovery/provider IPC/fetch 与 tests：maker-ipc/{providerHandlers.ts,register.ts}、provider-model-fetch.ts、providerImport.ts、activeCatalogDiscovery.test.ts、anthropicModelDiscovery.test.ts、providerHandlers.test.ts 等。

不引入上游未授权的 nativeCliAuth/shared-login 架构；保留 Lex 的原生桥接、Pi 路由存在性、成功空快照撤回与 failed/no-snapshot LKG 区分。

## 完整上游 %B 文本

以下文本直接由对应 Git object 的 git show -s --format=%B <SHA> 提取；signoff/coauthor 原样保留。

### 061568865f85dce7e075644f69588633cdb93f76

~~~text
fix(models): 补全模型导入同步并按原生协议启用新型号 (#5063)

* fix(models): preserve import metadata and enable new native models

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): preserve inherited window provenance and isolate model sizes

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): preserve sparse sync data and authoritative snapshots

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(pi): hide Fast preference paths from shell environments

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): scope sync metadata retention to the same connection

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): preserve failed catalogs and accept sparse native models

Signed-off-by: zqchris <chrisz83@gmail.com>

* test(models): align refresh and native defaults with import behavior

Signed-off-by: zqchris <chrisz83@gmail.com>

* test(models): align gateway defaults and await durable runner state

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): reconcile refreshed windows and preserve server native identity

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(pi): read Fast preferences from host memory over RPC

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): retain generation adapters and filter imported efforts

Signed-off-by: zqchris <chrisz83@gmail.com>

* fix(models): adapt reasoning metadata when filling runtimes

Signed-off-by: zqchris <chrisz83@gmail.com>

* docs(models): align Fast runtime guidance with host RPC

Signed-off-by: zqchris <chrisz83@gmail.com>

---------

Signed-off-by: zqchris <chrisz83@gmail.com>
~~~

### 4c8c031c47b9b988bb6eea3a7a78c6ff6f16df45

~~~text
feat(models): 订阅模型顺序以账号为准，默认显示由目录决定，预设改为一份推荐清单 (#5119)

* feat(models): 订阅模型顺序以账号返回为准，目录兜底

- OpenAI（含独立 ChatGPT 账号）与 Anthropic 订阅有账号清单时按账号顺序排，
  仅目录有的模型接在其后；装配时重写连续 sortOrder，选择器、新对话默认、
  bridge 与 Pi 共用同一顺序，用户本地 sortOrder patch 仍最高
- Codex 发现直接用 priority / app-server 返回位置，移除目录排序锚点插值
- 设置页组内每项都有 sortOrder 时与选择器同序，否则保持名称/版本排序
- 文档补充「模型排序：账号优先，目录兜底」

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* feat(models): 默认显示只由目录决定，订阅默认只留最新一代

- 移除客户端写死的隐藏例外（gpt-5.4-mini、Haiku、bridge gpt-5.4/5.4-mini），
  未在目录标 defaultEnabled:false 的型号一律默认显示，新型号一定可见
- 目录：GPT 订阅只默认显示 GPT-6 Sol/Luna/Astra；Claude 订阅显示各系列最新版
  （Opus 5.5、Fable 5.1、Sonnet 5、Haiku 4.5、Mythos 5）
- Opus 5 / Fable 5 的 XD 路由拆为独立 xd/* 条目，XD 默认显示不变
- 文档补充默认可见性规则与目录变更记录

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* refactor(models): XD 路由一律使用独立条目

- 其余 11 个与订阅/其他供应商共用的条目拆出 xd/* 条目，沿用改动前的显示设置
  （Opus 4.8 在 XD 上恢复默认显示）；50 条 XD 路由解析资料拆分前后一致
- 新增校验：离线 Registry 不得出现 XD 与其他供应商混用的条目
- 文档写明 XD 条目独立维护的规则

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* style(models): 格式化 XD 条目校验测试

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* feat(models): 第三方连接刷新时新型号排在已有型号之前

mergeDiscoveredRuntimeModels 把新发现的型号放到已有型号前（保持接口返回的相对
顺序），已有型号位置不动；首次添加仍按接口返回顺序。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* refactor(presets): 第三方预设改为一份推荐清单，参数按官方资料校正

- 预设顶层只写一份 models（数组顺序即推荐顺序），runtimes 只放连接信息；
  加载时 expandPresetModels 展开回各引擎清单，服务端旧格式照常可用
- 协议限制用 engines 表达，Pi 推理档位/路由等写 engineOverrides.pi
- Pi 独有的型号不进推荐清单（Pi 仍从模型资料补入、默认隐藏）
- Kimi、MiniMax、MiMo、百炼 Qwen/DeepSeek/GLM/Kimi 的名称、窗口、图片输入按官方文档校正
- Claude Code / Codex 展开后的成员、顺序与连接设置与改动前一致；新增结构校验测试

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): 按官方资料处理下线与别名型号，并与服务端推荐清单对齐

- 百炼 Token Plan 用 qwen3.8-max 替换已下线的 preview，按官方清单补新型号，团队版去掉
  10-10 下架的 DeepSeek-V3.2；Coding Plan 改为官方推荐清单；窗口取官方最大输入
- GLM Coding Plan 只推荐官方支持的 glm-5.3 / glm-5.3-flash（Claude Code 用 [1m]）
- DeepSeek 改用官方推荐的 deepseek-flash；OpenCode Go 的 MiMo V2.5 换成 V2.6 并补兼容配置
- 推荐清单以线上服务端为基础对齐（删去 OpenRouter 上不存在的 qwen/qwen3.8-max）
- Codex 桥接图片白名单补上官方确认支持图片的 Kimi 与 Qwen 型号
- 客户端 Registry revision 2026-09-26T12:00:00.001Z（与服务端内容不同，见变更记录）

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* docs(models): 更新预设与服务端同步关系说明

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(models): OpenAI 订阅 Pi 与 Codex 共用账号顺序和默认显示

Pi 清单成员与能力仍来自 Pi 目录，但按账号顺序排列，并沿用 Registry 条目的
defaultEnabled:false，避免 GPT-5.6 等旧型号在 Pi 中仍默认显示。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): Codex 走 Chat 桥接时只声明已验证的图片输入

共用推荐清单把 supportsImageInput 带进了 Codex runtime，而 openai-chat 桥接只对
已验证的官方路由转发图片（DeepSeek、MiMo、GLM Flash、百炼上的 Kimi 等未验证），
会导致带图请求被拒。这些型号在 Codex 下显式标 supportsImageInput:false，
并新增测试锁定预设与桥接能力一致。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): engines/engineOverrides 畸形时拒绝整条预设

展开前校验引擎限定字段；畸形时不展开，交给 sanitizePresets 整条拒绝，
避免静默丢掉限定、把部分引擎专属模型暴露给全部引擎。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(models): DeepSeek 直连 Registry 补 deepseek-flash 路由

与服务端 xindong/cindy-server#780 同步：deepseek/deepseek-v4-flash 条目新增 deepseek-flash
路由，保留旧别名路由供已有连接解析参考价。离线 revision → 2026-09-26T12:00:00.003Z。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* docs(models): 更新目录变更记录的 revision

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): 预设引擎名拼错时拒绝整条预设

engines 须为非空的已知引擎名，engineOverrides 的键只能是已知引擎；
否则模型会从全部引擎消失或专属覆盖被静默忽略。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(models): DeepSeek Flash 以 deepseek-flash 为首条路由

旧 deepseek-v4-flash 路由保留在后，只供已有连接解析参考价；
Registry revision 递增到 2026-09-26T12:00:00.004Z，与服务端同步。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): 引擎字段畸形时不论格式都拒绝整条预设

展开被拒（顶层 models 仍在）即淘汰，runtimes 另带旧清单也不能覆盖随包版本；
更正注释：providers.json 是源格式，旧 OSS cfg/providers.json 已冻结、不由它发布。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(models): DeepSeek Flash 路由不再在路由级声明图片输入

路由默认值会作用到 Codex 的 Chat 桥接；图片能力按预设各引擎声明。
新增测试锁定第三方直连路由不声明图片输入；revision 递增到
2026-09-26T12:00:00.005Z，与服务端同步。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): 预设模型的 engines 须命中已声明的引擎

否则模型会从全部引擎被静默抹掉、整条预设仍以同 id 覆盖随包版本；
与服务端 generateCatalog 同口径。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

* fix(presets): engines 与 engineOverrides 只能指向已声明的引擎

未声明引擎的覆盖会被静默忽略、共享能力留在其它引擎；与服务端同口径。

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>

---------

Signed-off-by: Dash <125997726+dashhuang@users.noreply.github.com>
~~~

### 4a2bed4edb84e5a18bfabbf4e8ca2ee6f53b75f2

~~~text
fix(models): 订阅模型清单只显示供应商实际返回的型号 (#5145)

* fix(models): 订阅模型清单只显示供应商实际返回的型号

- OpenAI / Anthropic 订阅根的成员只来自账号清单，Registry 只给已返回的型号补资料、
  标退役，不再补入账号没返回的型号；OpenAI [1m] 消费端变体只跟随已返回的上游型号出现。
- xAI 有非空账号快照时同样只用快照；无快照或空快照仍走静态声明兼容路径。
- Claude SDK 以简称（default / opus / sonnet …）返回的当前型号按说明里的版本解析为
  claude-<系列>-<主>-<次>，目录未登记的新版本也照样显示，不映射到相邻旧版本。
- SDK displayName 只有系列名（如 "Fable"）时不作为型号名称，改用目录名称或按 id 推导
  （claude-fable-5-1 → "Fable 5.1"），并修正旧缓存里的系列名。
- 新增 Claude 模型清单主动读取：maker 就绪、登录 / 认领后与手动刷新时，用本机 CLI 起
  空闲 Query 只读 supportedModels，不发送消息。
- 同步模型成员规则文档，并按新合同改写相关测试。

Signed-off-by: Dash <dash@DashdeMac-Studio.local>

* fix(models): 收紧 Claude 模型清单探测与名称判定

- displayName 只有写出与模型 ID 相同的版本号才作为名称，"Opus (1M context)" 这类
  上下文长度不再被当成版本；旧缓存恢复按同一判据修正。
- 主动探测的结果只交给发起方回调，按发起时的授权世代写入：探测期间登出 / 换号时，
  旧账号的迟到清单不进入列表与磁盘缓存；同一世代内的并发请求复用在途探测。
- 探测在新建的空临时目录启动并照常执行项目设置检查，结束后删除该目录；登录态读取、
  环境构建与 Query 创建阶段的失败也返回 false 而不是抛错。

Signed-off-by: Dash <dash@DashdeMac-Studio.local>

* fix(models): 首次认领且无缓存时等待 Claude 清单读取完成

waitForDiscovery 的调用方（Orca 路由、定时任务解析）在首次认领 Claude 登录后需要
拿到认领后的目录快照。目录不再补 Anthropic 型号，没有磁盘缓存时必须等主动读取
完成才能返回；已有缓存时仍在后台刷新。

Signed-off-by: Dash <dash@DashdeMac-Studio.local>

* fix(models): Claude 清单探测跟随登录绑定与 maker 生命周期

- 通过 Cindy 登录 Claude 时，CLI 登录态监听先于绑定触发，那次探测会因未绑定而
  跳过；写入绑定后再请求一次。
- resetMaker 注销探测回调；探测被注销或替换后，旧 maker 的在途结果不再写入，
  新探测也不复用旧的在途探测。

Signed-off-by: Dash <dash@DashdeMac-Studio.local>

* fix(models): Claude 直接换号时作废旧账号清单与在途探测

在终端里从账号 A 直接切到 B（不经登出）时，CLI 登录态仍为已登录，原先不会清空
Anthropic 清单。现在登录邮箱变化即按换号处理：先清空旧账号的清单、缓存并让授权
世代自增（作废在途探测），再为新账号读取。

Signed-off-by: Dash <dash@DashdeMac-Studio.local>

---------

Signed-off-by: Dash <dash@DashdeMac-Studio.local>
Co-authored-by: Dash <dash@DashdeMac-Studio.local>
~~~
