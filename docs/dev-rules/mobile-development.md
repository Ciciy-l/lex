# Mobile 开发、模拟器与验证

> **读取时机**：开发、启动、调试或验证 `apps/mobile` 及其共享能力时

本文是 Mobile 日常开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/mobile/package.json` 为代码事实源。

## 日常模拟器入口

普通开发使用根脚本维护 Metro、区域配置和 worktree 归属：

```bash
pnpm mobile:sim:start
pnpm mobile:sim:whoami
```

Windows 下 `mobile:sim:start` 还会复用或启动 `cindy-api36` Android AVD，等待系统启动完成，
并为 Metro 端口建立 `adb reverse`。中国大陆版的一键入口名称带有明确区域限定：

```bash
pnpm mobile:sim:start:cn
```

可用 `-- --avd <name>` 选择其它 AVD；只需 Metro 时传 `-- --no-emulator`。脚本从
`ANDROID_SDK_ROOT`、`ANDROID_HOME` 或 Windows 标准 Android Studio SDK 目录解析工具，
不要求把 `adb`、`emulator` 加进 `PATH`。

修改原生依赖、Expo 原生配置，或切换到尚未安装对应开发包的区域时，重新构建：

```bash
pnpm mobile:sim:rebuild
pnpm mobile:sim:rebuild -- --region=cn
pnpm mobile:sim:start -- --region=cn
```

不传 `--region` 的日常入口默认运行 Cindy（Global）；中国大陆版必须显式传
`--region=cn`，或使用名称已明确限定区域的 `mobile:sim:start:cn`。发布构建继续要求显式
指定 region。

不要用临时 Metro、端口探测或手工修改 `.env` 代替这些脚本。多 worktree、原生构建、
登录态和日志排查见 `apps/mobile/docs/simulator-debugging.md`。

## 分层验证

```bash
pnpm --filter mobile typecheck
pnpm --filter mobile exec vitest run <测试文件路径>
pnpm --filter mobile test
pnpm --filter mobile test:scope
pnpm --filter mobile test:smoke
```

- TypeScript 改动至少运行 typecheck 和相关定向测试。
- 修改跨端协议、Device Link、导航主流程或原生边界时，追加 scope、smoke 或相应 E2E。
- 视觉改动同时遵守 [Cindy 设计规范](../design-rules/cindy-design-system.md) 与
  [Mobile 设计规范](../../apps/mobile/docs/mobile-design-guide.md)。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

## 专项入口

### 浏览器登录与服务区

- 登录页挂载使用 `initialize`，不以 `reset` 清除正在浏览器完成的授权。Android
  系统浏览器返回 `dismiss` 时保留 PKCE，等待原始 Linking 回调；热回跳不导航，
  冷启动回到根入口后由 AuthProvider 恢复待完成登录。iOS 的取消语义保持不变。
- 明确取消、退出添加账号或 Lex 切换服务区时，先同步使旧登录代次失效，再串行持久化
  取消标记／清除待授权数据；清除失败显示可重试错误。迟到的读盘、交换和原生浏览器
  返回不能覆盖新流程；重复 Linking／浏览器成功回调只交换一次。
- Lex 初始化沿用用户选择的 Global／中国大陆服务区；回调沿用其已校验 PKCE
  记录中的服务区。添加账号期间不切换当前账号的运行端点；冷启动清理失去现场的
  添加账号授权，不抢占原账号恢复。

实现见 `src/auth/AuthContext.tsx`、`app/+native-intent.ts`；回归包括
`browserAuthSession.test.tsx`、`personalLoginRealm.test.ts` 和 `nativeIntent.test.ts`。

### 新建任务模型

- Claude、Codex、Pi、OMP 的新建草稿均不写死模型；按当前电脑的最近任务、已加载目录
  及新任务默认标记选取。只有主机明确不支持 `provider:list` 时，才使用其能力表模型。
- 自动模型尚未落定时显示「正在读取模型…」并阻止普通／目标任务创建；目录失败或为空
  且没有模型时显示「未选择模型」。切电脑重置旧自动选择，手动选择按原有规则保留。
- 提交终检仍校验实际目录；所选模型失效且无可替代行时要求重选，不能发送空模型。
  保持各引擎已有权限、来源、思考档位和快速模式合同。

### 消息缓存与首页偏好

- 阅读历史解除自动跟随后，只有明确向下且到达内容末端（24px 容差）才恢复，
  不用较宽的近底区域重新吸附。录音正常结束只恢复光标；用户点击输入框结束录音时才聚焦。
- 新建任务的 worktree 行首次资格探测完成后再出现，同设备/目录重探可沿用已展示定论。
  展示缓存不参与创建门禁；已勾选但恢复中、探测失败或旧端不支持时仍保留解释和关闭入口。
- 已发送消息的引用摘要只展示可读文字，剥离 Markdown、图片地址和内部 ID，按可见字符截断；
  输入框、任务标题与持久化引用不受摘要规则影响。首页短暂被覆盖时保持列表订阅，
  返回时按 `homeListFreshness` 补拉失效设备；后台、重连或长时间离开仍做完整对账。
- 桌面、手机与主机历史分页共用续跑边界：折叠中断前进度时保留错误、交互、交付内容，
  不越过真实历史间隔；翻页锚点带费用或用量结束印记时也参与结束判定，不删除原始消息。

- iOS、Android 的最近消息窗口统一写入私有 `cache/session-messages-v1/` 文件，
  不设总容量或按时间淘汰；分页、内存窗口、消息净化与显式删除语义不变。
  该目录属于可再生缓存，系统低空间回收后会从主机重新获取，不作为消息权威副本。
- 旧 AsyncStorage 消息按需迁移：仅在文件缺失时读取旧条目，成功原子写入后再删除旧值；
  失败保留旧条目。回退到旧版不会读取新文件，会重新从主机获取消息。
  迁移与同一任务的写入／删除共用队列，退出账号等待在途迁移后清理两种存储。
- 每次启动把剩余旧 AsyncStorage 消息条目逐条迁成文件（走同一按需迁移与按 key 队列，
  成功后才删旧值；同 key 已有文件时以文件为准，只删旧值）：未打开会话的旧副本会占满 Android AsyncStorage 的 6 MiB 库，使发件箱、
  草稿写入报 `SQLITE_FULL`（#5403）。旧副本含没有服务端副本的 `mobile-system-*` 卡片，
  不能直接丢弃。
- 发件箱写入遇到 `SQLITE_FULL` 时先执行上述迁移再重试一次；仍失败提示「手机本地存储已满」，
  不把原始 SQLite 报错直接给用户，也不清理草稿、发件箱或其他非缓存数据。
- 主机已接收的消息保留本地发件箱记录，直到可用于重新进入任务的历史窗口成功落盘。
  历史确认与缓存接管分开记录；缓存失败可稍后继续交接，不重复发送，也不阻塞后续消息。
  主机历史顺序以 `(createdAt, rowid)` 判断，不以导入顺序推测消息已移出窗口。
- 已接收但页面隐藏的消息不为缓存交接持续轮询或占用原始消息窗口；重新进入任务或
  明确撤销时恢复对账。旧主机仍用原始窗口缓存；显式交接作废旧去抖写入，卸载读取
  最新 store 消息，防止旧渲染快照覆盖已确认内容。所有写入继续受账号／缓存代次约束。
- 排队或已撤销消息可能没有历史行；明确 `NOT_FOUND` 交由主机投递回执继续判断，
  其他读取错误照常保留。历史缺失本身不证明撤销成功，也不允许重发不确定消息。
- 删除逐项尝试旧条目和文件，不依赖新增文件写入；任一后端失败不阻止另一后端清理，
  单个文件失败也不阻止后续文件删除，全部尝试结束后统一报告失败。清理报错时可能仍有
  无法删除的残留，不能视为清理成功。新登录或切换账号必须在持久化
  新身份前完成缓存清理；清理失败沿用登录错误与回滚路径，不能激活下一账号。
  退出账号仍完成凭证清除；若缓存清理失败，下次登录会先重试。无有效账号期间禁止
  读取或写入消息缓存，避免退出后的卸载回调重新落盘。
- 首页分组等偏好继续使用 AsyncStorage。合并保存时读失败不得当成空配置；写失败
  必须向用户提示，不能把未落盘的选择当成已保存。
- 文件写入失败（含磁盘空间不足）会提示检查剩余空间，并说明离线内容可能不完整。
  同一次启动最多提示一次，后台失败延后到前台提示；不把所有 I/O 错误都断言为磁盘已满。

实现见 `src/session/messageCacheStorage.ts`、`mobileSessionMessageCache.ts`、
`homeViewPreferenceStore.ts`，回归见 `src/__tests__/` 下对应测试。

- 模拟器与真机排错：
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md)。

## 原生配置与 runtime fingerprint(冷更边界)

Mobile 用 `runtimeVersion.policy: "fingerprint"`:OTA 热更只在**指纹一致**的装机上生效,
指纹一旦变化就必须**冷更出包**(新商店包 / 自建重装),存量装机拿不到该次热更。

### 硬性规则:除非必要,不得提交会改变指纹的改动

触发冷更的代价由全体存量用户承担——他们拿不到本次及后续热更,直到装上新包。性质上这与
技术框架变动同级,因此:

- 只为实现 JS / UI 需求时,不得顺手改动指纹输入。同样效果能用不动指纹的写法达成时,必须
  选不动指纹的写法。已知踩点与既有规避写法:调试信息走 `EXPO_PUBLIC_*` 进 JS bundle,不写进
  `app.config.js` 的 `extra`;新增开发脚本放仓库根 `package.json`,不放
  `apps/mobile/package.json`(后者的 `scripts` 是指纹输入,见
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md))。
- 确实必须冷更时(升原生依赖、改 config plugin / 原生模块、动 production 段 `app.json` /
  `eas.json`),PR Description 必须写明三件事:为什么冷更不可避免、存量装机影响范围、发版
  节奏建议。
- **审查标准:会触发冷更的 PR 与技术框架变动同级,必须由仓库指定的把关人针对冷更明确
  确认后才能合并。** 不看改动大小,也不看谁提的——提交者是不是维护者、有没有拿到普通
  Approve、有没有被标回 Ready 都不构成例外;把关人自己提的 PR 同样要留下一条显式的冷更
  确认。未确认前不进入自动审查与自动合并路径;判定、hold 与放行走与技术架构变更门同一套
  机制(讨论 issue + 转 draft + 确认后放行),名单与细则属维护者内部 gate。
- 提交前自查:在改动前后各跑一次
  `node apps/mobile/scripts/ci-fingerprint.mjs compute --output <file>` 并比对 hash。PR 上
  出现 fingerprint guard 的 sticky comment 时,以它给出的 base(main) vs 合并结果对比为准。

### 判断哪些改动会动指纹

- 改 `app.json` / `app.config.js` 前先判断是否会动指纹。被哈希的是**解析后的
  ExpoConfig**(app.config.js 的输出),不是源文件本身:凡进入 resolved config 的字段,
  改了值就会变指纹;只有被 app.config.js **覆写 / 剥离、传不到 resolved config** 的值才指纹
  中性(如自建线的 `updates.url` 被占位覆盖)。改动前后可用仓内 `@expo/fingerprint` 比对
  (见 `scripts/ci-fingerprint.mjs`)。
- 除 config 外,这些也是指纹输入:`apps/mobile/package.json` 的依赖与 `scripts`、
  `eas.json` 的 production 段(`beta-*` profile 由 `fingerprint.config.cjs` 剔除)、
  `plugins/`、`modules/` 下的原生模块、`fingerprint.config.cjs` 自身,以及原生依赖版本变化
  (含仅体现在 lockfile 上的传递依赖)。
- **EAS 账号绑定与凭据不入仓**:`owner` / `extra.eas.projectId` / `updates.url` 及 provider
  凭证由**构建期环境变量**注入(`EAS_OWNER` / `EAS_PROJECT_ID`,provider secrets 走 EAS
  environment / 自建区域配置),仓库留空,外部使用者用自己的 Expo 项目(`eas init`)填 env。
  因为哈希的是 resolved config,发布环境注回**相同值**时逐字节不变 → 指纹不变、不冷更;缺省
  (dev / fork)则不带账号绑定、不配 OTA。变量清单见 `apps/mobile/.env.example`。

## 边界

本文只覆盖本地开发、调试和验证。商业发布、版本分发、签名与渠道运维属于维护者内部
流程，不在公开仓库文档或 Agent 手册中维护。
