export type OmpProcessState =
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopping'
  | 'exit-unconfirmed'
  | 'exited';

export interface OmpProcessLifecycleOptions {
  requestTermination(force: boolean): void;
  onState(state: OmpProcessState): void;
  startupTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  exitTimeoutMs?: number;
}

export class OmpProcessLifecycle {
  private state: OmpProcessState = 'starting';
  private startupTimer?: ReturnType<typeof setTimeout>;
  private forceTimer?: ReturnType<typeof setTimeout>;
  private exitTimer?: ReturnType<typeof setTimeout>;
  private readonly gracefulTimeout: number;
  private readonly exitTimeout: number;
  private readonly waiters = new Set<(confirmed: boolean) => void>();

  constructor(private readonly options: OmpProcessLifecycleOptions) {
    const startupTimeout = options.startupTimeoutMs ?? 30_000;
    this.gracefulTimeout = options.gracefulTimeoutMs ?? 3_000;
    this.exitTimeout = options.exitTimeoutMs ?? 10_000;
    for (const timeout of [
      startupTimeout,
      this.gracefulTimeout,
      this.exitTimeout,
    ]) {
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
        throw new Error('Invalid OMP lifecycle timeout');
      }
    }
    if (this.exitTimeout <= this.gracefulTimeout)
      throw new Error('OMP exit timeout must exceed graceful timeout');
    this.startupTimer = setTimeout(() => this.stop(), startupTimeout);
  }

  getState(): OmpProcessState {
    return this.state;
  }

  markReady(): boolean {
    if (this.state !== 'starting') return false;
    clearTimeout(this.startupTimer);
    this.state = 'ready';
    this.notify();
    return this.state === 'ready';
  }

  stop(): void {
    if (
      this.state === 'stopping' ||
      this.state === 'draining' ||
      this.state === 'exit-unconfirmed' ||
      this.state === 'exited'
    )
      return;
    clearTimeout(this.startupTimer);
    this.state = 'stopping';
    this.forceTimer = setTimeout(
      () => this.terminate(true),
      this.gracefulTimeout,
    );
    this.exitTimer = setTimeout(() => {
      if (this.state !== 'stopping') return;
      this.state = 'exit-unconfirmed';
      this.settle(false);
      this.notify();
    }, this.exitTimeout);
    this.notify();
    if (this.state === 'stopping') this.terminate(false);
  }

  beginDrain(): void {
    if (this.state !== 'starting' && this.state !== 'ready') return;
    clearTimeout(this.startupTimer);
    this.state = 'draining';
    this.exitTimer = setTimeout(() => {
      if (this.state !== 'draining') return;
      // A direct process can exit while a descendant retains one of its stdio
      // pipes. Ask the owner to force-reclaim its tree before declaring the
      // outcome unconfirmed; callers that do not own a group safely no-op.
      try {
        this.options.requestTermination(true);
      } catch {
        // The result remains unconfirmed until `close` supplies real evidence.
      }
      this.state = 'exit-unconfirmed';
      this.settle(false);
      this.notify();
    }, this.exitTimeout);
    this.notify();
  }

  confirmExit(): void {
    if (this.state === 'exited') return;
    clearTimeout(this.startupTimer);
    clearTimeout(this.forceTimer);
    clearTimeout(this.exitTimer);
    this.state = 'exited';
    this.settle(true);
    this.notify();
  }

  stopAndWait(): Promise<boolean> {
    if (this.state === 'exited') return Promise.resolve(true);
    if (this.state === 'exit-unconfirmed') return Promise.resolve(false);
    const result = new Promise<boolean>((resolve) => this.waiters.add(resolve));
    this.stop();
    return result;
  }

  private settle(confirmed: boolean): void {
    const waiters = Array.from(this.waiters);
    this.waiters.clear();
    for (const resolve of waiters) resolve(confirmed);
  }

  private terminate(force: boolean): void {
    if (this.state !== 'stopping') return;
    try {
      this.options.requestTermination(force);
    } catch {
      return;
    }
  }

  private notify(): void {
    try {
      this.options.onState(this.state);
    } catch {
      this.stop();
    }
  }
}
