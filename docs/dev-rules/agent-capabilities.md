# Lex 当前任务的能力目录

通过既有 cindy_helper get_capabilities 的 runtime 查询读取当前任务注册的工具服务。
registered 仅表示入口条件满足，不保证服务连接或具体调用成功。

- 内置服务沿实际注册 schema 和渐进式目录读取，不调用业务工具。
- 插件沿 ghost_info / ghost_list / ghost_call 实时发现和授权，清单不是调用授权。
- 自定义 MCP 只询问当前任务引擎已有的连接，不另起进程、不读取或回传连接地址和凭据。

Codex 使用带当前 threadId 的 mcpServerStatus/list，不拿共享进程的清单代替任务状态；
Claude Code 使用当前 SDK query 的 mcpServerStatus。空工具、未挂载、需要认证、启动中、
失败和停用分别报告。读取失败或超时返回 HARNESS_DISCOVERY_FAILED，不透传引擎原始错误。

Pi、OMP、SSH 远端 Claude 或远程 Agent 没有此宿主查询入口时，明确返回
HARNESS_DISCOVERY_UNAVAILABLE；这不代表它们原生工具或 MCP 网关不可用，也不额外建立
探测连接。OMP 的原生 MCP、Pi 的已有网关保持各自工作方式。

主机查询前后核对调用 Session 仍为活跃实例。账号、权限、服务区及远程工作目录边界不变。
引擎原生文件、命令行和子代理不混入 MCP 工具计数，也不能以此目录判断全部原生能力。

回归入口：agentCapabilityCatalog.test.ts、maker.test.ts 的 Session engine MCP tool status，
以及 Claude Code/Codex 的 mcp-server-tools.test.ts。未使用真实连接的测试不等于外部服务已连通。
