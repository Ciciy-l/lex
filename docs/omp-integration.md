# Lex OMP 集成进度与验收边界

## 目标

OMP 是新增的独立引擎，不替换 Pi，不复用 Pi 的会话身份或用户配置。
Lead 负责实现与测试验证，Orca Reviewer 负责独立审查。当前不另设 Tester Worker。
斜杠命令的验收以“发现、执行、交互、结果、状态同步”完整闭环为准，而非菜单数量。

## 协议研究基线

2026-09-12 查询上游 release API 并核对 tag 源码，当前研究基线为 v18.1.18。
这只是兼容研究常量，不是已经接入下载器的二进制版本 pin，也不代表完成真机验证。

- 上游仓库：can1357/oh-my-pi。
- 固定 tag 的 packages/coding-agent/src/modes/rpc/rpc-types.ts：请求、响应和交互类型。
- 同目录 rpc-mode.ts：实际命令分发及 ACK、prompt_result 的区别。
- packages/coding-agent/src/slash-commands/available-commands.ts：动态目录及来源分类。

按这些协议编写本仓独立适配代码；未引入上游代码或新增 npm 依赖。

## 第一阶段记录：内部协议基础，尚未开放产品入口

packages/maker-core/src/agents/omp 下新增：

- commands.ts：保留名称、别名、参数提示、子命令、来源；目录采用整体校验和替换。
  read ticket 按实例与代次隔离，推送更新、断连或新读取会作废旧读取。
  未知来源和损坏目录使命令不可用，不能沿用旧目录当作可执行授权。
- rpc-client.ts：注入已分帧的 transport，按请求 ID 与命令关联响应；交互响应不排在
  prompt ACK 后面。超时与断连不自动重发，因为原命令可能已产生副作用。
  ACK 不合成任务完成事件，prompt_result 和其他事件原样交后续宿主层处理。
- Review 修复：ACK 或超时后的 prompt ID 保留在最多 64 项的关联表里，同 ID 的后续
  response success:false 产生脱敏 omp_prompt_failure（id、command、固定 message），
  不丢弃为重复 ACK。失败后删除关联；宿主确认任务终态后必须调用 releasePrompt。
  不根据无请求 ID 的 agent_end 猜测归属；不会为腾空间静默驱逐未确定终态的 prompt。
  请求超时不代表执行终止，宿主应停止接收该会话新输入，先完成中断或状态协调。
- Review 修复：resolve 只判断已知的前导调用，不是纯命令/零模型调用判定。
  builtin 不 trim 原输入，使用空白或冒号分隔，主名和别名优先于 custom/file；
  extension/custom/file/mcp_prompt 按 ASCII 空格切分，不自行支持目录中的别名。
  leading skill 单独 trim 后按 ASCII 空格匹配。中段 skill 调用尚未分类，不能据
  resolve 返回 undefined 推断输入必然是普通聊天，也不能据其返回命令推断已授权。
  命令面板须核对 resolve('/' + 展示名称) 返回的身份与所选条目相同，屏蔽被遮蔽的条目。
- Review 修复：事件回调抛错关闭单个逻辑连接，不逃逸到 transport listener；
  teardown 逐项容错，保证其他清理与关闭通知仍各尝试一次，不输出回调异常内容。
- 两个测试文件：纯内存模拟协议，不访问外网、账号、用户配置或真实 CLI。

当前 transport 接收一行完整 JSON，默认使用协议 v1，不协商 v2，不支持 rpc_chunk。
单帧上限 1 MiB，并发请求上限 64。超限或协议损坏会关闭客户端的逻辑连接；不意味着
真实子进程已经停止。后续进程宿主必须保证字节读取有界，并负责终止、回收和退出确认。
错误响应不把原始运行时错误直接暴露给调用方；后续诊断需接入宿主脱敏日志。

在该阶段，这两个模块尚未从公共 index 导出，也没有生产消费者；当时没有引擎注册、GUI、
启动器、权限桥、持久化、SSH、Mobile、Device Link 或 Orca 接线，因此当时不能宣称“已支持 OMP”。
低层事件不是可信 GUI DTO，宿主必须按事件类型校验和投影，不能直接广播给 Renderer。
respondToUi 是协议编码能力，不是授权校验：宿主必须跟踪未完成交互、所属会话与窗口，
拒绝迟到、重复或跨会话响应。open_url 不得自动打开。

## 后续实施顺序

### 第二阶段进度：有界字节通道，尚无真实进程启动

新增 jsonl-reader.ts 和 stream-transport.ts，以及各自测试。RPC 客户端与读取器共享
1 MiB 帧上限；读取器按字节截断，最多缓存一帧和 CRLF 的一个额外 CR 字节，不因
整个 chunk 含多行而误判超限。UTF-8 严格解码，截断 EOF 不执行尾帧，消费者同步异常
关闭逻辑连接。输入字节先复制到有界缓存，不持有调用者可变缓冲区。

stream transport 接收宿主注入的专属 Writable/Readable，不 spawn、不读取环境或凭证。
输入输出均拒绝 objectMode，输入还必须没有预存积压；宿主不得在绑定期间另行写入或
更改流模式。出站固定编码成 UTF-8 Buffer，decodeStrings:false 和默认 encoding 不
改变 wire 字节或 writableLength 的字节计量。关闭解绑逐项容错，包括 removeListener
元事件抛错；所有已登记关闭通知取快照后逐项尝试，再请求宿主终止。
stdout 首个订阅前暂停；stdin 的积压字节上限也是 1 MiB 加换行，超限不重试写入。
close 通知与 onTerminate 各调用一次；onTerminate 仅表示请求宿主终止，不证明 OS 进程
已经退出。宿主必须把 RPC onClosed 接回 transport.close，负责销毁这对专属流并确认
进程退出。关闭后仍保留两个流上的 error listener，以吸收退出期间的迟到 error；
流不能跨会话复用。stderr 读取与脱敏仍需在进程层实现。

本地新增 20 个测试，OMP 总计 128/128 通过，maker-core build 和定向 ESLint 通过。
第一阶段 Reviewer 已关闭原四个 P1；后续定向与回归测试由 Lead 自行执行并记录。
本段没有升级到 v2/chunk 协议，没有对完整 OmpAgent、GUI 或真实 CLI 作通过承诺。
第二阶段 Reviewer 发现的字节计量/默认编码与解绑异常两项问题已由 Lead 修复，新增
8 个真实 Node 流回归用例，本地共 136/136 通过，待独立复核。此前 128 项是修复前结果。

1. Reviewer 独立审查协议基础；Lead 自行补齐边界验证并修复发现后继续。
2. 受控本地 OMP 启动和版本核验：配置根由宿主注入，禁止读取或迁移 Pi 的凭证。
   在新的隔离测试目录中验证真实 CLI；不改变现有 runtime CDN 或发行工作流。
3. 独立 OmpAgent、AgentKind 与会话存储契约，逐项检查现有穷举和旧端降级；不伪装成 Pi。
4. 事件投影、停止与恢复、模型配置、权限和插件工具装配。权限能力未验证前不开放入口，
   不把 OMP 的原生工具执行误标为已经受 Lex Ask/Auto 保护。
5. 动态斜杠菜单与交互：明确引擎命令与 Desktop 同名命令的路由，保留原输入参数，
   验证纯命令零模型调用的结束状态，以及切模型、标题变化、会话切换后的 GUI 一致性。
6. Reviewer 对完整产品链重新验收，随后才启动隔离开发实例供用户测试。

系统提示词、历史 migration、权限扩大和外部分发均不在当前基础实现中变更。
SSH 与设备互联必须显式适配或明确禁用，不能把远程路径或会话静默当成本地执行。

## 当前验证入口

### 第三阶段进度：进程宿主实现，尚未生产接线

新增 process-lifecycle.ts/process-host.ts 与各自测试。宿主使用 Node spawn，要求绝对
可执行路径和 cwd，拒绝 cmd/bat；shell:false/windowsHide:true，环境只使用调用者
显式传入的快照，不合并 process.env。环境路径隔离仍须由后续 Desktop 装配保证，
显式传环境本身不是 OS 沙箱，也不能证明没有引用用户原有配置。

生命周期区分 starting、ready、draining、stopping、exit-unconfirmed、exited。30秒启动超时，
用户停止后3秒升级强制终止请求，10秒仍未确认则返回 false；不会自动重启或重放消息。
当时的阶段实现曾让 macOS／Linux 用独立 process group，并让 Windows 使用 Main-only Job Object；
该 Windows helper 后续已移除，以下方“当前生产接入”的普通 Node spawn 合同为准。自然 root exit
与 stdio close 仍分别处理，已缓冲的 JSONL 尾帧继续 drain；drain 到10秒上限返回
`exit-unconfirmed`，不能由 kill 返回值、stdout EOF 或超时推断成功。

stderr 当前仅 drain，不解析、缓存或输出原文，避免泄露凭证；可操作脱敏诊断尚未接入。
RPC/字节通道失败会停止进程并销毁专属三条流，仍等直接进程退出确认。调用者必须核验
二进制版本、注入隔离配置并在 ready 前阻止用户发送；当前暴露的是内部低层 API。
协议 ready 只验证 v1 兼容，不证明二进制版本或安全能力。未新增 AgentKind 或 GUI 入口。

Lead 本地 OMP 测试158/158通过（新增生命周期12项、模拟子进程10项），没有启动真实OMP。
第一、二阶段 Reviewer 阻断项已关闭；第三阶段待审查。测试验证由 Lead 负责。

第三阶段首次审查发现两项接线问题，Lead 已补修复及4项宿主回归，本地总数162：
所有 stopping/exit-unconfirmed 状态先进入内部资源停用，再通知外部观察者，不依赖
外部 onState 正常返回；停止后 RPC 拒绝请求、三条专属流销毁，退出确认与升级计时不变。
自然 child exit 则先进入 draining：RPC stopAcceptingRequests 只关闭发送不关闭读取，
transport beginDrain 忽略随后 stdin close，继续读 stdout 尾帧至 EOF。排空最多10秒，
超时销毁资源并返回未确认；child close 才确认退出。自然 exit 后不向该 PID 再发信号。
禁止新请求的检查在 RPC 建立 pending/写入之前，因此退出期间尝试发送不会误关闭尾帧通道。
测试按 Node 原生 stdin.destroy → exit → stdin close → stdout尾帧 → EOF → child close
顺序验证，而不只直接模拟 child close。真实 OMP 与平台杀树仍待验收。

第三阶段尾帧复核补充：自然退出排空期间也吸收 stdin 的迟到 error 与已提交 write 的
异步失败回调，不能因此销毁 stdout；仅可信 child exit 触发的 beginDrain 开启此语义。
正常运行时这两条输入错误仍关闭连接，排空中的 stdout error/损坏帧同样关闭连接。
新增真实 stalled Writable 的6项对照回归，验证尾 response 与 prompt_result 保留、无
新写入、无已退出 PID 终止信号，以及非排空/输出错误仍拒绝在途请求。Lead 总计168项
测试通过；类型检查和ESLint通过。Reviewer 已独立复跑宿主与字节通道36项并关闭剩余P1，
本轮范围内未发现新增P0/P1；不代表真实 CLI 验收。

### 当前生产接入（2026-09-18）

下面“第四阶段”及其后的探测说明保留为历史审查记录，不能再当作当前产品能力边界。现在的本地 OMP 接入遵循与 Claude Code、Codex、Pi 相同的跨平台本地引擎范式；SSH 是独立的远程执行路径，由 Desktop host 提供 remote runtime 与 SSH transport：

- 会话在独立的受管 runtime HOME 中启动，模型与认证只经受管 `cindy` provider / loopback proxy；不会读取或复用 Pi、PATH 或用户 `~/.omp` 的凭证和会话配置。
- 真实工作目录仍是 OMP cwd。项目 MCP、extensions、Skills、Rules、LSP 与 PTY 不再被早期探测旗标关闭，按 OMP 原生发现与执行语义工作；`--no-title` 保留给 Lex 管理任务标题。
- child env 仍不是 `process.env` 副本：宿主只显式提供 PATH、POSIX shell / terminal / locale，或 Windows SystemRoot、ComSpec、PATHEXT，以及本会话的受管凭证变量。
- 共享 `~/.agents/skills` 以链接投影到 runtime HOME 的 `.agents/skills`；投影失败不改写现有目录，也不会让会话采用用户 OMP 配置。
- 进程启动使用普通 Node spawn 与共享生命周期：macOS／Linux 以 detached process group
  尽力终止进程组；Windows 只对直系子进程做尽力清理，不提供 OS 级后代回收保证。root 退出后，
  若后代仍持有 stdio，排空有界结束并报告 `exit-unconfirmed`；signal 成功不等于退出确认。

这段描述的是本地引擎接线，不是 OS 沙箱或对原生项目扩展副作用的额外授权承诺。OMP 仍保留由 Desktop host 注入 remote runtime 与 SSH transport 的远程执行代码路径；它与本地 runtime/spawn 是独立路径。真实发布制品上的跨平台运行仍须按发布流程单独验证。

### 历史记录：第四阶段隔离探测启动计划（2026-09-12）

2026-09-12 再次按 v18.1.18 固定 tag 核对启动配置。尚未增加生产配置、下载或启动
真实 OMP，也未开放 GUI。以下是源码确认的风险，而不是已经实现的隔离保证：

- packages/utils/src/env.ts 在模块初始化时读取 home、config root、agent dir 与
  project 的 .env，只在目标环境值为假值时补入；空字符串不能作为禁止加载的屏障。
  文件还明确区分 Bun 在用户代码之前的 dotenv 自动加载与 OMP 自己的加载。
- packages/coding-agent/src/capability/index.ts 的 enabledProviders 主要控制外部
  工具的用户级配置加入；并不是项目级配置允许列表。disabledProviders 才是整个
  provider 的关闭集合。因此仅设置独立 agent 目录或空 enabledProviders 不足以证明
  启动不会发现项目或其他来源的配置。
- config/settings-schema.ts 的 tools.approvalMode 默认是 yolo，
  tools/approval.ts 中 always-ask 仍自动放行 read tier，且存在工具和用户级策略。
  不得直接把这个名称映射为 Lex Ask，也不能把原生确认弹窗等同于 Lex 权限链。
- main.ts 把 --config 传给 Settings.init 的 configFiles，不是任意 key=value
  override 参数；--approval-mode 则显式写入临时 settings override。
  startup.setupWizard、startup.checkUpdate、mcp.enableProjectConfig 的默认值
  均为 true。后续启动计划须分别核对，不依赖 CLI 默认值进行受控测试。

已新增纯启动计划与 Desktop Main 临时目录物化器，但二者都**不启动进程**：

- `createOmpIsolatedProbeLaunchPlan()` 只生成固定 v18.1.18 的 RPC 探测 argv、
  受控 YAML 与全新环境快照。环境不继承父进程；HOME、PI 配置/agent 目录、临时目录、
  XDG 根以及 Windows AppData 根都指向同一个新沙箱。Windows 仅允许宿主显式提供的
  非秘密 SystemRoot/WINDIR。
- `PI_CONFIG_DIR` 按上游语义固定为 HOME 下的目录名 `.omp`，不是错误的绝对路径；
  对应实际配置根是 `<sandbox>/home/.omp`。
- 探测 cwd 是 `<sandbox>/home/workdir`，而非 HOME 的兄弟目录。固定 tag 已确认的
  项目插件注册表会从 cwd 向上查找并在 HOME 截止；这个布局使该路径在全新 HOME 内停止，
  不会继续遍历宿主的临时父目录。
- Desktop 的 `createOmpProbeSandbox()` 只接受宿主提供的绝对临时根，realpath 后用
  `mkdtemp` 创建唯一子目录，物化所有受控根并以 `wx` 写入配置。释放只会删除本次创建的
  唯一目录；若根目录被替换为符号链接/reparse point，会拒绝递归删除。
- `--version` 输出必须严格是 `omp/<semver>\\n`，当前只接受研究基线 `18.1.18`。
  这只是为未来受管 runtime 的版本核验准备，尚未允许 PATH 中任意 `omp`，也未接入
  下载器、运行时 CDN 或发行流程。

首次协议探测仍只允许在宿主创建的全新临时 home/config/workdir 内进行，不扫描已知的
真实用户目录或项目配置，不复制凭证或项目配置，不发送模型 prompt。真实项目模式须先
确认 dotenv、配置发现、扩展/MCP 与工具审批的完整加载顺序和 RPC 接线，再实施明确的
信任策略。目录重定向不是 OS 沙箱，`--no-tools` 等启动旗标也不自动证明所有原生命令
没有副作用。
即使零 prompt 探测也不能宣称零后台网络；如需该保证，必须另行采用 OS 网络限制并实测。

### 受管开发运行时：固定版本，尚未接入发行产物

`tools/omp/latest.json` 固定 OMP v18.1.18 六个平台的 GitHub Release 文件名、URL、
SHA-256 与字节大小；`tools/omp/update.mjs` 每次下载前都重新核对 release 元数据与
该 pin，任意 URL、摘要或大小不一致都会拒绝下载。`pnpm install:omp` 对已在本地的
runtime 也会重新核对固定版本、精确大小和 SHA-256；不会因 `.version` 相同、文件大于
1 KiB，或兄弟 worktree 存在同名文件而复用未验证二进制。它不会“升级到 latest”：新版本
必须先更新协议审查基线和适配器，再同步修改 pin。

开发者可显式运行 `pnpm install:omp`（或 `pnpm update:omp -- --platform=<platform>`）
把当前平台二进制放入 `apps/omp-bin/<platform>/`。OMP 不在 postinstall、默认开发启动
或默认运行时列表里，因此不会自动下载约 150–200 MB 的上游二进制，也不会从 PATH、Pi
目录或用户安装中寻找替代品。正式 Lex 安装包则复用 `agent-binaries` 的同一条受管链：
启动页串行队列读取构建期固定的 `config/lex-agent-runtime-assets.json`，其中 `omp`
条目的 `file` 直接是 `tools/omp/latest.json` 固定的上游 GitHub Release URL（与
claude／codex／pi 只差源，下载、size 与 SHA-256 校验、进度广播与 `.verified` 标记
完全同构），落到 `userData/omp/<version>/`。

**平台边界**：`tools/omp/latest.json` 列了 6 个平台，但构建资产表只发 4 个
（`win32-x64`／`darwin-x64`／`darwin-arm64`／`linux-x64`）。`linux-arm64`／
`win32-arm64` 上没有 `omp` 条目，受管本地 runtime 准备不可能成功：`buildShipsOmpRuntime()` 据此把
它们判为「平台不支持」，启动页不出下载段、不排重试；只有宿主另行配置可用的 SSH remote runtime
与 transport 时，才可走远程路径。dev 态不受此限（`pnpm install:omp` 支持全部 6 平台）。

第五阶段新增 Desktop Main 的 `omp-probe-runtime.ts`，它只会在开发模式解析
`apps/omp-bin/<platform>/omp`（Windows 为 `omp.exe`），对照上述固定 version、平台、
文件名、精确字节数和 SHA-256 后才返回路径。它不读取 PATH、Pi 目录或用户配置，也不
枚举或自动搜索兄弟 worktree、发布包目录；它不会下载或启动二进制，打包版在检查本地
路径之前直接拒绝。
该解析器在真正执行前仍须重新校验，并需先完成平台进程树收敛与受管发布 runtime
snapshot 的验收。

同阶段的 `omp-probe-preflight.ts` 只把“已校验的开发 runtime”与“新建隔离 sandbox”
配对成不可启动的 launch 输入；它不导入 child-process、不暴露 RPC client 或 prompt/UI
方法。options 字段或 runtime 的纯校验失败时不会创建 sandbox；sandbox 物化阶段自身的失败
会清理已创建的唯一根。获得预检也不代表已启动或可执行真实项目任务。

### 历史阶段：跨平台内部隔离探测宿主（未开放产品入口）

`omp-isolated-probe-host.ts` 将前述预检、已存在的 `startOmpProcess()` 和
`OmpProbeController` 组合成一个仅供 Desktop Main 调用的内部对象。它不注册 AgentKind、
不接 Renderer／IPC／session，也不把原始 RPC client、UI response 或进程句柄交给调用方。

- 每次启动先生成预检，再在 `spawn` 前重新解析并核对同一固定 pin、摘要、大小和二进制
  路径；重核失败时尚未有 child，唯一 sandbox 会被清理。若 `startOmpProcess()` 在创建 child
  后才失败，宿主无法证明 child 不存在，会保留 sandbox 而不是冒险递归删除。
- 这段历史探测宿主最初设想的 Windows `taskkill /T` 曾由 Main-only Job Object containment
  替代；该 helper 后续已移除并改为普通 Node spawn，现行合同见上文“当前生产接入”。stdout 尾帧与回收仍分开
  结算；该机制不声称 OS 级文件系统、网络或权限隔离。
- 只有收到兼容的 `ready` 后才由 controller 发出 `get_available_commands` 和 `get_state`；
  原生 UI/tool/URI 交互一律关闭连接，不生成批准响应。调用者只看到冻结后的命令目录、
  `stateAvailable` 与受控 failure code。
- `stopAndDispose()` 只在直接 child 的 `close` 已确认时删除这次唯一 sandbox；
  `exit-unconfirmed` 返回 `false` 并保留目录，晚到的确认退出后可显式重试清理。

该隔离探测宿主只是开发模式、零 prompt 的内部协议探测准备，不描述当前 OmpAgent 能力：它本身没有真实项目执行、
权限桥、GUI、持久化、SSH、Mobile、Device Link、打包 runtime 或发行接线。合成测试不启动
真实 OMP，也不读取用户 HOME、配置或凭证；Reviewer 继续独立审查最终代码，测试由 Lead 自行执行。

在 app 根目录：

- pnpm --filter @cindy/maker-core exec vitest run src/agents/omp/launch-plan.test.ts
- pnpm --filter desktop exec vitest run src/main/maker-host/**tests**/omp-probe-sandbox.test.ts
- pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/omp-isolated-probe-host.test.ts
- pnpm --filter @cindy/maker-core build
- pnpm --filter desktop typecheck

当前基础不改变模型 prompt、模型路由、工具装配、usage 或已有事件转换热路径。
模型缓存率、真实请求延迟和端到端输出准确性仍须在 OmpAgent 接入后实测，不能用这批
内存协议单测代替。没有提交、推送、PR 或发布动作。
