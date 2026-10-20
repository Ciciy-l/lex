import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';
import type { ClaudeLocalMcpSources, ClaudeNativeMcpProjection, Logger } from '@cindy/maker-core';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { prepareClaudeNativeMcp } from '../claude-native-mcp.js';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function server(name: string): McpServer {
  const mcp = new McpServer({ name, version: '1.0.0' });
  mcp.tool('context', 'Return the host-bound fixture context.', {}, async () => ({ content: [{
    type: 'text' as const, text: JSON.stringify(getLiziMcpSessionContext()),
  }] }));
  return mcp;
}
async function fixture(instance = 'instance') {
  const names = ['cindy_helper', 'cindy_memory', 'custom__server', '__proto__'];
  const selected = Object.fromEntries(names.map(name => [name, { type: 'sdk' as const, name, instance: server(name) }]));
  const sources: ClaudeLocalMcpSources = { context: { agentKind: 'claude-code', sessionId: 'task', sessionInstanceId: instance,
    workingDir: '/fixture', memoryScopeKey: 'memory-scope', mcpCallerKind: 'root', mcpCallerAttested: true, vendorOptions: { version: 1 } },
    factories: Object.fromEntries(names.map(name => [name, vi.fn(() => ({ type: 'sdk' as const, name, instance: server(name) }))])) };
  const binding = await prepareClaudeNativeMcp(selected as Record<string, McpServerConfig>, sources, logger);
  cleanups.push(binding.dispose);
  return { selected, sources, binding, names };
}
function http(binding: ClaudeNativeMcpProjection, name = 'cindy_helper') {
  const config = binding.servers[name]!;
  if (config.type !== 'http') throw new Error('Expected host HTTP projection');
  return config;
}
async function connect(binding: ClaudeNativeMcpProjection, name?: string) {
  const config = http(binding, name), client = new Client({ name: 'lex-native-fixture', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  await client.connect(transport); cleanups.push(() => client.close()); return client;
}
async function rpc(config: ReturnType<typeof http>, url = config.url, headers = config.headers) {
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} } }) });
  await response.text(); return response.status;
}

describe('native Claude task-bound MCP bridge', () => {
  it('keeps every selected name and binds real tool calls/reconnects to the same live task context', async () => {
    const f = await fixture(); expect(Object.keys(f.binding.servers)).toEqual(f.names);
    for (const name of f.names) {
      const client = await connect(f.binding, name);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['context']);
      const result = await client.callTool({ name: 'context', arguments: { sessionId: 'spoofed' } });
      expect(JSON.parse((result.content as any)[0].text)).toMatchObject({ agentKind: 'claude-code', sessionId: 'task',
        sessionInstanceId: 'instance', workingDir: '/fixture', memoryScopeKey: 'memory-scope', mcpCallerKind: 'root', mcpCallerAttested: true });
      expect(f.sources.factories[name]).not.toHaveBeenCalled();
    }
    f.sources.context.vendorOptions!.version = 2;
    const reconnected = await connect(f.binding);
    expect(f.sources.factories.cindy_helper).toHaveBeenCalledOnce();
    expect(JSON.parse(((await reconnected.callTool({ name: 'context', arguments: {} })).content as any)[0].text).vendorOptions.version).toBe(2);
  });

  it('refuses foreign tokens and task/instance routes, and retiring one generation leaves its replacement working', async () => {
    const old = await fixture('old'), current = await fixture('current');
    const config = http(old.binding), changed = new URL(config.url);
    changed.searchParams.set('session', 'another-task'); expect(await rpc(config, changed.toString())).toBe(401);
    changed.searchParams.set('session', 'task'); changed.searchParams.set('instance', 'current');
    expect(await rpc(config, changed.toString())).toBe(401);
    expect(await rpc(config, config.url, http(current.binding).headers)).toBe(401);
    const currentClient = await connect(current.binding);
    old.binding.revoke?.(); expect(await rpc(config)).toBe(401);
    await old.binding.dispose(); await old.binding.dispose();
    expect(JSON.parse(((await currentClient.callTool({ name: 'context', arguments: {} })).content as any)[0].text).sessionInstanceId).toBe('current');
  });

  it('rejects incomplete ownership and mismatched selected factories before creating a bridge', async () => {
    const sources: ClaudeLocalMcpSources = { context: { agentKind: 'claude-code', workingDir: '/fixture', sessionId: 'task' }, factories: {} };
    await expect(prepareClaudeNativeMcp({}, sources, logger)).rejects.toThrow('task instance');
    sources.context.sessionInstanceId = 'instance';
    await expect(prepareClaudeNativeMcp({ missing: { type: 'http', url: 'https://example.invalid' } }, sources, logger)).rejects.toThrow('selected servers');
  });
});
