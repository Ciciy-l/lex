# Fast 请求与实际处理档位

在新任务或任务输入框的模型选择器中，打开模型行的「自定义」可开启 Fast。默认关闭，旧任务的显式选择保留。服务档位 Fast 不降低推理强度、不替换型号，也不保证固定提速；供应商可能接受、忽略或拒绝请求，实际速度与计费由供应商决定。xAI 的型号切换另见下表。

Lex 0.1.13 区分三个事实：CatalogModel.supportsFastMode 保留供应商实报，modelSupportsFastMode 判断执行路由能否请求 Fast，响应 service_tier 表达实际处理结果。不能从开关显示推断服务部署、授权或账单。

## 支持边界

| 路径 | 行为 |
| --- | --- |
| Codex 官方订阅与独立账号 | 按该账号原生 service_tiers / additional_speed_tiers 开放，兼容 fast 与旧名 priority。原生动态模型发现保留，明确空数组或仅其它档位不视为支持。 |
| Codex API / 自定义连接 | OpenAI Responses / Chat 兼容路由允许显式请求 Fast，不依赖供应商声明或 GPT 型号前缀；已有供应商无需重新添加。运行时私有目录补充可请求档位，防止 CLI 静默丢弃参数，保留原生提示词、默认档位和上下文。 |
| Pi Responses / Chat 路由 | 按实际序列化协议生成请求白名单，保留 provider/model 身份；接受 fast / priority，发送 priority，不再用供应商声明阻止用户选择。 |
| Claude Code OpenAI 兼容桥接 | 复用已有桥接，允许显式请求服务档位。原生 Anthropic Fast 继续使用原生能力判断，不向不兼容的协议硬塞参数。 |
| xAI | Fast 切换到同账号、同引擎目录中可用的 Fast 型号。兼容两种参数别名，消费后不把服务档位传到公共 xAI API；保留目标型号与账号授权校验。 |
| OMP | 当前没有 Fast 控制契约，不显示可用开关。 |

供应商能力发现仍依次采用 supportsFastMode、supports_fast_mode、supportsServiceTier 中首个合法布尔值；没有显式值才推断档位，缺字段刷新保留已有实报。此规则描述供应商声明，不是兼容路由的 Fast 请求门禁。未修改在线 Model Access、价格、默认型号或认证方式，也未加入 Ultrafast。

## 偏好与宿主生命周期

同一数据所有者、同引擎、同型号的预设可跨来源使用，每次按目标路由的请求能力校正；当前任务保留自己的配置，不随另一个任务的编辑自动改变。不同所有者、不同引擎的偏好隔离。

API 宿主使用当前目录生成不可变的运行时文件；模型集合变化会让后续宿主复用或模型切换重建配置，沿用原生任务历史。控制面与 SSH daemon 不注入本机目录。官方 OAuth 宿主保留原生动态发现，除非智能调配或自定义上下文已经需要固定目录。

device-link 与移动端使用执行端的选择与设置逻辑；旧执行端和 SSH 原生订阅继续以其真实能力为准，不借控制端目录扩大远端支持。没有新增跨端协议或修改移动端原生配置。

## 请求与回执

[OpenAI 官方 Fast 文档](https://developers.openai.com/api/docs/guides/fast-mode)定义服务档位请求与实际响应的区别。Lex Codex adapter 发送 app-server serviceTier=fast，固定 Codex 0.166.0 回带并序列化为 priority，关闭时省略。原生 TUI 与 GUI 经同一任务设置同步。

实际回执中的 fast / priority 均归入 Fast 用量档，default 归标准档。缺少回执的估算不能当作供应商账单或实际提速证明。

验证见 model-providers 的 fastMode.test.ts，以及 Desktop 的 codexFastMode.integration.test.ts、codexCustomContextCatalog.test.ts、modelFastMode.test.ts：覆盖旧配置、声明缺失/false、未知别名、开关、切换、恢复与 xAI 账号隔离。固定 CLI 使用合成目录与 loopback 服务，无真实账号或收费请求，不构成所有第三方服务兼容承诺。
