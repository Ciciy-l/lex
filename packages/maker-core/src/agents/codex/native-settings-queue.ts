import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Serializes settings writes while distinguishing GUI's desired-state fallback
 * from a native request that needs a confirmed receipt before returning success.
 */
export class CodexSettingsQueue {
  private chain: Promise<void> = Promise.resolve();
  private readonly strict = new AsyncLocalStorage<{ signal?: AbortSignal }>();
  constructor(private readonly current: () => unknown,
    private readonly write: (patch: Record<string, unknown>) => Promise<unknown>,
    private readonly failed: (keys: string[], error: unknown) => void) {}

  get requiresConfirmation(): boolean { return this.strict.getStore() !== undefined; }
  confirmed<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.strict.run({ signal }, run);
  }

  update(patch: Record<string, unknown>): Promise<void> {
    // Capture scope at admission. The serial queue can run after the originating
    // operation returned; another GUI call must not inherit this strict mode.
    const strict = this.strict.getStore();
    const owner = this.current();
    const valid = () => Boolean(owner) && Object.is(owner, this.current()) && !strict?.signal?.aborted;
    const frozen = structuredClone(patch);
    const run = this.chain.then(async () => {
      if (!valid()) {
        if (strict) throw new Error('Native Codex settings owner changed');
        return;
      }
      try {
        await this.write(frozen);
        if (strict && !valid()) throw new Error('Native Codex settings owner changed');
      }
      catch (error) {
        this.failed(Object.keys(frozen), error);
        if (strict) throw error;
      }
    });
    // One rejected native change cannot poison subsequent independent writes.
    this.chain = run.catch(() => {});
    return run;
  }
}
