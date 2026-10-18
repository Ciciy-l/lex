import {
  createClaudeNativeSession, prepareClaudeNativeLaunch,
  type ClaudeLocalNativeSessionOptions,
  type ClaudeNativeSessionHandle, type AgentTerminalDriver,
} from '@cindy/maker-core';
import { AgentTerminalPtyDriver, type AgentTerminalLaunch } from '../terminal/agentTerminalDriver.js';
import { prepareClaudeNativeMcp } from './claude-native-mcp.js';

export type ClaudeNativeHostOptions = ClaudeLocalNativeSessionOptions;
type OwnedTerminal = AgentTerminalDriver & { readonly pid: number };

/** Main owns PTY/process/MCP resources; Core owns the agent and task semantics. */
export async function createClaudeNativeHostSession(
  options: ClaudeNativeHostOptions,
  createTerminal: (spec: AgentTerminalLaunch) => OwnedTerminal = spec => new AgentTerminalPtyDriver(spec),
): Promise<ClaudeNativeSessionHandle> {
  const prepared = await prepareClaudeNativeLaunch(options.launch, async selected => {
    if (!options.launch.mcpSources) throw new Error('Native Claude MCP sources are missing');
    return prepareClaudeNativeMcp(selected, options.launch.mcpSources, options.logger);
  }).catch(async error => { await options.launch.releaseNativeResources?.(); throw error; });
  let terminal: OwnedTerminal | undefined;
  let stopExit: (() => void) | undefined, unregister: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  const releaseAfterExit = () => disposal ??= (async () => {
    stopExit?.();
    try { unregister?.(); } catch { /* Process observation cannot prevent owned cleanup. */ }
    try { await prepared.dispose(); } finally { await options.launch.releaseNativeResources?.(); }
  })();
  try {
    return await createClaudeNativeSession({
      model: options.model, policy: options.policy, prepareInput: options.prepareInput, onFault: options.onFault, events: options.events,
      disabledSkillPaths: options.disabledSkillPaths,
      runtime: {
        nativeSessionId: prepared.nativeSessionId, resumeSessionId: prepared.resumeSessionId, executable: prepared.executable, cwd: prepared.cwd,
        args: prepared.args, env: prepared.env, hooks: prepared.hooks, canUseTool: prepared.canUseTool, signal: prepared.signal,
        onEvent: options.onEvent,
        launch(spec) {
          const driver = createTerminal(spec);
          terminal = driver;
          try { const cleanup = prepared.registerProcess?.(driver.pid); if (typeof cleanup === 'function') unregister = cleanup; }
          catch { /* Same best-effort observation contract as SDK process spawn. */ }
          stopExit = driver.onExit(() => { void releaseAfterExit().catch(() => {
            options.logger.warn('native Claude launch resource cleanup failed');
          }); });
          return {
            write: driver.write.bind(driver), resize: driver.resize.bind(driver),
            onData: driver.onData.bind(driver), onExit: driver.onExit.bind(driver),
            ...(driver.snapshot ? { snapshot: driver.snapshot.bind(driver) } : {}),
            async close() {
              prepared.revoke();
              await driver.close();
              // Rejected close means exit was not confirmed: retain launch files.
              await releaseAfterExit();
            },
          };
        },
      },
    });
  } catch (error) {
    prepared.revoke();
    if (!terminal) await releaseAfterExit();
    throw error;
  }
}
