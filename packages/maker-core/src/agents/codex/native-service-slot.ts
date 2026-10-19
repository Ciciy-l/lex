import type { Transport } from './app-server/transport.js';
import type { CodexNativeEndpoint, CodexNativeService } from './native-service.js';

/** Host-only snapshot. A frontend cannot refresh it into a replacement process. */
export interface CodexNativeServiceBinding {
  readonly endpoint: CodexNativeEndpoint;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
type Entry = { service: CodexNativeService; lifetime: AbortController; stop?: () => void };

/** Observes the concrete service; its owner alone starts/stops that service. */
export class CodexNativeServiceSlot {
  private entry?: Entry;

  bind(transport: Transport): void {
    this.clear();
    if (!('endpoint' in transport)) return;
    const candidate = transport as CodexNativeService;
    if (!candidate.endpoint || typeof candidate.endpoint.then !== 'function') return;
    const entry: Entry = { service: candidate, lifetime: new AbortController() };
    this.entry = entry;
    const stop = transport.onClose(() => { if (this.entry === entry) this.clear(); });
    if (this.entry === entry) entry.stop = stop;
    else stop(); // Some transports report an already-closed state synchronously.
  }

  clear(): void {
    const entry = this.entry; this.entry = undefined;
    if (!entry) return;
    entry.lifetime.abort(); entry.stop?.();
  }

  async capture(): Promise<CodexNativeServiceBinding | undefined> {
    const entry = this.entry;
    if (!entry) return undefined;
    const isCurrent = () => this.entry === entry && !entry.lifetime.signal.aborted;
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error('Native Codex service retired before attachment'));
      entry.lifetime.signal.addEventListener('abort', stop, { once: true });
      if (!isCurrent()) stop();
    });
    try {
      const endpoint = await Promise.race([entry.service.endpoint, cancelled]);
      if (!isCurrent()) throw new Error('Native Codex service changed before attachment');
      return { endpoint: Object.freeze({ ...endpoint }), signal: entry.lifetime.signal, isCurrent };
    } finally { entry.lifetime.signal.removeEventListener('abort', stop); }
  }
}
