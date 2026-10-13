# Lex Harness 设置

Desktop 设置按功能分组：版本与升级、自定义提示词、记忆、Subagent、上下文压缩、扩展。
各分组只显示引擎实际支持的设置。模型供应商、通用 Skills/MCP、Orca 协同仍在原位置。
Mobile 设置界面、SSH 引擎安装管理、伙伴功能不在本次范围。

## 设置页面布局

记忆与 Subagent 各使用一张功能卡片，OMP 行与其他引擎并列，不另起独立卡片。
上下文压缩沿用各引擎独立卡片，功能标题在左，引擎小标与恢复默认在右。
整个 Harness 页使用简短的 12px 次要说明；版本空状态不占行，提示词范围与标题同行。
高级设置入口放在开关左侧或模型选择器旁，折叠时不另占一行；窄窗口允许自然换行。
OMP 的统一记忆、默认 Subagent 模型、压缩开关及阈值直接展示；原生记忆与清理、
Subagent 并发/递归深度、压缩保留量分别放在对应功能内的高级设置，默认折叠。
高级字段有覆盖时显示已修改状态，设置搜索命中时展开；展开状态只在页面内保留。
OMP 模型选择复用标准 ModelSelector，只保存模型 ID，不引入跨供应商选择或 effort 设置。
OMP 压缩阈值复用 Claude Code/Pi 百分比滑杆：原生默认档后为 50%–95%，步进 1%。
默认档持久值仍为 null（UI 内部位置 49 不落盘），不将原生的预留 token 策略冻结为 90%。
滑动只预览，操作结束后提交；恢复默认仅在有覆盖时显示，仍作用于整个功能组。
高级数值留空跟随原生默认值，非法值行内提示且不提交；保存失败回显保存前的值，恢复默认同步输入。
关闭自动压缩只禁用参数编辑，不清除已存阈值与保留量。记忆总恢复涵盖 OMP，
OMP 行内恢复仅处理当前功能的键；恢复配置与清理记忆是不同操作，后者保留确认和占用检查。
Pi 扩展说明、安装、提示与已安装列表位于一张完整引擎卡片内，内部用分隔线；
后续支持其他引擎扩展时新增完整引擎卡片。兼容性诊断继续只提示，不增加安装门槛。

## 版本与升级

- Claude Code：Anthropic npm stable 元数据 + 官方发布清单 SHA-256。
- Codex：OpenAI stable release 的完整 codex-package，保留 code-mode host、rg、资源目录。
- Pi：earendil-works/pi stable release，复用现有官方资产解析和 Windows 发布重试。
- OMP：can1357/oh-my-pi stable release 的官方裸二进制。
- Pi Windows 官方资产使用 pi-windows-<arch>.zip（不是 pi-win32）；macOS/Linux 使用 tar.gz。
  GUI 与 Pi 自更新共用解析器，核对官方 URL、SHA-256 与目标平台，不借用其他平台资产。
- 恢复版本来自此 Lex 构建固定的 config/lex-agent-runtime-assets.json；不读取 Cindy 的应用更新渠道。

页面进入时检查，检查单飞并缓存 15 分钟，可显式刷新。检查不下载。
版本查询、资产缺失、下载、解包、校验与保存失败按阶段显示具体恢复动作；
新增可选 failureStage 状态字段兼容旧回执，不向界面回传原始路径、响应或凭证。
GUI 安装写入 userData/harness-runtimes/<kind>/<version>-<uuid>，按引擎使用跨进程安装锁。
下载校验发布方 SHA-256、包布局和真实 --version，最后原子写入 selected.json。
下载/解包/版本检查失败或取消时不替换原选择，不修改活跃安装目录。
取消和失败保留下载缓存，下一次安装可继续下载；旧安装暂不自动回收，以免影响其他进程。
下载压缩包上限 1 GiB、单文件上限 1 GiB、展开上限 3 GiB，普通工具归档仍使用原限制。

每个进程在首次解析时冻结选择。GUI 安装仅在用户手动重启 Lex 后使用，不发起重启、不打断任务。
启动选择优先于 dev/baseline 路径，应用升级不覆盖已选引擎。
读取选择时校验受管路径、文件身份及入口摘要；文件变化后重新核验摘要。
OMP 默认基线严格固定为 18.10.3；经管理器校验、显式选中的官方稳定版使用自己的版本和摘要。
四引擎 0.1.5 固定版本、官方格式与新版源码兼容依据见
[Lex 0.1.5 引擎基线](lex-0.1.5-engine-baselines.md)。
原生 Pi 显式更新命令保持原有下一运行环境生效语义，并写入同一持久选择，GUI 不额外审批这些命令。

IPC 只接收 kind/source/version，不接受 URL、路径或命令。
所有新通道经过可信本机 renderer 校验，不加入 device-link 或 SharedTask allowlist。
进度使用事件推送，无定时轮询。

## 提示词

保留原有账号级通用提示词键，新增账号/引擎追加键。
组合顺序为引擎原生系统提示词、通用追加、该引擎追加。
通用与引擎追加合计最多 8,000 字符（含分隔符），保存失败不会显示成功。
账号变化时旧编辑器不能写入新账号。切换引擎时按待切换的目标选择追加内容。
原有运行中 Agent 会话不自动重建；重建时读取新值。

## OMP

设置存于 owner-scoped omp-harness-settings.json，仅记录 override；恢复默认删除相应 override。
每个 Agent 会话捕获设置快照。正在运行的 Agent 会话保留原配置。

- **统一记忆**：默认参与 Lex 统一记忆；加载同一项目范围的索引和规则，使用现有记忆工具注册表。
  OMP RPC 桥只增加 list_tools/call_tool 两个发现入口，复用账号、项目范围、写入回执和异步前后复核。
  关闭统一记忆或 OMP 的参与开关时，新 Agent 会话不注入该工具面。
- **原生记忆**：默认关闭。选用原生 Mnemopi，持久根为
  owners/<owner>/omp-memory/data，按项目召回，noEmbeddings=true 使用本地全文检索。
  不下载嵌入模型、不接第三方记忆服务；自动整理可调用当前任务已授权的模型。
  全局统一记忆开启时，新 OMP 运行环境暂停原生记忆，保留原生偏好。
  清空必须在 UI 确认；使用跨进程占用记录，运行环境未退出时拒绝清空。
  原生记忆不放入易重建的 runtime HOME，也不共享含设置/凭证的 agent.db。
- **Subagent**：默认继承父模型；可指定同一供应商、同一原生 API 路由内的模型。
  当前父供应商无法提供偏好模型时回退父模型，不借用其他供应商的凭证。
  具名 Agent 的显式模型设置优先。并发/递归深度留空跟随原生默认值；0 并发遵循原生“不限”语义。
- **压缩**：使用 compaction.enabled/thresholdPercent/keepRecentTokens 及原生事件。
  不叠加宿主自动压缩器；选择原生默认不写阈值，保留量留空不写数值。

模型协议标识按 OMP 实际模型/供应商 wire route 判断，与受管 models.yml 保持一致。
Anthropic Messages、OpenAI Responses、Chat Completions 可直接使用；原生模型协议与
上游接口存在已知差异时仍显示兼容，缺少路由信息保持未知。Google 等未接通原生前门
不能标为 OMP 原生直连；显式模型可见性和默认覆盖均保留。

## 验证与边界

新增回归覆盖：官方资产筛选、安装失败/取消不覆盖、重启激活与篡改拒绝、
提示词组合/长度/账号、OMP 设置覆盖/账号/占用清理、原生 YAML/实际启动接线、记忆工具账号/项目/实例边界、IPC 来源/参数/账号代际、设置搜索迁移。
按用户选择，测试、typecheck、build 交由 PR CI；本机不重复执行这些套件。
Light/Dark 复用设置语义 token；未声称实机 GUI、真实引擎下载运行或跨平台发布包已验收。
新引擎版本协议变化仍需实际使用验证，故始终保留恢复 Lex 基线入口。

## 来源

此实现是 Lex 本地适配。参考 Cindy #4913 的持久选择/独立安装目录和 #5061 的版本管理交互，
没有复制 Cindy 应用更新通道、自动重启或整批合并上游功能。
历史 OMP 原生字段与 Mnemopi 合同依据 can1357/oh-my-pi v18.1.18 的
packages/coding-agent/src/config/settings-schema.ts、mnemopi/config.ts、mnemopi/backend.ts、task/agents.ts。
原始参考提交元数据见文末，后续作者归属保持真实 Lex 提交身份。

```text
commit 188412e97b6287346f8932b537def63982a461eb
Author: Chris Zhang <chrisz83@gmail.com>
AuthorDate: 2026-09-23T18:24:36+09:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-23T16:24:36+07:00

feat(pi): 增加内核版本管理与正式版恢复 (#4913)

* feat(pi): add kernel version management and persistent recovery

Signed-off-by: zqchris <chrisz83@gmail.com>

* test(pi): distinguish host permissions from target asset platform

Signed-off-by: zqchris <chrisz83@gmail.com>

* chore(design): refresh inventory after upstream merge

Signed-off-by: zqchris <chrisz83@gmail.com>

---------

Signed-off-by: zqchris <chrisz83@gmail.com>
Co-authored-by: Chris <4436110+zqchris@users.noreply.github.com>
```

```text
commit 5d5d6659f06466b1b60c416e8accd2c16141503c
Author: Lizi <jiali@magiclizi.com>
AuthorDate: 2026-09-25T03:08:06+08:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-25T03:08:06+08:00

feat(desktop): 关于页 Claude Code / Codex 版本菜单对齐 Pi (#5061)

* feat(desktop): 关于页 Claude Code / Codex 版本菜单对齐 Pi

Claude Code 与 Codex 的版本行改用与 Pi 共用的 HarnessVersionMenuRow：
点版本号打开菜单，只提供更新到当前渠道版本、检查更新与上次检查时间；
更新仍走确认、忙碌提醒后重启，由启动 Splash 安装。

binary-version 的 checkLatest 响应追加 latestCheckFailed，读不到线上清单时
行内显示检查失败。弹窗与菜单文案改传产品名，不再出现「更新 Claude Code 版本号」。

Signed-off-by: MagicLizi <jiali@magiclizi.com>

* fix(desktop): 检查失败后禁用 harness 更新，并避免 Windows Python 协议探测卡住

关于页再次检查线上清单失败时不再保留上次的 updateAvailable，避免用户按过期版本确认重启。Windows 上 DuplexClient 默认劫持 stdout 会导致 spawnSync 超时 status=null，协议探测改为显式注入 stdin/stdout。

Signed-off-by: MagicLizi <jiali@magiclizi.com>

* fix(desktop): 关于页检查失败文案改为可操作下一步

清单请求失败时行内不再只显示「检查失败」，五语改为说明无法检查更新并提示打开菜单再试，符合 DESIGN.md §11.1。

Signed-off-by: MagicLizi <jiali@magiclizi.com>

* fix(desktop): 关于页失败状态改为可收缩换行

800px 最小窗口下 Settings 侧栏仍占 260px，长失败文案不再 shrink-0，行内保留打开菜单再试，避免横向撑破版本行。

Signed-off-by: MagicLizi <jiali@magiclizi.com>

* fix(desktop): 检查更新进行中禁用 harness 更新

再次检查尚未返回时不再用上次的 updateAvailable 确认重启；菜单项与 handleUpdate 都把 checking 纳入门槛。

Signed-off-by: MagicLizi <jiali@magiclizi.com>

---------

Signed-off-by: MagicLizi <jiali@magiclizi.com>
```
