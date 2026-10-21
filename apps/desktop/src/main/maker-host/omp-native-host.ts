import fs from 'node:fs/promises';
import path from 'node:path';
import { createOmpNativeSession, OMP_NATIVE_EXTENSION_SOURCE, type OmpLocalNativeSessionOptions, type AgentTerminalDriver } from '@cindy/maker-core';
import { AgentTerminalPtyDriver, type AgentTerminalLaunch } from '../terminal/agentTerminalDriver.js';

type OwnedTerminal = AgentTerminalDriver & { readonly pid: number };

/** Main owns original OMP's PTY; Core/official extension own semantic messages. */
export async function createOmpNativeHostSession(
  options: OmpLocalNativeSessionOptions,
  createTerminal: (spec: AgentTerminalLaunch) => OwnedTerminal = spec => new AgentTerminalPtyDriver(spec),
) {
  const extension = path.join(options.plan.roots.temporary, 'lex-native-extension.ts');
  const definitions = path.join(options.plan.roots.temporary, 'lex-native-tools.json');
  const nativeSettings = path.join(options.plan.roots.temporary, 'lex-native-settings.yaml');
  let terminal: OwnedTerminal | undefined, unregister: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  const release = () => disposal ??= (async () => {
    unregister?.();
    try { await Promise.all([extension, definitions, nativeSettings].map(file => fs.rm(file, { force: true }))); }
    finally { await options.releaseResources(); }
  })();
  try {
    if (options.resumeSessionId) {
      if (!path.isAbsolute(options.resumeSessionId) || !(await fs.stat(options.resumeSessionId)).isFile())
        throw new Error('OMP native history is not an existing session file');
    }
    await fs.mkdir(options.plan.roots.temporary, { recursive: true });
    await fs.writeFile(extension, OMP_NATIVE_EXTENSION_SOURCE, { encoding: 'utf8', mode: 0o600 });
    // Pinned OMP's automatic recap reuses provider hooks without a journalled
    // input. Opt out only in this native process; keep the shared RPC plan and
    // user settings unchanged. Later explicit native runtime overrides still win.
    await fs.writeFile(nativeSettings, 'recap:\n  enabled: false\n', { encoding: 'utf8', mode: 0o600 });
    return await createOmpNativeSession({ ...options, async launch(environment, tools) {
      const args = [...options.plan.arguments];
      if (args[0] !== '--mode' || args[1] !== 'rpc') throw new Error('OMP managed launch plan changed');
      // Keep config/model/provider/prompt/approval flags, selecting the original
      // interactive frontend. Explicit history selection never opens a picker.
      args.splice(0, 2);
      args.push('--config', nativeSettings, '--session-dir', options.plan.roots.sessions, '--extension', extension);
      if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
      await fs.writeFile(definitions, JSON.stringify(tools), { encoding: 'utf8', mode: 0o600 });
      const driver = createTerminal({ executable: options.executable, args, cwd: options.plan.roots.workingDir,
        env: { ...options.plan.environment, ...environment, LEX_OMP_HOST_TOOLS_FILE: definitions } });
      terminal = driver;
      try { const cleanup = options.registerProcess?.(driver.pid); if (typeof cleanup === 'function') unregister = cleanup; } catch { /* Best-effort process observation. */ }
      driver.onExit(() => { void release().catch(() => options.logger.warn('OMP native launch resource cleanup failed')); });
      return { write: driver.write.bind(driver), resize: driver.resize.bind(driver),
        onData: driver.onData.bind(driver), onExit: driver.onExit.bind(driver),
        ...(driver.snapshot ? { snapshot: driver.snapshot.bind(driver) } : {}),
        async close() {
          await driver.close();
          // An unconfirmed exit retains native launch files and host leases.
          await release();
        },
      };
    } });
  } catch (error) {
    if (!terminal) await release();
    throw error;
  }
}
