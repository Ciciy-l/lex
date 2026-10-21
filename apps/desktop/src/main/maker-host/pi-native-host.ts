import fs from 'node:fs/promises';
import path from 'node:path';
import { PiNativeSessionControl, PI_NATIVE_EXTENSION_SOURCE, type PiLocalNativeSessionOptions, type AgentTerminalDriver } from '@cindy/maker-core';
import { AgentTerminalPtyDriver, type AgentTerminalLaunch } from '../terminal/agentTerminalDriver.js';

type OwnedTerminal = AgentTerminalDriver & { readonly pid: number };

/** Keep the fully prepared Pi runtime, selecting its original interactive frontend. */
export async function createPiNativeHostSession(
  options: PiLocalNativeSessionOptions,
  createTerminal: (spec: AgentTerminalLaunch) => OwnedTerminal = spec => new AgentTerminalPtyDriver(spec),
): Promise<PiNativeSessionControl> {
  if (options.resumeSessionId && (!path.isAbsolute(options.resumeSessionId) || !(await fs.stat(options.resumeSessionId)).isFile()))
    throw new Error('Pi native history is not an existing session file');
  if (options.args[0] !== '--mode' || options.args[1] !== 'rpc') throw new Error('Pi managed launch plan changed');
  await fs.mkdir(path.dirname(options.extensionPath), { recursive: true });
  await fs.writeFile(options.extensionPath, PI_NATIVE_EXTENSION_SOURCE, { encoding: 'utf8', mode: 0o600 });
  let unregister: (() => void) | undefined;
  const controller = new PiNativeSessionControl({ ...options, async launch(environment) {
    const secretNames = JSON.parse(options.env.CINDY_PI_SECRET_ENV_NAMES ?? '[]');
    const driver = createTerminal({ executable: options.executable, args: [
      ...options.args.slice(2), '--extension', options.extensionPath,
      ...(options.resumeSessionId ? ['--session', options.resumeSessionId] : []),
    ], cwd: options.cwd, env: { ...options.env, ...environment,
      CINDY_PI_SECRET_ENV_NAMES: JSON.stringify([...secretNames, ...Object.keys(environment)]),
    } });
    try { const cleanup = options.registerProcess?.(driver.pid); if (typeof cleanup === 'function') unregister = cleanup; }
    catch { /* Best-effort process observation. */ }
    driver.onExit(() => unregister?.());
    return driver;
  } });
  return controller;
}
