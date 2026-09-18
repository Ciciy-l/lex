/**
 * orca/index.ts
 *
 * Barrel export for the cindy_orca MCP server —— 多 worker 协同(Orca team)控制
 * 工具集。从 cindy_helper 拆出独立成 server, 让"协同模式"成为用户可关的插件。
 * 详见 server.ts 顶部说明。
 */

export {
  createOrcaMcpServer,
  createOrcaOmpRpcHostTools,
  type OrcaMcpDeps,
  type OrcaMcpSessionCtx,
} from './server.js';
