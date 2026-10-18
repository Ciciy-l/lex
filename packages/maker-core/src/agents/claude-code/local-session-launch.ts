import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { spawnObservedClaudeProcess } from './local-process-spawn.js';

/** Already-resolved task policy/configuration, shared by the SDK and native transports. */
export interface ClaudeLocalSessionLaunch {
  abortController: AbortController;
  cwd?: string;
  additionalDirectories: string[];
  managedSkillPluginRoots: string[];
  model: string;
  effort?: Options['effort'];
  permissionMode: Options['permissionMode'];
  thinking?: Options['thinking'];
  binaryPath: string;
  /** Preserve the existing assembled prefix byte-for-byte, including its order. */
  systemPromptAppend: string;
  resume?: string;
  sessionId?: string;
  enableFileCheckpointing: boolean;
  resumeSessionAt?: string;
  forkSession?: boolean;
  env: Record<string, string>;
  registerProcess?: (pid: number) => (() => void) | void;
  getOAuthToken?: () => Promise<string | null>;
  allowedTools?: readonly string[];
  canUseTool: NonNullable<Options['canUseTool']>;
  settingSources: NonNullable<Options['settingSources']>;
  settings: NonNullable<Options['settings']>;
  allowDangerouslySkipPermissions: boolean;
  stderr?: (line: string) => void;
  debug: boolean;
  debugFile?: string;
  mcpServers?: Options['mcpServers'];
  hooks: NonNullable<Options['hooks']>;
}

/** SDK-only transport plumbing; native launch never starts a Query beside its TUI. */
export function claudeSdkOptions(launch: ClaudeLocalSessionLaunch): Options {
  return {
    abortController: launch.abortController, cwd: launch.cwd,
    ...(launch.additionalDirectories.length ? { additionalDirectories: launch.additionalDirectories } : {}),
    ...(launch.managedSkillPluginRoots.length
      ? { plugins: launch.managedSkillPluginRoots.map(path => ({ type: 'local' as const, path })) } : {}),
    model: launch.model, ...(launch.effort ? { effort: launch.effort } : {}),
    permissionMode: launch.permissionMode, includePartialMessages: true,
    ...(launch.thinking ? { thinking: launch.thinking } : {}),
    pathToClaudeCodeExecutable: launch.binaryPath,
    systemPrompt: { type: 'preset', preset: 'claude_code',
      ...(launch.systemPromptAppend ? { append: launch.systemPromptAppend } : {}) },
    ...(launch.resume ? { resume: launch.resume } : {}),
    ...(launch.sessionId ? { sessionId: launch.sessionId } : {}),
    enableFileCheckpointing: launch.enableFileCheckpointing,
    ...(launch.resumeSessionAt ? { resumeSessionAt: launch.resumeSessionAt } : {}),
    ...(launch.forkSession ? { forkSession: true } : {}),
    env: launch.env,
    ...(launch.registerProcess ? { spawnClaudeCodeProcess: spawnOptions => spawnObservedClaudeProcess({
      spawnOptions, registerProcess: launch.registerProcess!, onStderr: launch.stderr,
    }) } : {}),
    // SDK installs its refresh callback flag; native transport must implement its own refresh.
    ...(launch.getOAuthToken ? { getOAuthToken: launch.getOAuthToken } : {}),
    ...(launch.allowedTools ? { allowedTools: [...launch.allowedTools] } : {}),
    canUseTool: launch.canUseTool, settingSources: launch.settingSources, settings: launch.settings,
    allowDangerouslySkipPermissions: launch.allowDangerouslySkipPermissions, stderr: launch.stderr,
    ...(launch.debug ? { debug: true, ...(launch.debugFile ? { debugFile: launch.debugFile } : {}) } : {}),
    ...(launch.mcpServers ? { mcpServers: launch.mcpServers } : {}),
    ...(Object.keys(launch.hooks).length ? { hooks: launch.hooks } : {}),
  };
}
