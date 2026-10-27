# Cindy 上游差异与选择性移植记录

本文持续记录 Lex 与独立 Cindy 上游仓库的差异、移植决策及未纳入候选。每轮以明确指定的上游 tag／提交和 Lex 现有架构为准，只移植行为与必要测试，不整体合并上游分支。

## v0.1.92 选择范围

本轮基线为 Cindy v0.1.91-beta 到 v0.1.92 的最终树。按 Lex 既有架构适配并纳入：

- 1b4ef81bb：补齐四引擎工具循环检测，特别保留 OMP partial 与完成事件语义边界。
- c7186a37a：Pi 冷会话切模时避免不必要的窗口核实。
- cfe22c1a9：切换 Harness 配置后模型菜单保持展开，处理 OMP pending/runtime 显示边界。
- b4677742c：Mobile 会话列表隐藏 Orca Worker 会话。
- 5e7345895：插件下载校验边界与错误提示。
- 9524fe151：本轮不需额外改动插件 manifest 源码；现有协议测试已验证 v3 未知顶层字段保留（packages/plugin-protocol/src/__tests__/manifest.test.ts），安全规则明确未知声明不展示、不授权、不阻止安装，v2 未知 slot 也不提供运行时能力（docs/dev-rules/plugin-security-and-authoring.md）。

本轮暂缓：c3abdc9fe Android 伙伴导航。Lex 当前只有只读伙伴消息路由，没有上游 CompanionHeader／CompanionNavigationDrawer 及其被 Android 裁切的树内抽屉；不把首页系统菜单错误复用为伙伴导航，后续由产品单独评估 Lex 适配交互。

其他排除：共享任务及其 0114 migration（含 e2dd262c6 静态 media guard）、插件远程 OAuth／私密卡、Cindy Make、个人版标识与品牌视觉、SkillHub 对话管理、SSH Codex 路由、Pi 订阅发现及未知图片能力默认、模型价格与思考档位更新。不得改变 Lex OMP／SSH／四引擎平等、品牌、数据／协议／安全／更新路径。

## 0.1.12 选择性适配（2026-10-27）

- 消息引用去重与预算保护参考 [Cindy 5ed1aa4f](https://github.com/makecindy/cindy/commit/5ed1aa4f3ef59dc8b52cf2e6721cd53a2257257c)。
  Lex 仅合并同来源设备、同任务、同消息且完整正文一致的重复引用；保留每处引用身份和当前指令。
  已在正文完整展开的锚点不再重复放入补充历史，同文的其它消息仍保留。失效位置、缺失正文和
  截断引用不参与去重。桌面本地、控制端出方向和手机发送／追加沿既有授权历史读取链执行。
  补充历史仍共享 20 条／约 8k token 预算，按最终 JSON（含转义与元数据）核算，优先裁剪
  邻近消息，必要时才裁剪选中消息；不改变 system 前缀、附件、原始持久消息或原生输入身份。
  实现与回归见 maker-shared 的 agentInputProjection、Desktop sessionReferenceResolver 和
  Mobile sessionReferences。本轮未整体合并上游，也未引入伙伴功能。

## 后续候选

### v0.1.108 已选行为与 Lex 适配（2026-10-15）

本轮对照 Cindy v0.1.104 `ebf092dc3fb9dfa3ad25b10258979c0bcd396634` 至
v0.1.108 `c950b504649f2c64668c618320c352d159370961`，在 Lex
`0db3bd88e9a357e9986fab958a25d0f8bf54354f` 上选择性适配。此前 v0.1.92
记录不表示 Lex 此后从未同步；本轮也不表示整体追平 v0.1.108。

| 行为 | 上游依据 | Lex 保留与补充 |
| --- | --- | --- |
| 自动 fallback 保持 Codex wire；未知思考档不伪造低档 | PR5296 / PR5780，`8c2c3d1a3`、`74238adcd`、`935c85554` | 按精确渠道及模型路由判定，缺失来源不猜别名；明确 null 优先，live 值优先于暂时缺失的目录；发送不补默认档，恢复推荐失败保留原偏好 |
| 排队消息保留仍被引用的附件 | PR5862，`232169b77` | 适配 Lex 永久媒体仓和 ledger；逐附件转移引用所有权，清理前读取最新 owner；保留持久化、账号变化与失败补偿边界 |
| 定时任务自动恢复失败释放阻塞；空终稿不重复输出 | PR5951 / PR5282，`85a1c247a`、`002ca0a29` | 保留任务轮次围栏和四引擎终态语义；未引入未选模型时继承默认的新产品行为 |
| 手机任务正文与重连连续性 | PR5913 / PR5897，`9adfed258`、`48c93ae9d`、`4c1554ecb`、`c6682dc94`；`0cf6562d4`、`118a91911`、`02d5f32a4`、`62d0c54df` | 已打开定时任务按普通任务保留；隐藏任务限窗但保护本地待发送内容；弹层关闭退订键盘；重连有界补页并保留代次检查；Windows/UNC 比较去重不改 POSIX 语义 |
| Pi 原生窗口缓存与版本绑定 | PR5532 / PR5890，`e462fcc12`、`540f5c944` | 缓存绑定启动时的 Pi 路径及 provider/model；旧会话不读新版探测结果，SSH 不读本机缓存；保留 Lex Pi 1.2.0 原生压缩和用户工作预算 |
| Skill 异常路径与扫描隔离 | PR5858，`2ef84d5e6`、`9d666e611` | ENOTDIR 保留用户文件并继续检查其它根；有界 utility process 同等接入 OMP；列表只读，Main 保留账号、代次、授权快照与最终文件变更校验 |
| 长语音与伙伴设置关闭 | PR5827 / PR5971，`ebded1721`、`928e9d48a` | 两端分别限制流、事件和正文；伙伴及群抽屉修复 no-drag |

供应商渠道表单是 Lex 自有改进：协议分组、当前渠道编辑、固定头尾、窄窗列表/详情，
专用表单往返保留草稿；发现/测试只校验当前渠道，保存定位第一个无效渠道。旧预设、
专用 OAuth/云配置、渠道身份、凭证隔离与 CAS 不由上游旧表单覆盖。详见
[渠道合同](dev-rules/provider-protocol-channels.md)和
[本地界面验收](design-previews/provider-protocol-channels/acceptance.md)。

未纳入：Goal/定时任务默认模型语义、旧 Codex 历史恢复、worktree 回收、插件实例/作品库
迁移、远端收藏、远控压缩协议、原生框架/更新器、上游模型目录和价格、速度统计重做。
也未同步本轮未选中的工具循环、网关搜索、图片展示与浏览器行为。四个引擎 pin 保持
Claude Code 2.1.296、Codex package 0.162.1、Pi 1.2.0、OMP 18.10.4。

本轮用户明确要求本地测试与本地 UI 验收，取代先前发行任务的 CI-only 限制；真实环境与
未验证边界按本轮证据记录，不能把历史 CI、静态审阅或测试替身当成设备验收。

### 仍需独立评估

- SSH Codex 路由：待单独进行四引擎专题评估。
- 模型目录：单独核对 Lex 离线目录与服务端目录治理，不随上游模型信息自动同步。上游 62400c804 删除自定义 CC/Codex 的 CUSTOM_EFFORTS 并压缩出站 effort；本轮刻意不合入，Lex 未声明能力的自定义 CC/Codex 模型仍默认提供五档（默认 medium），用户显式 reasoningEfforts 仍优先，避免自定义供应商模型失去可选推理等级。OMP/Pi 仅保留用户显式声明的能力，不套用通用五档。
- SkillHub 对话管理：目前明确排除。
- 插件远程授权：远程 OAuth／私密卡目前明确排除；未来先专项审查授权、凭证与执行隔离。
