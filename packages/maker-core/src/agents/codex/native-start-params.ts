import type { ThreadStartParams, DynamicToolSpec } from './app-server/protocol.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Preserve the original TUI executor; all route/prompt/permission fields remain Core-owned. */
export function mergeCodexNativeThreadStart(owned: ThreadStartParams, native: Record<string, unknown>, configuredServers: ReadonlySet<string>): ThreadStartParams {
  const config = { ...owned.config };
  if (native.config != null) {
    if (!record(native.config)) throw new Error('Invalid native frontend configuration');
    for (const [key, value] of Object.entries(native.config)) {
      if (key !== 'mcp_servers.codex_tui' && key !== 'mcp_servers.codex_worktrees') continue;
      const namespace = key.slice('mcp_servers.'.length);
      if (configuredServers.has(namespace) || Object.hasOwn(config, key)) throw new Error('A configured MCP server owns the native TUI namespace');
      if (!record(value) || typeof value.url !== 'string') throw new Error('Invalid native TUI MCP executor');
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) {
        throw new Error('Native TUI MCP executor must be local');
      }
      config[key] = structuredClone(value);
    }
  }
  const tools = [...(owned.dynamicTools ?? [])];
  if (native.dynamicTools != null) {
    if (!Array.isArray(native.dynamicTools)) throw new Error('Invalid native dynamic tools');
    const names = new Set(tools.map(tool => tool.name));
    for (const tool of native.dynamicTools) {
      if (!record(tool) || typeof tool.name !== 'string' || names.has(tool.name)) throw new Error('Conflicting native dynamic tool');
      names.add(tool.name); tools.push(structuredClone(tool) as unknown as DynamicToolSpec);
    }
  }
  return { ...owned, ...(Object.keys(config).length ? { config } : {}), ...(tools.length ? { dynamicTools: tools } : {}) };
}
