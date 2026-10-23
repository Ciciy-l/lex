import { execFileSync } from 'node:child_process';
import { resolveAndroidSdkTools } from './android-simulator.mjs';
import { isInside, probeMetroOwnership } from '../sim-metro.mjs';

export function extractAndroidSerialArgs(args) {
  let serial = null; const passthrough = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--serial') { passthrough.push(args[i]); continue; }
    if (serial || !/^emulator-\d+$/.test(args[i + 1] ?? '')) throw new Error('--serial 必须是唯一的精确 Android 模拟器 serial');
    serial = args[++i];
  }
  return { serial, passthrough };
}

/** Read-only doctor: every adb command is bound to the developer's exact target. */
export async function inspectAndroidDevelopmentClient(target, options = {}) {
  if (!target.serial) throw new Error('Windows whoami 需要 --serial emulator-NNNN');
  const tools = options.tools ?? resolveAndroidSdkTools();
  const run = options.run ?? ((args) => execFileSync(tools.adb, ['-s', target.serial, ...args], { encoding: 'utf8', windowsHide: true }));
  const deviceReady = run(['get-state']).trim() === 'device';
  const packageState = run(['shell', 'dumpsys', 'package', target.bundleId]);
  const processId = run(['shell', 'pidof', target.bundleId]).trim();
  const installed = { version: /versionName=([^\s]+)/.exec(packageState)?.[1] ?? null,
    buildNumber: /versionCode=(\d+)/.exec(packageState)?.[1] ?? null,
    debuggable: /pkgFlags=\[[^\]]*\bDEBUGGABLE\b/.test(packageState) };
  const metro = (options.probe ?? probeMetroOwnership)(target.port);
  const currentSourceOnExpectedPort = !!metro?.cwd && isInside(target.worktree, metro.cwd) && metro.source === target.source;
  const healthy = deviceReady && !!processId && !!installed.version && installed.debuggable && currentSourceOnExpectedPort;
  return { healthy, platform: 'android', serial: target.serial, bundleId: target.bundleId, installed, processId,
    worktree: target.worktree, expectedSource: target.source, expectedPort: target.port, currentSourceOnExpectedPort, metro };
}
