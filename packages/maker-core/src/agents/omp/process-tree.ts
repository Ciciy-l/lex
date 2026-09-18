import type { ChildProcess } from 'node:child_process';

/**
 * Terminate the private process tree owned by an OMP session.
 *
 * Production OMP uses a detached process group on POSIX, so a negative PID
 * reaches every descendant even when the direct OMP process has already
 * exited. Desktop Windows sessions instead use a native, kill-on-close Job
 * Object container: ending its direct container child releases the held Job
 * handle and the operating system reclaims the tree. A direct-child signal
 * remains a best-effort fallback for callers that cannot establish a group
 * boundary.
 */
export function terminateOmpProcessTree(
  child: ChildProcess,
  force: boolean,
): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  const signal = force ? 'SIGKILL' : 'SIGTERM';

  if (process.platform === 'win32') {
    // The child is Desktop's narrow native container, not the OMP root. Its
    // final Job handle is intentionally not inherited by OMP, so terminating
    // this child cannot leave descendants behind after a natural root exit.
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
