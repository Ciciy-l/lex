import type { ClaudeBridgeEvent } from './native-bridge.js';
import type { ClaudeNativeUserMessage } from './native-messages.js';

export interface ClaudeNativeTurn {
  nativeSessionId: string;
  turnId: string;
  /** Actual rows already accepted by native; no text-based identity matching. */
  messages: readonly ClaudeNativeUserMessage[];
}

interface TurnEntry {
  turn: ClaudeNativeTurn;
  bytes: number;
  controller: AbortController;
  admission?: Promise<{ allow: boolean }>;
}

/** Joins ordered native rows with the first model step, before provider I/O. */
export class ClaudeNativeTurns {
  private readonly rows = new Map<string, { message: ClaudeNativeUserMessage; bytes: number }>();
  private readonly turns = new Map<string, TurnEntry>();
  private readonly observed = new Set<() => void>();
  private closed = false;
  private rowBytes = 0;
  constructor(private readonly sessionId: string,
    private readonly admit: (turn: ClaudeNativeTurn, signal: AbortSignal) => Promise<void>) {}

  record(message: ClaudeNativeUserMessage): void {
    if (this.closed) return;
    if (message.row.sessionId !== this.sessionId || this.rows.has(message.row.uuid)) throw new Error('Native row identity changed');
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.rows.size >= 128 || this.rowBytes + bytes > 32 * 1024 * 1024) throw new Error('Native input queue full');
    this.rows.set(message.row.uuid, { message, bytes }); this.rowBytes += bytes;
  }

  accept(event: ClaudeBridgeEvent): void {
    if (this.closed) return;
    const value = event.value as { turnId?: unknown; messageIds?: unknown; agentId?: unknown };
    if (!value || typeof value !== 'object' || value.agentId !== undefined) return;
    if (event.kind === 'turn.start') {
      if (typeof value.turnId !== 'string' || !value.turnId || !Array.isArray(value.messageIds)
        || this.turns.has(value.turnId) || this.turns.size >= 128) throw new Error('Invalid native turn identity');
      const messages: ClaudeNativeUserMessage[] = [];
      let bytes = 0;
      for (const id of value.messageIds) {
        if (typeof id !== 'string' || !this.rows.has(id)) throw new Error('Native turn input identity missing');
        const row = this.rows.get(id)!;
        messages.push(row.message); bytes += row.bytes; this.rows.delete(id);
      }
      this.turns.set(value.turnId, { turn: { nativeSessionId: this.sessionId, turnId: value.turnId, messages }, bytes, controller: new AbortController() });
      this.wake();
    } else if (event.kind === 'turn.complete' && typeof value.turnId === 'string') {
      this.turns.get(value.turnId)?.controller.abort();
      this.rowBytes -= this.turns.get(value.turnId)?.bytes ?? 0;
      this.turns.delete(value.turnId);
      this.wake();
    }
  }

  async request(input: unknown, signal: AbortSignal): Promise<{ allow: boolean }> {
    const turnId = (input as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId !== 'string' || !turnId || turnId.length > 256) throw new Error('Invalid native turn request');
    // /request and /exchange use separate connections. Wait for the ordered
    // event stream rather than treating a request that arrives first as a turn.
    const deadline = Date.now() + 10_000;
    while (!this.turns.has(turnId)) {
      if (this.closed || signal.aborted) throw new Error('Native turn admission cancelled');
      if (Date.now() >= deadline) throw new Error('Native turn identity unavailable');
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.observed.delete(wake); signal.removeEventListener('abort', wake); resolve(); };
        const timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
        timer.unref();
        this.observed.add(wake); signal.addEventListener('abort', wake, { once: true });
      });
    }
    const entry = this.turns.get(turnId)!;
    if (this.closed || signal.aborted || entry.controller.signal.aborted) throw new Error('Native turn admission cancelled');
    const cancel = () => entry.controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      entry.admission ??= Promise.resolve().then(async () => {
        if (entry.controller.signal.aborted) return { allow: false };
        await this.admit(entry.turn, entry.controller.signal);
        return { allow: !this.closed && !entry.controller.signal.aborted };
      });
      return await entry.admission;
    } finally { signal.removeEventListener('abort', cancel); }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.turns.values()) entry.controller.abort();
    this.turns.clear(); this.rows.clear(); this.rowBytes = 0; this.wake();
  }
  private wake(): void { for (const wake of [...this.observed]) wake(); }
}
