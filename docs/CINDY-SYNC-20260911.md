# Cindy 固定快照同步记录：v0.1.79

本轮 Lex 上游同步的 Cindy 目标为 tag `v0.1.79`，其不可变提交为
`abcf92c2b34e99209e505662a3fe4e11868e8aa1`。`v0.1.79-beta` 当前也解析到
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

同步审查保留 Lex 自有的发布与分发机制，包括产品身份、GitHub Release 与 `updates`
分支清单、Lex 更新端点、结构化版本公告门禁，以及已固定的运行时资产 / CDN 配置。
上游改动不得把这些路径、域名、工作流或产品命名回退为 Cindy 的实现。

本轮还把上游的 Bot capability discovery、系统提示词集成、例行任务和移动端原生
远程桌面一并纳入。远程桌面特权 helper 使用 Lex 的 macOS bundle id、Windows 主进程
白名单以及服务/命名管道命名空间，避免与同机 Cindy 安装混用；Cindy 的服务端协议、
账户 realm 和兼容标识保持不变。

## 后续验证

完成 merge 后，在创建任何 Lex 发布 tag 前：

1. 在最终 PR head 上通过常规 CI 和人工的 Lex 产品边界审查。
2. 对最终 release head 运行 release-only DCO 检查，并使用完整 SHA
   `abcf92c2b34e99209e505662a3fe4e11868e8aa1` 作为 `--upstream-baseline`。
3. 运行 `scripts/__tests__/lex-product-release-baseline.test.mjs`，确认发布工作流仍
   使用该固定基线，且 Lex 的 release / CDN 契约未被上游覆盖。
4. 按 `RELEASING-LEX.md` 验证版本公告、草稿资产和更新清单链路；通过后才创建新的
   SemVer tag。

此前 `CINDY-SYNC-20260905.md` 与 `CINDY-SYNC-20260910.md` 的验证和身份统计只描述
各自的快照，保留作为历史证据，不代替本轮验证。
