# GPT Fast

在新任务或任务输入框的模型选择器中，打开模型行的「自定义」，可为支持的模型开启 **Fast**。默认关闭；旧任务已有的显式选择保留。GPT 的 Fast 是服务档位，不降低推理强度、不替换型号，也不保证固定提速。它可能增加费用或用量，是否接受与实际计费由当前供应商决定。

开关复用现有模型偏好：同一数据所有者下，同引擎、同型号的预设可跨来源使用，但每次都按目标连接的实际能力校正；当前任务保留自己的配置，不随另一个任务的编辑自动改变。不同所有者、不同引擎的偏好隔离。远程任务使用执行端能力和既有设置协议，不借控制端目录扩大支持。

## 支持边界

| 路径 | 行为 |
| --- | --- |
| Codex 的 OpenAI 订阅与独立账号 | 按该账号原生目录的 `service_tiers` / `additional_speed_tiers` 开放，兼容 `fast` 与旧名 `priority`。明确空数组或仅其它档位不视为支持。 |
| Codex 的 API / 自定义连接 | 还需该连接目录与执行路由实际支持；不因型号以 GPT 开头就发送付费参数。固定 CLI 对未声明能力的模型可能不发送该档位。 |
| Pi 的 GPT 路由 | 复用已有 Fast 请求 hook 与模型、provider 白名单；支持的路径使用 `priority` 别名。实际回执中的 `fast` 与 `priority` 均归入 Fast 用量档，`default` 仍归标准档。 |
| Claude Code 的 GPT 桥接 | 沿用已有桥接和连接能力判断，本次未新增原生 Claude CLI 的 GPT 路由。 |
| OMP | 当前引擎未声明 Fast，不显示可用开关。 |

本次只补齐客户端能力发现与回执兼容，没有修改在线 Model Access、模型目录价格、默认型号、引擎版本或认证方式；也未加入 Ultrafast。不能从客户端显示推断外部服务已经部署或某个账号已获准使用。

发现结果中的显式布尔能力优先于档位推断：依次采用 `supportsFastMode`、`supports_fast_mode`、`supportsServiceTier` 中首个合法布尔值。明确 `false` 不会被 Fast 档位覆盖，明确 `true` 也不会被空档位列表关闭；非布尔值不作为能力声明。没有合法显式值时才参考有效档位列表，缺字段刷新保留已有实报，恢复的 Fast 偏好仍受目标连接能力约束。

## 请求与实际结果

[OpenAI 官方 Fast 文档](https://developers.openai.com/api/docs/guides/fast-mode)规定 Responses / Chat Completions 使用 `service_tier: "fast"`，支持模型上 `priority` 为同义值；响应的 `service_tier` 才是实际处理档位，可能降为 `default`。GPT-5.6 及更早模型可返回旧名 `priority`。

Lex 的 Codex adapter 使用 app-server 的 `serviceTier: "fast"`；固定 Codex 0.162.1 在声明 Fast 的隔离目录下实际序列化为 `service_tier: "priority"`，关闭时省略。原生 TUI 和 GUI 继续经同一任务设置同步。服务档位选择、运行时确认和供应商回执是不同事实：有实际回执的路径按回执记录，缺少回执的估算不能当作供应商账单或实际提速证明。

验证使用生产设置/目录/用量单测及固定 CLI + 合成目录 + loopback 服务，无真实账号或收费请求。模型名称仅为测试 fixture，不构成所有 GPT 或第三方代理的兼容承诺。
