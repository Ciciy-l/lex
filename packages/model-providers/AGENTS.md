# 模型目录维护入口

新增模型或修改窗口、价格、推理档位、默认值之前，先读
[`../../docs/dev-rules/model-catalog-maintenance.md`](../../docs/dev-rules/model-catalog-maintenance.md)。

本包的内置目录是 Lex 客户端兜底；在线 Cindy Model Access 是外部来源，本仓不维护其 Server 仓库或部署。先核对目录接口、
当前生效的 registry revision 与实际路由，再决定是否只修改随包目录及客户端兼容代码。Pi 原生目录有独立来源；账号发现只可使用已存在的 Pi 传输，不从订阅 Registry 推导新路由。
