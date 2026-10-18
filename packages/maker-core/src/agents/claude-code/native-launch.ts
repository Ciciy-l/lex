import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeLocalSessionLaunch } from './local-session-launch.js';
import type { ClaudeNativeRuntimeOptions } from './native-runtime.js';

type ProcessMcpServer = Exclude<McpServerConfig, { type: 'sdk' }>;
export interface ClaudeNativeMcpProjection {
  servers: Record<string, ProcessMcpServer>;
  dispose(): void | Promise<void>;
}

export type ClaudeNativePreparedLaunch = Pick<ClaudeNativeRuntimeOptions,
  'nativeSessionId' | 'executable' | 'cwd' | 'args' | 'env' | 'hooks' | 'canUseTool' | 'signal'> & {
  /** Call after native process exit, never on presentation detach. */
  dispose(): Promise<void>;
  registerProcess?: ClaudeLocalSessionLaunch['registerProcess'];
};

/** Materialize the same launch policy for an interactive CLI, without an SDK Query. */
export async function prepareClaudeNativeLaunch(
  launch: ClaudeLocalSessionLaunch,
  materializeMcp?: (servers: Record<string, McpServerConfig>) => Promise<ClaudeNativeMcpProjection>,
): Promise<ClaudeNativePreparedLaunch> {
  const signal = launch.abortController.signal;
  const checkLive = () => { if (signal.aborted) throw new Error('Native Claude launch cancelled'); };
  checkLive();
  // These require their own native lifecycle/control implementations. A missing
  // transport must not silently turn a resume into fresh or drop OAuth refresh.
  if (launch.resume || launch.resumeSessionAt || launch.forkSession) throw new Error('Native Claude history restore is not integrated');
  if (launch.getOAuthToken) throw new Error('Native Claude subscription refresh is not integrated');
  if (!launch.cwd || !launch.sessionId) throw new Error('Native Claude requires a resolved directory and session identity');
  if (typeof launch.settings !== 'object' || launch.settings === null || 'env' in launch.settings) {
    throw new Error('Native Claude launch settings must be resolved without environment credentials');
  }
  const servers = launch.mcpServers ?? {};
  const sdkServers = Object.fromEntries(Object.entries(servers).filter(([, config]) => config.type === 'sdk'));
  if (Object.keys(sdkServers).length && !materializeMcp) throw new Error('Native Claude requires the host MCP bridge');
  let projection: ClaudeNativeMcpProjection | undefined, root: string | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    try { await projection?.dispose(); }
    finally { if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  })();
  try {
    if (Object.keys(sdkServers).length) {
      projection = await materializeMcp!(sdkServers);
      checkLive();
      const expected = Object.keys(sdkServers).sort(), actual = Object.keys(projection.servers).sort();
      if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
        throw new Error('Native Claude MCP projection changed the tool surface');
      }
    }
    const env = { ...launch.env };
    const prefix = 'LEX_CLAUDE_MCP_' + randomUUID().replaceAll('-', '') + '_';
    let variable = 0;
    const reference = (value: string) => {
      const key = prefix + variable++;
      // Resolve the documented MCP environment syntax once before moving the
      // value behind an opaque reference. Replacement values are not expanded
      // recursively (a credential can itself contain literal dollar braces).
      env[key] = value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
        const replacement = env[name] ?? fallback;
        if (replacement === undefined) throw new Error('Native Claude MCP environment variable is missing');
        return replacement;
      });
      return '$' + '{' + key + '}';
    };
    const wireServers: Record<string, unknown> = Object.create(null);
    for (const [name, original] of Object.entries(servers)) {
      const server = original.type === 'sdk' ? projection!.servers[name]! : original;
      if (server.type === 'http' || server.type === 'sse') {
        wireServers[name] = { ...server, url: reference(server.url),
          ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, reference(value)])) } : {}) };
      } else {
        wireServers[name] = { ...server, command: reference(server.command),
          ...(server.args ? { args: server.args.map(reference) } : {}),
          ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, reference(value)])) } : {}) };
      }
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-claude-launch-'));
    checkLive();
    const settingsPath = path.join(root, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify(launch.settings), { mode: 0o600 });
    const args = ['--model', launch.model, '--settings', settingsPath, '--setting-sources', launch.settingSources.join(',')];
    if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode);
    if (launch.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions');
    if (launch.effort) args.push('--effort', launch.effort);
    if (launch.thinking) {
      if (launch.thinking.type === 'enabled') {
        if (launch.thinking.budgetTokens === undefined) args.push('--thinking', 'adaptive');
        else args.push('--max-thinking-tokens', String(launch.thinking.budgetTokens));
      }
      else args.push('--thinking', launch.thinking.type);
      const display = (launch.thinking as { display?: string }).display;
      if (display) args.push('--thinking-display', display);
    }
    if (launch.systemPromptAppend) {
      const promptPath = path.join(root, 'system-append.txt');
      await fs.writeFile(promptPath, launch.systemPromptAppend, { mode: 0o600 });
      args.push('--append-system-prompt-file', promptPath);
    }
    for (const directory of launch.additionalDirectories) args.push('--add-dir', directory);
    for (const plugin of launch.managedSkillPluginRoots) args.push('--plugin-dir', plugin);
    if (launch.allowedTools?.length) args.push('--allowedTools', launch.allowedTools.join(','));
    if (Object.keys(wireServers).length) {
      const configPath = path.join(root, 'mcp.json');
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: wireServers }), { mode: 0o600 });
      args.push('--mcp-config', configPath);
    }
    if (launch.debug) { args.push('--debug'); if (launch.debugFile) args.push('--debug-file', launch.debugFile); }
    // Native TUI controls the presentation; child tool text still follows the
    // existing host environment. Do not inherit the SDK's headless TERM default.
    env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor';
    delete env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH;
    if (launch.enableFileCheckpointing) env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true';
    checkLive();
    return { nativeSessionId: launch.sessionId, executable: launch.binaryPath, cwd: launch.cwd,
      args, env, hooks: launch.hooks, canUseTool: launch.canUseTool, signal, dispose,
      registerProcess: launch.registerProcess };
  } catch (error) { await dispose(); throw error; }
}
