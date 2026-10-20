import type { CodexFrontendCall, CodexFrontendRequest } from './native-frontend.js';

/** Host-only evidence captured from the actual ACK in this service generation. */
export type CodexNativeAttachOrigin =
  | { kind: 'fresh'; threadId: string }
  | { kind: 'resumed'; threadId: string };
export type CodexNativeAttachFailure =
  | 'startup-failed'
  | 'invalid-thread-receipt' | 'owner-changed';
export class CodexNativeAttachUnavailable extends Error {
  constructor(readonly reason: CodexNativeAttachFailure) {
    super('Native Codex presentation unavailable: ' + reason);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Local cancellation only: never claims to cancel an upstream operation. */
export function waitForCodexNativeAttach<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CodexNativeAttachUnavailable('owner-changed'));
    signal.addEventListener('abort', abort, { once: true });
    // Always observe the original promise, including a late rejection.
    void pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** One original TUI resume, confirmed only after its genuine ACK is written. */
export class CodexNativeTaskResumeReceipt {
  readonly ready: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  private request?: CodexFrontendRequest;
  private result?: unknown;
  private settled = false;
  private acknowledged = false;
  constructor(private readonly threadId: string, private readonly isCurrent: () => boolean) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // The PTY can fail before its returned owner is awaited by Core.
    void this.ready.catch(() => {});
  }
  get confirmed(): boolean { return this.acknowledged && this.isCurrent(); }
  async forward(call: CodexFrontendCall): Promise<unknown> {
    if (this.request || this.settled) throw new Error('Native Codex task resume already attempted or retired');
    if (!this.isCurrent() || call.signal.aborted) throw new Error('Native Codex task resume owner changed');
    // Reserve before dispatch; neither another requestId nor a lost receipt retries.
    this.request = call.request;
    try {
      const value = await call.forward();
      if (!this.isCurrent() || call.signal.aborted) throw new Error('Native Codex task resume owner changed');
      if (!record(value) || !record(value.thread) || value.thread.id !== this.threadId) {
        throw new Error('Native Codex task resume returned another thread');
      }
      this.result = value;
      return value;
    } catch (error) {
      this.fail(); throw error;
    }
  }
  delivered(request: CodexFrontendRequest, result: unknown): void {
    if (this.settled || request !== this.request || result !== this.result) return;
    if (!this.isCurrent()) { this.fail(); return; }
    this.settled = true; this.acknowledged = true; this.resolve();
  }
  fail(): void {
    if (this.settled) return;
    this.settled = true; this.reject(new Error('Native Codex task resume receipt unconfirmed'));
  }
}
