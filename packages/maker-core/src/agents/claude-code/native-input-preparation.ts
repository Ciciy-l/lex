import { isDeepStrictEqual } from 'node:util';
import type { ClaudeBridgeEvent } from './native-bridge.js';
import type { ClaudeNativeMessageRow } from './native-message-projection.js';

export interface ClaudeNativeInputPreparation {
  readonly row: ClaudeNativeMessageRow;
  readonly signal: AbortSignal;
  /** Resolves only when native has recorded these exact prepared content blocks. */
  accept(content: readonly unknown[], signal?: AbortSignal): Promise<void>;
}

interface PendingInput {
  bytes: number;
  row: ClaudeNativeMessageRow;
  controller: AbortController;
  result: Promise<{ allow: boolean; content?: readonly unknown[] }>;
  resolve(value: { allow: boolean; content?: readonly unknown[] }): void;
  recorded: Promise<void>;
  confirm(): void;
  reject(error: Error): void;
  expected?: readonly unknown[];
  finished: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  stop(): void;
  cancel(): void;
}

/** Pre-append preparation and post-append receipt, joined by native UUID. */
export class ClaudeNativeInputPreparations {
  private readonly pending = new Map<string, PendingInput>();
  private readonly turnInputs = new Map<string, readonly string[]>();
  private closed = false;
  private bytes = 0;
  constructor(private readonly sessionId: string,
    private readonly prepare: (input: ClaudeNativeInputPreparation) => Promise<void>,
    private readonly timeoutMs = 120_000) {}

  request(raw: unknown, signal: AbortSignal): Promise<{ allow: boolean; content?: readonly unknown[] }> {
    const input = raw as Partial<ClaudeNativeMessageRow> | null;
    if (this.closed || signal.aborted || !input || typeof input.uuid !== 'string' || !input.uuid || input.uuid.length > 256
      || input.agentId !== undefined || input.door !== 'prompt' || input.message?.type !== 'user'
      || input.message.isMeta || !Array.isArray(input.message.content) || !input.origin
      || typeof input.origin.kind !== 'string' || this.pending.has(input.uuid) || this.pending.size >= 128) {
      return Promise.reject(new Error('Invalid native input preparation'));
    }
    const row = structuredClone({ ...input, sessionId: this.sessionId }) as ClaudeNativeMessageRow;
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (bytes > 4 * 1024 * 1024 || this.bytes + bytes > 32 * 1024 * 1024) throw new Error('Native input preparation exceeds limit');
    const controller = new AbortController();
    let resolve!: PendingInput['resolve'], confirm!: () => void, reject!: (error: Error) => void;
    const result = new Promise<{ allow: boolean; content?: readonly unknown[] }>(r => { resolve = r; });
    const recorded = new Promise<void>((r, j) => { confirm = r; reject = j; });
    void recorded.catch(() => {});
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    void cancelled.catch(() => {});
    const cancel = () => {
      controller.abort(); resolve({ allow: false });
      const error = new Error('Native input preparation cancelled'); reject(error); rejectCancelled(error);
    };
    const timer = setTimeout(cancel, this.timeoutMs); timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
    const entry: PendingInput = { row, bytes, controller, result, resolve, recorded, confirm, reject,
      timer, cancel, stop: () => signal.removeEventListener('abort', cancel), finished: Promise.resolve() };
    this.pending.set(row.uuid, entry);
    this.bytes += bytes;
    const work = Promise.resolve().then(async () => {
      if (controller.signal.aborted || this.closed) throw new Error('Native input preparation cancelled');
      await this.prepare({ row: structuredClone(row), signal: controller.signal,
        accept: async (content, hostSignal) => {
          if (hostSignal?.aborted) cancel();
          if (entry.expected || controller.signal.aborted || this.closed) throw new Error('Native input preparation is no longer current');
          assertNativeRewrite(row.message.content, content);
          const preparedBytes = Buffer.byteLength(JSON.stringify(content));
          if (this.bytes + preparedBytes > 32 * 1024 * 1024) throw new Error('Native input preparation exceeds limit');
          this.bytes += preparedBytes; entry.bytes += preparedBytes;
          entry.expected = structuredClone(content);
          hostSignal?.addEventListener('abort', cancel, { once: true });
          try {
            resolve({ allow: true, content: entry.expected });
            await recorded;
            if (controller.signal.aborted || this.closed) throw new Error('Native input preparation cancelled');
          } finally { hostSignal?.removeEventListener('abort', cancel); }
        },
      });
      if (!entry.expected) throw new Error('Native input was not admitted');
      await recorded;
    });
    entry.finished = Promise.race([work, cancelled]).catch(error => {
      cancel(); throw error;
    }).finally(() => { clearTimeout(timer); entry.stop(); });
    // The first model step consumes this exact result, including failures.
    void entry.finished.catch(() => {});
    return result;
  }

  record(event: ClaudeBridgeEvent): void {
    const turn = event.value as { turnId?: string; messageIds?: string[]; agentId?: string };
    if (turn && turn.agentId === undefined && typeof turn.turnId === 'string') {
      if (event.kind === 'turn.start' && Array.isArray(turn.messageIds)) {
        if (this.turnInputs.size >= 128) throw new Error('Native prepared turn queue full');
        this.turnInputs.set(turn.turnId, turn.messageIds);
      }
      if (event.kind === 'turn.complete') {
        this.retire(this.turnInputs.get(turn.turnId) ?? []); this.turnInputs.delete(turn.turnId);
      }
    }
    if (event.kind !== 'session.append') return;
    const value = event.value as { uuid?: string; result?: { uuid?: string; message?: { content?: unknown } } };
    const entry = value?.uuid ? this.pending.get(value.uuid) : undefined;
    if (!entry) return;
    if (!entry.expected || value.result?.uuid !== entry.row.uuid
      || !isDeepStrictEqual(value.result.message?.content, entry.expected)) {
      entry.cancel();
      return;
    }
    // The append receipt precedes request-retired in the same event batch.
    // Normal hook retirement must not cancel a completed native append.
    entry.stop();
    entry.confirm();
  }

  async admit(messageIds: readonly string[], signal: AbortSignal): Promise<void> {
    for (const id of messageIds) {
      const entry = this.pending.get(id);
      if (!entry) continue; // GUI commands may already own their host reservation.
      await entry.finished;
      if (signal.aborted || this.closed || entry.controller.signal.aborted) throw new Error('Native input admission cancelled');
    }
  }

  retire(messageIds: readonly string[]): void {
    for (const id of messageIds) {
      const entry = this.pending.get(id); if (!entry) continue;
      entry.cancel(); clearTimeout(entry.timer); entry.stop(); this.pending.delete(id);
      this.bytes -= entry.bytes;
    }
  }
  close(): void { this.closed = true; this.retire([...this.pending.keys()]); this.turnInputs.clear(); }
}

/** Official append permits text edits and original-media movement/removal only. */
function assertNativeRewrite(original: readonly unknown[], content: readonly unknown[]): void {
  if (!Array.isArray(content) || Buffer.byteLength(JSON.stringify(content)) > 4 * 1024 * 1024) throw new Error('Invalid native prepared content');
  const available = [...original];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') continue;
    const index = available.findIndex(candidate => isDeepStrictEqual(candidate, block));
    if (index < 0) throw new Error('Native preparation cannot introduce or replace media');
    available.splice(index, 1);
  }
  if (available.some(block => !block || typeof block !== 'object'
    || !['text', 'image', 'document'].includes((block as { type: string }).type))) {
    throw new Error('Native preparation cannot remove opaque blocks');
  }
}
