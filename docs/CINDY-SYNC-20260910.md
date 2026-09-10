# Cindy 固定快照同步记录：v0.1.76

本轮 Lex 上游同步的 Cindy 目标为 tag `v0.1.76`，其不可变提交为
`0d1a5c7da95e22a1215dc5ad637bf60549453ee8`。`v0.1.76-beta` 当前也解析到
同一提交；发布与同步判断均以完整提交 SHA 为准，而不是可移动的分支名或 tag
名称。

## 集成与 DCO 边界

将该快照纳入 Lex 时，使用普通 merge；不要 squash 或 rebase 上游历史。这样后续
同步能够可靠识别已整合的 Cindy ancestry。同步本身不创建 Lex 发布 tag，也不发布
安装包或更新清单。

`desktop-release-auto` 的 release quality gate 将该 SHA 作为
`--upstream-baseline`。该选项只适用于发布检查：它排除该快照及其祖先的导入历史，
并不为任何上游提交补签、认证 DCO，或放宽普通 PR 的 DCO 要求。快照之后的上游
提交和所有 Lex 提交仍须按常规规则具备有效 sign-off。不要根据此前同步记录推断
本轮的 DCO mismatch 数；以最终 release head 的实际检查输出和 CI 结果为准。

## Lex 产品边界

同步审查必须保留 Lex 自有的发布与分发机制，包括 Lex 产品身份、GitHub Release
与 `updates` 分支清单、Lex 更新端点、结构化版本公告门禁，以及已固定的运行时资产
/ CDN 配置。上游改动不能把这些路径、域名、工作流或产品命名回退为 Cindy 的实现。
同时保留 Cindy 服务、协议和历史数据的兼容标识；品牌适配不能破坏既有账户、插件
或安装数据的互操作性。

## 后续验证

完成 merge 后，在创建任何 Lex 发布 tag 前：

1. 在最终 PR head 上通过常规 CI 和人工的 Lex 产品边界审查。
2. 对最终 release head 运行 release-only DCO 检查，并使用完整 SHA
   `0d1a5c7da95e22a1215dc5ad637bf60549453ee8` 作为 `--upstream-baseline`。
3. 运行 `scripts/__tests__/lex-product-release-baseline.test.mjs`，确认发布工作流仍
   使用该固定基线，且 Lex 的 release / CDN 契约未被上游覆盖。
4. 按 `RELEASING-LEX.md` 验证版本公告、草稿资产和更新清单链路；通过后才创建新的
   SemVer tag。

此前 `CINDY-SYNC-20260905.md` 的验证与身份统计只描述它自己的快照，保留作为历史
证据，不代替本轮验证。
