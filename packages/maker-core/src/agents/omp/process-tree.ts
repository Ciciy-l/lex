import type { ChildProcess } from 'node:child_process';

/**
 * Return the process isolation capabilities available to an OMP session.
 * Windows uses ordinary Node spawn and can only terminate the direct child;
 * POSIX detached children can be signalled through their private process group.
 */
export function getOmpProcessIsolationOptions(
  platform: NodeJS.Platform = process.platform,
): { detached?: true; ownsProcessTree?: true } {
  return platform === 'win32'
    ? {}
    : { detached: true, ownsProcessTree: true };
}

/**
 * Best-effort termination for an OMP process.
 *
 * POSIX OMP sessions use a detached process group, so a negative PID can
 * signal descendants even after the direct process exits. Windows ordinary
 * spawn has no equivalent containment boundary and can signal only the direct
 * child while it is still alive.
 */
export function terminateOmpProcessTree(
  child: ChildProcess,
  force: boolean,
): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  const signal = force ? 'SIGKILL' : 'SIGTERM';

  if (process.platform === 'win32') {
    signalDirectChild(child, signal);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    signalDirectChild(child, signal);
  }
}

function signalDirectChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // A direct child that already exited cannot be signalled. The caller still
    // reports its lifecycle as unconfirmed until the owned streams close.
  }
}
