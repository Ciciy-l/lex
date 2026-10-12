# Lex Mobile 品牌、分区与更新接线

本轮基于 Lex main `389801e7ae728d1c0c57af7c3f37b187ee1479b9`。变更聚焦移动端
产品身份、个人登录分区、Lex 自有链接与 Android APK 更新；不扩展伙伴、推送服务、
第三方 OAuth 注册或远程 Harness 全量设置。

## 四引擎接线审计

| 路径 | 当前能力与边界 |
| --- | --- |
| `apps/mobile/src/device-link/mobileMakerTransport.ts` | `MOBILE_AGENT_KINDS` 已包含 claude-code/codex/pi/omp；创建任务保留引擎、模型、provider、effort、权限与 fast 字段，通过既有远程宿主执行。 |
| `apps/mobile/app/sessions/new.tsx` | 新建任务接受四引擎，模型由所连接电脑的能力和供应商目录决定。手机不安装本地 Harness。 |
| `apps/mobile/app/sessions/[sessionId].tsx` | 已有任务通过 `sessionAgentSwitchSupported` 控制跨引擎选择；不支持切换的宿主只展示当前引擎。 |
| `apps/mobile/src/session/mobileModelPreferences.ts` | 偏好接受 OMP；账号与设备 scope 继续隔离，本地偏好不替代宿主模型目录。 |
| `apps/mobile/src/session/agentAuthGate.ts`、`device-link/remoteStatus.ts` | 四引擎鉴权失败已有识别和提示。认证、安装及运行时版本维护仍在电脑端完成。 |

因此此次无需新增跨端命令或放宽 allowlist。Harness 的自定义提示词、记忆、Subagent、
压缩与版本升级继续在电脑端设置；手机控制的任务沿用宿主配置。以上是源码审计，
不代表已完成四引擎真实账号/真机联调。

## 视觉与品牌

- 登录立绘、开屏及分享图标收录于 `apps/mobile/assets/lex/`，分别原样复用桌面端
  `apps/desktop/src/renderer/assets/branding/lex-assistant-hero.png` 与
  `apps/desktop/resources/icon-master-1024.png`。Lex 亮/暗字标 PNG 来自既有桌面 SVG。
  移动端打包只引用自身资源目录，避免 EAS 排除桌面目录后丢失图片；更新品牌图片时需同步
  这两份移动端副本。兼容存储键、包名和 deep link 不改。
- `lexNativeSplashBackground` 位于 Mobile token 正本 `src/theme/tokens.ts`，与 Lex
  config plugin 的原生启动图背景匹配：Light 白色、Dark 深灰。上游开发构建旧 token 保留。
- 分区选择复用语义颜色、pill 圆角及不小于 44px 点击目标；更新页复用 SettingsGroup
  与标准行组件。遵循 DESIGN.md §2/§3/§4/§5/§8/§10，双主题均实现。
- Cindy 账号、服务区和协议继续标明服务提供方；未配置统计服务时隐藏无效开关，
  Lex 不显示上游备案号。设备引导明确同账号、同服务区与远端引擎归属。

## 验证与发布边界

新增回归覆盖更新清单、版本排序、检查/提醒间隔、渠道变化、下载取消、权限返回、
校验失败、渠道发布单调性、已保存账号 realm 与登录切区接线。发布说明和操作步骤见
[RELEASING-LEX.md](../RELEASING-LEX.md)。本轮按用户要求不在本地运行测试、类型检查
或构建，由 PR CI 执行。

未进行 Android/iOS 实机、Light/Dark 目检、真实 CN/Global 登录、OAuth 唤起、
签名 APK 覆盖安装。首个含更新器的 APK 需手动安装；以后更新仍经用户下载与系统确认。
原生模块、安装权限和品牌配置会改变 runtime fingerprint，须按 Mobile 冷更规则
在合并前由把关人确认；本 PR 不自动合并或发版。
