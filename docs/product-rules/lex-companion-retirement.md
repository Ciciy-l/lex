# Lex 0.1.6：伙伴功能退休与旧资料保留

Lex 0.1.6 移除产品伙伴、伙伴私聊、伙伴群聊、伙伴委派和伙伴专属 routines。桌面、手机、启动恢复、工具注册、IPC、远程资源与消息推送不再提供这些功能。旧伙伴书签和手机深链只重定向到普通入口。

## 保留旧资料

退休不等于删除。数据库 schema、历史 SQL/TypeScript migrations 与已有用户数据保持不变，不做破坏性迁移。旧身份、消息、记忆、文件、附件、目录、排队数据与 routines.json 留在原来的账号存储中；不恢复运行、不改写为普通任务、不启动定时执行。当前版本不提供这些资料的产品阅读或导出入口。

以下任一关系都代表旧伙伴归属，即使 session.source 不是 bot：

- sessions.source = bot
- bot_session_links.session_id
- bot_profiles.canonical_session_id
- bot_delegations.child_session_id

列表、搜索、直接 ID 访问、恢复/发送、共享导出和覆盖导入、消息/媒体回收、工作区回收以及排队恢复均按这一归属拒绝或隐藏。覆盖导入在文件操作前检查捕获账号的数据库，最终事务再次检查；数据库 worker 与内联备用实现保持一致。

定时任务如果 source 为 bot，或 targetSessionId、skipLogSessionId、run.sessionId 关联退休任务，继续保留原行但不对外列出、执行或写回费用。即使只有历史 run.sessionId 体现旧伙伴归属，也保护其父定时任务，避免删除父记录级联清除历史。无法确认归属的孤儿运行记录暂不自动回收。

旧伙伴右侧栏 tab 只隐藏，保留其持久化行。手机缓存识别伙伴归属后不能被迟到的普通快照重新显示；账号退出清除内存归属判断，原磁盘历史不因退休删除。远程入口在执行及回执交付时检查归属，包括批量 ID、离线队列、订阅与缓冲推送。

## 继续支持的普通能力

普通 Agent 任务、Orca Worker 协作、普通定时任务、通用记忆、Skills、插件和模型/供应商配置继续可用。Telegram、Feishu 等 IM bot 与产品伙伴不同，继续保留。Codex browser companion 是浏览器辅助进程；数据库 migration companion 是迁移配套脚本，两者不属于本次退休范围。

已安装插件的批准记录、权限指纹、manifest 和凭证不重置。旧 routine slot 请求返回明确不可用结果；其他 slot 与普通任务能力保持原契约。不得通过升级要求用户重新批准原有插件。

旧主题 Token ID 继续保留以兼容已安装主题，不再有伙伴界面消费者；不能借功能退休删除或改名用户主题字段。

## 验证边界

需要覆盖四种归属的真实数据库与文件保留、普通任务与 Orca 的正向行为、旧深链、迟到回包、多账号、计划任务与媒体清理。组件测试不等于真实产品验收；桌面使用标准隔离启动 wrapper，手机使用标准模拟器入口，各自记录实际验证范围。

本轮实际操作与限制见 [Lex 0.1.6 本地 UI 验收](../design-previews/lex-0.1.6/acceptance.md)。

上游历史说明 [伙伴运行时](cindy-bots-runtime.md) 和 [伙伴群聊](bot-group-chat.md) 只用于理解旧数据，不再定义 Lex 的活动产品功能。
