import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpProvider, McpProviderContext } from '../../interfaces/mcp-provider.js';

export interface ClaudeLocalMcpSources {
  /** The same live per-task context captured by the SDK provider instances. */
  context: McpProviderContext;
  /** Reconnects need new instances; a connected MCP server cannot be reused. */
  factories: Record<string, () => McpServerConfig>;
}

export function prepareClaudeLocalMcp(options: {
  providers: readonly McpProvider[];
  context: McpProviderContext;
  makerMemoryEnabled: boolean;
  remote: boolean;
  onDuplicate(name: string): void;
}): { servers: Record<string, McpServerConfig> | undefined; sources: ClaudeLocalMcpSources } {
  const out: Record<string, McpServerConfig> = Object.create(null);
  const factories: ClaudeLocalMcpSources['factories'] = Object.create(null);
  for (const provider of options.providers) {
    // Remote memory is supplied by the existing SSH bridge, never serialized
    // from an in-process instance. Local selection retains the per-task flag.
    if (provider.name === 'cindy_memory' && (!options.makerMemoryEnabled || options.remote)) continue;
    if (provider.isEnabled && !provider.isEnabled(options.context)) continue;
    // First registration wins: a custom provider must not replace a built-in
    // while inheriting the built-in name's approval policy.
    if (Object.hasOwn(out, provider.name)) { options.onDuplicate(provider.name); continue; }
    const create = provider.toClaudeSdkConfig;
    const config = create?.call(provider, options.context) as McpServerConfig | null | undefined;
    if (!config) continue;
    out[provider.name] = config;
    if (config.type === 'sdk') {
      factories[provider.name] = () => {
        const next = create!.call(provider, options.context) as McpServerConfig | null | undefined;
        if (!next || next.type !== 'sdk') throw new Error('Native Claude MCP transport changed');
        return next;
      };
    }
  }
  // Spread preserves __proto__ as an own key, while retaining SDK compatibility.
  return { servers: Object.keys(out).length ? { ...out } : undefined, sources: { context: options.context, factories } };
}
