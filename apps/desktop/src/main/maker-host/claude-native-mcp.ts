import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Logger, ClaudeLocalMcpSources, ClaudeNativeMcpProjection } from '@cindy/maker-core';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import { startCodexHttpBridge, withMcpRouteIdentity } from '../mcp-integrations/codexHttpBridge.js';

/** Local Claude's exact selected SDK servers over the existing authenticated bridge. */
export async function prepareClaudeNativeMcp(
  selected: Record<string, McpServerConfig>,
  sources: ClaudeLocalMcpSources,
  logger: Logger,
): Promise<ClaudeNativeMcpProjection> {
  const { context } = sources;
  if (context.agentKind !== 'claude-code' || !context.sessionId || !context.sessionInstanceId) {
    throw new Error('Native Claude MCP requires a bound task instance');
  }
  const names = Object.keys(selected);
  if (names.length !== Object.keys(sources.factories).length
    || names.some(name => selected[name]?.type !== 'sdk' || !Object.hasOwn(sources.factories, name))) {
    throw new Error('Native Claude MCP sources do not match the selected servers');
  }
  if (!names.length) return { servers: {}, revoke() {}, async dispose() {} };
  const serverFactories: Record<string, () => McpServer> = Object.create(null);
  for (const name of names) {
    let first: McpServerConfig | undefined = selected[name];
    const used = new WeakSet<object>();
    serverFactories[name] = () => {
      const config = first ?? sources.factories[name]!();
      first = undefined;
      if (config.type !== 'sdk' || !config.instance || used.has(config.instance)) {
        throw new Error('Native Claude MCP requires a fresh server per transport');
      }
      used.add(config.instance);
      return config.instance as McpServer;
    };
  }
  // Reuse the audited HTTP transport, but freeze this task's selected factories.
  // The global Codex provider snapshot and SSH's limited tool subset differ.
  const bridge = await startCodexHttpBridge({ serverFactories, logger });
  const token = randomBytes(32).toString('hex');
  const ctx: LiziMcpSessionContext = {
    agentKind: 'claude-code', sessionId: context.sessionId, sessionInstanceId: context.sessionInstanceId,
    workingDir: context.workingDir, vendorOptions: context.vendorOptions,
    ...(context.memoryScopeKey ? { memoryScopeKey: context.memoryScopeKey } : {}),
    ...(context.mcpCallerKind ? { mcpCallerKind: context.mcpCallerKind } : {}),
    ...(context.mcpCallerAttested ? { mcpCallerAttested: true } : {}),
  };
  let generation: number | undefined, revoked = false, disposal: Promise<void> | undefined;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    if (generation !== undefined) bridge.unregisterSessionToken(context.sessionId!, token, generation);
    bridge.unregisterSessionCtx(context.sessionId!, ctx);
  };
  const dispose = () => disposal ??= (async () => { revoke(); await bridge.shutdown(); })();
  try {
    bridge.registerSessionCtx(context.sessionId, ctx);
    generation = bridge.registerSessionToken(context.sessionId, token);
    return { servers: Object.fromEntries(names.map(name => [name, {
      type: 'http' as const, url: withMcpRouteIdentity(bridge.url(name), {
        sessionId: context.sessionId, sessionInstanceId: context.sessionInstanceId,
      }), headers: { Authorization: 'Bearer ' + token },
    }])), revoke, dispose };
  } catch (error) { await dispose(); throw error; }
}
