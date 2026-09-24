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

## 后续候选

- SSH Codex 路由：待单独进行四引擎专题评估。
- 模型目录：单独核对 Lex 离线目录与服务端目录治理，不随上游模型信息自动同步。上游 62400c804 删除自定义 CC/Codex 的 CUSTOM_EFFORTS 并压缩出站 effort；本轮刻意不合入，Lex 未声明能力的自定义 CC/Codex 模型仍默认提供五档（默认 medium），用户显式 reasoningEfforts 仍优先，避免自定义供应商模型失去可选推理等级。OMP/Pi 仅保留用户显式声明的能力，不套用通用五档。
- SkillHub 对话管理：目前明确排除。
- 插件远程授权：远程 OAuth／私密卡目前明确排除；未来先专项审查授权、凭证与执行隔离。
