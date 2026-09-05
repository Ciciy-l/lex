# Cindy 固定快照同步记录：1857e28e6

本轮将 Cindy `1857e28e60effe9dc04d910d67e807ea166308ad` 以普通 merge
集成到 Lex，供独立草稿 PR 审阅。不要 squash 或 rebase 此同步提交；保留上游
ancestry，后续同步才能正确识别已经纳入的历史。同步流程见
[RELEASING-LEX.md](RELEASING-LEX.md#upstream-synchronization)。

## Lex 与 Cindy 的边界

- Lex 保留独立产品图像、名称、App/Bundle ID、数据目录和 GitHub 更新源。
- Cindy 账号、订阅、远程服务及 `.cindy` 插件生态继续兼容；账号 realm
  由运行期选择，不能重新绑定为安装包的国内/国际构建身份。
- 保留右侧 CLI 工作台的独立 PTY、分屏、Shell/Claude/Codex/Pi 启动入口。
- 保留非标准 Git 安装路径的 shell 探测，并与上游 Pi native packages 设置
  合并；用户显式 shell 优先，SSH 不传播本机 shell 路径。
- 上游模型、权限、数据库、登录和更新器修复保留；本轮没有调整服务器、
  创建发布标签或分发安装包。

## 集成适配

30 个冲突文件均已逐项处理。主要适配包括账号注销 tombstone 与 realm/vault
合并、登录状态超时回退保留 realm、Pi packages 与 shell 的投影和运行期刷新、
用量事件拆分、登录/关于页面的 Lex 品牌，以及 Windows Runtime 恢复与 Linux
beta 更新路径。Lex 更新 manifest 同时保留旧 `codex` 和新 `codexPackage`
字段，并新增消费方/发布方的契约检查。

全量测试发现的自动合并遗漏也已修复：恢复 Kimi Chat Completions 测试的上游
SSE helper；更新产品名称、正式 profile、更新器文件名和主题名称的测试夹具。
主题快照仅把名称改为既有 Lex Light/Dark，颜色和主题 ID 未变。

插件安装/启停/技能挂链的存量影响：无。`.cindy` 包布局、安装 receipt、
内容指纹和既有审批记录未改动，无需重装或新增数据迁移。网络边界新增
仅限 HTTPS `image` 资源；HTTP、XHR/fetch、脚本与其他资源仍受原有拒绝规则
约束。第三方图片服务器可见 IP 和完整图片 URL，URL 不应携带凭证或隐私
数据。仓内 `cindy-brain/forge.ts` 的 `FORGE_GUIDE` §4、§4.8、§6 已同步。
对应回归包括 `electronSandboxAdapter.ownerPartition.test.ts`、
`ghostFiles.test.ts`、`GhostManager.test.ts` 的无 receipt 旧布局升级/技能挂链
场景及 `forge.test.ts` 的手册契约，均由本轮 Desktop unit 覆盖。

## 本地验证

环境为独立 worktree `sync-cindy-20260905`、Windows x64、Node 22.22.3、
pnpm 10.33.2；没有借用主 checkout 的 node_modules 或正式用户数据库。

| 检查 | 结果 |
| --- | --- |
| Frozen lockfile 依赖安装 | 通过 |
| `pnpm test:unit:related` | 因依赖/测试基础设施变化自动退回全量 unit；全部 workspace 通过 |
| `pnpm -r --workspace-concurrency=2 run --if-present typecheck` | 通过，包括 Desktop、Mobile 及定义该脚本的 packages |
| 品牌术语、i18n、glossary、endpoint guards | 通过；保留原有翻译/glossary 警告 |
| 数据库静态校验与历史 migration replay | 通过；replay 6 项，仅使用临时数据库 |
| 0100、0101 与 CJK TEMP trigger 专项 | 通过 |
| 第三方 notices/SBOM 与 design inventory | 已重新生成；runner 门禁通过 |
| Desktop 安全启动包装 | `DESKTOP_DEV_VERDICT=ready` |
| 完整导入范围的本地 DCO 自查 | 81 条上游提交的 author 与 trailer 身份不匹配；待 DCO App 与维护者核对 |

### Desktop 实测与证据

通过根 restart wrapper 启动，参数为 `--region=global`、
`--isolated=sync-cindy-20260905-qa`、`--isolated-auth`、`--passive`。
使用本机 loopback 端点 fixture、已有登录 provider fixture 和无模型账号，
没有进行真实云端登录或付费模型调用。

- 登录页：Lex 图像/字标、Cindy 服务区说明，Light/Dark 均已截图。
- 关于：联系 Lex 占位、Cindy 法律与社区条目默认折叠，Light/Dark 均已截图。
- 工作台：通过既有草稿 store 在测试沙箱中选定本 worktree，再使用实际右栏
  UI 打开终端。两个 PowerShell PTY 分别返回 `LEX_SYNC_PTY_OK` 和
  `LEX_SPLIT_PTY_OK`；左右分屏、50%→55% 的键盘比例调整与关闭单个窗格已检查。
- 图片不进入 Git。本地证据索引为 `out/sync-desktop-evidence/index.html`，
  原始 PNG 在同目录；提交者应将这些证据上传为 PR 附件或 artifact 后再转 Ready。
- CDP 截取的是 renderer；Windows acrylic 的透明区域不等同桌面合成结果，
  仍需实际窗口视觉复核，不能据此宣称所有平台视觉验收完成。

## 合并前仍需处理

1. 本轮 merge commit 正常 DCO sign-off；保留上游 SHA，不改写上游作者，也不
   冒用作者签名。完整范围的 DCO 自查结果与 GitHub DCO App 结果应单独核对。
2. 由指定把关人完成插件基础层、iOS 冷更和视觉复审。用户已同意本轮风险范围，
   不等于所有平台实机验证或指定角色复审已完成。
3. 本轮未执行 macOS 构建/安装/自更新、iOS 原生构建/真机验证、真实 Cindy
   CN/Global 云端账号切换、真实模型 turn/cache-rate 实测或发行版升级回归。
4. Windows/其他平台 CI 必须对最终完整 head SHA 通过；本地通过不代替 CI。

## 原生指纹与回滚

使用 fingerprint tool 0.20.10 比较 Lex main 与合并结果：

| 平台 | 基线 | 合并结果 |
| --- | --- | --- |
| iOS | `139270bb5eb9767f8933c6c05900eea9f4717abe` | `08838240438b33386e66d6fec277c3e4e183b20f` |
| Android | `179536d52b4270d36949cf10c5ac9824889122c0` | `179536d52b4270d36949cf10c5ac9824889122c0` |

iOS 的 `apps/mobile/modules/xdt-screenshot-monitor/ios/XdtScreenshotMonitorModule.swift`
修改了 WKWebView 导出所需的宿主 UIWindow、分块截图/合成与清理逻辑，要求
新的原生 runtime，不能用旧 fingerprint 的 OTA
冒充兼容升级。存量安装应继续留在原 runtime 对应渠道；建议独立安排 iOS
冷更与安装/升级验收，不与本轮桌面同步直接绑定发版。Android 指纹未变化，
但这不代替 Android 实机验证。

代码可通过 `git revert -m 1 <upstream-merge-commit>` 撤销本轮集成；撤销
代码不能反向迁移已升级的 SQLite 数据库。测试和回滚使用独立 profile 或
升级前备份，禁止手改冻结 migration、删除用户数据或复用旧原生 runtime
发布不兼容 OTA。若未来重新纳入已 revert 的上游 merge，需明确设计恢复
提交，不能期望 Git 再次自动引入同一批历史。
