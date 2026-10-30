# 从本机 Cindy 导入任务

> 2026-10-30。状态：首版已实现。用户选择在「设置 → 任务导入」直接扫描本机 Cindy，并批量选择任务。分享文件导入保留为另一条已有路径。

## 结论

可以支持，且不依赖 Lex Server / Lex Admin。Lex 复用 Cindy 的任务、消息和分享格式，并新增只读来源适配器。Cindy、Codex、Claude Code 在同一导入页按来源切换，共用任务列表与批量勾选。

必须同时处理三层内容：产品任务与消息、引擎原生历史、附件及工作目录。消息可读与原任务可继续运行是两个不同的验收结果。

实现与自动化测试只使用合成数据；没有读取、复制或迁移本机真实 Cindy 账号、任务或凭证。尚未用真实 Cindy 安装数据做端到端验收。

兼容性按实际列与引擎能力探测，不以 Cindy 版本号推断。当前必须具备 sessions 的身份、归属、删除/归档、远程、清空边界与 Orca 角色字段，以及 messages 的任务归属、正文和时间字段；可选统计和消息元数据列缺失时使用空值。Orca lead 额外核验团队和 Worker 表。具体契约与合成 fixture 见 `main/cindy-import/source.ts` 及其测试。尚未宣称与某个外部 Cindy 发布版本完成实机兼容验收。

## 已核对的实现

以下路径均相对 `apps/desktop/src/`。

| 位置 | 现状与复用边界 |
| --- | --- |
| `renderer/components/settings/SessionImportSection.tsx` | 来源筛选为全部 / Codex / Claude Code / Cindy，共用项目分组、复选框、全选与导入按钮；保留分享文件向导。 |
| `renderer/components/settings/CindyImportPanel.tsx` | 页面内的 Cindy 来源选择、预检、缺失项确认与逐条结果；切换来源筛选不销毁导入状态。 |
| `main/localDb/ipc/session-import.ts` | 扫描与导入分离；扫描缓存按当前 DB 用户区分。新增 Cindy 时还需校验账号代次，阻止切换账号后的迟到结果。 |
| `main/session-share/xdtshareFormat.pure.ts` | `.cshare` 与旧 `.xdtshare` 共用 `XDTSHARE` 魔数；普通包与 Orca 协同包使用格式版本门禁，应用版本号只是描述信息。公开 Cindy 上游同样保留这些标识。 |
| `main/session-share/sessionShareExport.ts` | 收集白名单任务字段、清空边界之后的消息、原生转录和受管媒体；依赖当前 `getDbClient()`、应用目录及账号索引，不能直接用于外部 Cindy 数据根。 |
| `main/session-share/sessionShareImport.ts` | 已有格式检查、媒体入仓、引擎历史落位、冲突检查、失败补偿及最后的 `session.importShare` 原子事务。普通分享导入与本机独立复制的语义不同。 |
| `main/session-share/migrationNativeContext.ts`、`migrationTranscriptWriter.ts` | 已有复制原生历史时重新分配 Claude / Codex ID、重写元数据和流式转录的能力；应提取复用，不复制一套。 |
| `main/task-migration/` | 已有工作目录与大转录迁移基础设施；设备间交接的生命周期不能直接套在本机 Cindy 读取上。 |
| `main/localDb/modelDefaultsProfile.ts`、`main/appSessionState.ts` | 当前主库路径仍为 `<userData>/<dbFilePrefix>-<ownerId>.db`；部分旁路资料位于 `owners/<owner摘要>/`。不能把多账号架构文档中的未来 Profile Registry 当作已运行的目录布局。 |
| `main/maker-host/codex-thread-storage.ts`、`codex-thread-locations.ts` | Codex 多账号历史先按 thread-index 定位，不能只扫描默认 `codex-home`。 |
| `main/cindy-import/` | 新增来源发现、停机核验、WAL 快照只读、schema 探测、历史/附件/工作目录预检和逐条导入编排。 |
| `main/session-share/nativeSessionMetadata.pure.ts` | 只重映射已知的原生 SDK 身份字段；历史-only 导入会清除恢复身份。 |
| `main/localDb/schema.ts`、`drizzle/0118_cindy_session_import.sql` | 目标账号库记录来源根与源任务 ID，并与任务图在同一事务写入；已删除副本可以重新导入。 |

现有分享格式能为兼容导入提供基础，但这不等于所有未来 Cindy 数据库或任务类型都自动兼容。外部读取需按实际 schema、列与引擎能力探测，缺必要字段时明确提示。

## 首版行为与兼容边界

### 1. 来源发现与账号选择

- 「全部」包含已扫描的 Cindy 任务；切换来源/位置筛选保留勾选并显示隐藏选中数。Cindy 首次进入仅发现账号库，用户点击扫描后才读取所选账号；不自动扫描所有 Cindy 账号。
- 三个来源共用项目分组与任务行。Cindy 每批最多 100 条，已导入项禁选；全选达到上限后再次点击可取消勾选。更换 Cindy 账号或重新扫描清空旧 Cindy 勾选，不影响 Codex / Claude Code 勾选。
- 混合批量先展示 Cindy 预检，并告知同时选中的 Codex / Claude Code 数量；确认后执行导入，取消/账号失效时不继续执行尚未提交的其他来源。普通 Codex / Claude Code 导入仍走原有直接导入流程。
- 从系统应用数据根发现 Cindy 的已知正式目录；区分 Cindy、Cindy 中国大陆版与旧布局，排除 Lex 自身目录、开发沙箱和备份。不同应用目录不视为同一个账号来源。
- 自动发现失败时提供系统目录选择器；选中的是一个数据根，不能允许 Renderer 任意传入数据库或文件路径来读取。
- 先显示来源与账号库供用户选择，再读取所选库的任务；不默认把所有账号的任务混成一份列表。仅使用非敏感元数据，不解密登录资料。
- Main 持有来源描述和候选映射，Renderer 只传不透明的候选 ID。重新导入时复验来源文件身份、任务归属与目标账号代次。
- 候选至少显示标题、引擎、更新时间、项目归属、归档状态和来源。批量操作显示逐条结果，某一条失败不掩盖已经完成的条目。

### 2. 外部只读适配器

外部库由后台读取器打开，只暴露固定的任务、消息、协同关系和媒体引用查询。不得调用 Lex 的 `ensureReady` / migration / repair，不把 Cindy 数据根临时设成全局 `userData`，也不切换 Lex 的当前 DbClient。

SQLite 快照必须包含已提交的 WAL 数据；不能直接复制单个 `.db` 或用忽略 WAL 的方式打开正在运行的源库。只读连接也需核对 sidecar 行为，禁止为方便读取而 checkpoint 或改变源库 journal mode。无法获得一致快照时提示关闭 Cindy 后重试。

首版在扫描、预检和每项任务发布前核验 Cindy 已退出。数据库/WAL、转录、媒体、附件或工作目录源文件变化时中止并要求重新扫描，不会把不一致内容标为完整导入。进程检查只读取可执行文件名与锁定 PID，不读取命令行参数。

退休伙伴归属必须检查 `source = bot`、`bot_session_links`、`bot_profiles.canonical_session_id`、`bot_delegations.child_session_id` 四条关系；旧库缺表时通过 schema 探测生成固定查询。已删除、远程代理任务及不支持的引擎要有明确排除原因。Orca Worker 应随 lead 整体处理，不拆成独立普通任务。

2026-10-30 对照 Cindy 上游 HEAD [`e17f474`](https://github.com/makecindy/cindy/commit/e17f474) 的 `localDb/schema.ts`、`botProfileRuntime.ts`、`botGroupChatService.ts`、`botDelegationService.ts`：伙伴关联角色现有 canonical、history、delegation、group、channel、thread、routine。导入按整张 `bot_session_links` 的归属排除，不限制角色，也不因关联已归档而放行，因此新角色仍受保护；`source=desktop` 的伙伴委派子任务由 `bot_delegations.child_session_id` 排除。伙伴群消息与伙伴间私信在独立表中，不属于本次导入读取范围。普通 Orca 协同不属于退休伙伴；如团队混入伙伴归属 Worker，则拒绝该团队，不把隐藏消息带入。合成数据库测试覆盖上述角色、归档关联、直接读取拒绝与正常任务保留；这不是对真实 Cindy 安装数据的兼容验收。

### 3. 任务复制与原生历史

现有分享导出新增可注入的来源接口：默认实现仍读取当前 Lex，Cindy 实现使用选定的只读来源。复用包格式与导入事务，通过内部临时包交接，不要求用户手工导出。

| 引擎 | 需要带入的内容 |
| --- | --- |
| Claude Code | 当前 SDK ID、消息引用的 fork / rewind 链、对应 JSONL；复制到目标历史目录并重新分配原生 ID。 |
| Codex | 依据源账号 thread-index 找到 rollout 与 state 行，重写 thread ID 和关联引用；不能让 Lex 与 Cindy 继续写同一份原生历史。 |
| Pi | 从源任务及消息元数据定位 JSONL，复制到 Lex 并映射新路径；不保留指向 Cindy 的可写 session-file 地址。 |
| OMP | 当前分享实现仅支持产品消息历史，明确移除原生恢复信息；不能声称无损续接。 |

原生历史缺失时展示「仅导入对话记录」与具体原因，需用户明确选择才降级。确认只对当前预检有效；来源变化后重新扫描、预检必须重新确认缺失项。完整历史、部分历史、附件缺失分别报告；现有 `fidelity` 不代表所有外部文件都已搬运。

新任务采用 Lex 可用的模型与供应商配置，不复制源凭证、授权、设备身份、定时触发或执行状态。保留消息时间、清空与 rewind 语义、标题和归档状态。普通分享导入默认将任务设为 active，本机复制不能直接沿用而复活归档任务。

### 4. 附件与工作目录

- 受管图片、音视频、3D 文件通过现有媒体入仓和引用账本保存；源 URL 必须按源数据根解析，并核对所选任务的引用归属。不能只在 Lex 数据根找同名文件。
- 现有分享导出没有完整处理消息 `files[]` 中的普通文件附件。这一部分需要单独搬运和重写引用；不能因为媒体 URL 已恢复就宣称附件完整。
- 任意正文里的绝对路径不是复制授权。仅处理结构化附件或经校验的受管资源，拒绝越界路径、符号链接逃逸和隐式网络路径。
- 普通项目默认关联用户选定的现有项目目录，不复制整个仓库；提示任务副本独立，但对同一项目的文件修改仍然共享。
- Cindy 管理的非项目工作目录需在 Lex 建立新目录，复用已有迁移文件校验来复制所需产物；不能让新任务继续写 Cindy 的内部目录。目录中没有文件不代表没有消息，二者分别读取。
- 跨机器备份中的 Windows / macOS 绝对路径不可直接当成本机路径，需要重新选目录；初版可将此类条目标为需要处理。

### 5. 去重、回滚与多账号

持久去重键由来源数据根、账号库文件名的摘要与源任务 ID 组成，不能只使用原生 SDK ID（部分任务没有该 ID，复制还会重新分配）。映射存于目标账号，并与新任务同一事务发布；由新增的 0118 migration 建立专用来源记录表。

重复导入默认跳过已有副本，不覆盖 Lex 中继续编辑的任务。失败只清理本次新建文件与媒体引用；事务回执不确定时走已有补偿逻辑，不能误删已经提交的内容。目标账号发生 A → B → A 切换仍应中止旧操作，不能只比较最终 user ID。

## 自动化覆盖与仍需手工验证

1. 来源列表到导入结果、显式部分导入确认与目录选择在同一设置页完成。
2. 合成数据覆盖 schema/WAL、任务过滤、Orca、附件/工作目录、Pi/Codex/Claude 原生来源、重复导入、账号代次、取消、失败清理与事务回执不明。
3. macOS 已验证入口、原生目录框打开/取消、运行中拦截及来源页 Light / Dark；完整数据导入、原生历史恢复和 Windows 实机仍需验证。

资源上限：每次最多 100 个任务，单库快照 2 GiB，单任务消息 128 MiB、累计缓存消息 256 MiB，临时文件总预算 8 GiB（归档写出后的核算可能有单包大小的短暂超额）。文件副本、目录和原生 SQLite sidecar 在发布前复验；超限项显示具体失败原因。进程退出或机器崩溃时，系统临时目录可能留下副本，正常完成/失败/取消会清理；本版不提供跨进程断点恢复。

必要回归包括：两个来源账号含相同任务 ID、目标切账号、重复点击、部分批量失败、数据库忙与损坏、源文件变化、附件缺失与越界、清空/rewind、退休伙伴四种归属、Orca lead/Worker 原子导入。macOS 与 Windows 都需验证中文路径、文件锁和失败清理。

此功能针对当前电脑的本地 Cindy 数据。SSH 任务不读取本机同名工作目录；手机端无需新增扫描入口，也不开放远程任意路径扫描 IPC。导入后的普通任务沿用现有多端访问链路。

## 当前验证范围

- 本机导入来源适配、WAL 快照、附件/工作目录、账户代次、逐条失败和取消：合成数据自动化测试。
- 普通分享导入、原生历史重映射、迁移事务与 Renderer 向导：相邻回归测试。
- `db:validate` 检查 Drizzle migration 链与 schema 对齐。
- 2026-10-30 macOS 隔离 Electron 实机：设置入口、来源发现、原生目录框打开/取消、Cindy 运行中阻止扫描、来源页 Light / Dark 目检通过。沙箱使用独立 userData、隔离模型凭证和被动调度；未执行真实任务导入。
- 2026-10-30 受控浏览器 UI：加载实际向导、翻译和主题，导入 API 使用合成返回值。选择/预检、目录与部分导入确认、逐项结果、已导入禁选、取消提示、Light / Dark 和 320 px 窄窗通过。来源变化后旧确认仍被沿用的问题已复现并修复，浏览器复验与自动化回归均覆盖。
- 2026-10-30 同级来源交互调整：Cindy 独立弹窗替换为共用列表与页面内预检。Mac 隔离 Electron 核对来源切换、来源页 Light / Dark 和运行中阻断；受控浏览器使用真实导入页与合成 IPC，复验列表/勾选、项目分组、目录选择、缺失项确认、结果和原生来源直接导入。修复 320 px 窄窗说明区挤掉任务列表的问题，滚动后可访问列表和提交按钮。自动化补充跨来源选中保持/混合导入、账号切换失效、100 条上限和取消后的迟到回包；上游伙伴角色与归档关联的过滤另有合成 SQLite 回归。
- **完整端到端尚未通过**：当前 Cindy 宿主必须保持运行，生产停机保护在扫描前阻断；原生目录框的路径输入也未通过自动化验证。没有绕过停机保护，没有验证 UI → SQLite/附件落盘 → 导入后打开任务的整条链路。后续需在独立终端控制 Lex、关闭 Cindy 后补测。
- Windows、真实 Cindy 数据布局及真实原生 Agent 子进程恢复仍未验证。受控 UI 的成功结果不代表文件复制、数据库事务或真实模型恢复已通过端到端验收。
