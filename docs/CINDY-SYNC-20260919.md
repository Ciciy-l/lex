# Cindy 固定快照同步记录：v0.1.86

本轮 Lex 上游同步的 Cindy 目标为 tag `v0.1.86`，其不可变提交为
`40162c508ff10b0f5d3398fd4af5db82dd39f319`。`v0.1.86-beta` 当前也解析到
同一提交；发布与同步判断均以完整提交 SHA 为准，而不是可移动的分支名或 tag
名称。

## 集成与 DCO 边界

将该快照纳入 Lex 时，使用普通 merge；不要 squash 或 rebase 上游历史。这样后续
同步能够可靠识别已整合的 Cindy ancestry。同步本身不创建 Lex 发布 tag，也不发布
安装包或更新清单。

`desktop-release-auto` 的 release eligibility gate 将该 SHA 作为
`--upstream-baseline`。该选项只适用于发布检查：它排除该快照及其祖先的导入历史，
并不为任何上游提交补签、认证 DCO，或放宽普通 PR 的 DCO 要求。快照之后的上游
提交和所有 Lex 提交仍须按常规规则具备有效 sign-off。不要根据此前同步记录推断
本轮的 DCO mismatch 数；以最终 release head 的实际检查输出和 CI 结果为准。

## 本轮纳入的 Cindy 能力

- 纳入远程凭证会话与 macOS 自动解锁。它增加 Mobile 原生模块并改变 runtime
  fingerprint，因此现有 Mobile 安装包必须通过冷更新包升级，之后才能接收包含这项
  能力及其后的 OTA。
- 纳入 Cindy Make 个人工作流。它的受管源始终来自
  `https://github.com/makecindy/cindy.git`，而不是 Lex 仓库；开发版跟随 Cindy `main`，
  打包的 Lex 固定使用本同步的 Cindy `v0.1.86`（beta Lex 优先 Cindy beta tag）。
  `apps/desktop/src/main/cindy-make/upstreamIdentity.ts` 中的
  `CINDY_MAKE_UPSTREAM_VERSION` 是这项显式基线，后续 Cindy 同步必须连同本记录
  一起审查和更新，不能用 Lex app version 推导 Cindy Git tag。

## Lex 产品边界

同步审查保留 Lex 自有的品牌、发布与分发机制，包括产品身份、GitHub Release 与
`updates` 分支清单、Lex 更新端点、结构化版本公告门禁，以及已固定的运行时资产 / CDN
配置。上游改动不得把这些路径、域名、工作流或产品命名回退为 Cindy 的实现。

Lex 的跨平台 OMP 集成也保持独立：本轮没有让 OMP 依赖 Cindy Make、远程凭证或任何
其他现有引擎的内部实现。

上游 Pi 的 `v0.85.1` runtime pin 没有随本轮接入。Lex 的固定 CDN runtime snapshot
目前只包含已审核的 `v0.84.4` 派生产物；在四个平台的 `v0.85.1` 产物完成镜像、摘要
复核并写入该快照前，不能让安装器或更新清单指向上游下载地址。这是有意保留的
发布边界，不是将 Pi 回退到其他引擎或 Cindy 默认更新通道。

插件平台相关的手动发现、市场安装、OAuth 凭证注入和授权链变更未纳入；伙伴运行时／
开发者指令调整（包括 Codex 历史线程恢复）也未纳入。它们需要在未来单独评审，不能因
本次同步被间接启用。

## 验证边界

Desktop、Mobile 与共享 protocol 的 TypeScript 和单元测试按本次改动范围执行。
Windows 主机不能替代 iOS、macOS 或 Android 的原生编译与实机验证；发布前仍须在相应
平台完成原生构建、凭证会话和自动解锁的验证。

完成 merge 后，在创建任何 Lex 发布 tag 前：

1. 在最终 PR head 上通过常规 CI 和人工的 Lex 产品边界审查。
2. 对最终 release head 运行 release-only DCO 检查，并使用完整 SHA
   `40162c508ff10b0f5d3398fd4af5db82dd39f319` 作为 `--upstream-baseline`。
3. 运行 `scripts/__tests__/lex-product-release-baseline.test.mjs`，确认发布工作流仍
   使用该固定基线，且 Lex 的 release / CDN 契约未被上游覆盖。
4. 按 `RELEASING-LEX.md` 验证版本公告、草稿资产和更新清单链路；通过后才创建新的
   SemVer tag。

此前 `CINDY-SYNC-20260905.md`、`CINDY-SYNC-20260910.md` 和
`CINDY-SYNC-20260911.md` 的验证和身份统计只描述各自的快照，保留作为历史证据，
不代替本轮验证。
