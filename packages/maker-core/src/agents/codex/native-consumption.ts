import type { AgentNativeInputConsumption, AgentNativeInputConsumptionState } from '../native-input.js';

/** Tracks only dispatched native inputs, on one continuous root notification stream. */
export class CodexNativeInputConsumption {
  private readonly pending = new Map<string, {
    state: AgentNativeInputConsumptionState;
    settle(state: AgentNativeInputConsumptionState): void;
  }>();

  begin(sessionId: string, turnId: string, messageId: string): AgentNativeInputConsumption {
    if (this.pending.has(messageId)) throw new Error('Native input identity already pending');
    let resolve!: (state: AgentNativeInputConsumptionState) => void;
    const settled = new Promise<AgentNativeInputConsumptionState>(done => { resolve = done; });
    const entry = { state: Object.freeze({ version: 1 as const, engine: 'codex' as const,
      sessionId, turnId, messageId, status: 'pending' as const }) as AgentNativeInputConsumptionState,
      settle: resolve };
    this.pending.set(messageId, entry);
    return { read: () => entry.state, settled };
  }

  /** Use the native client UUID, never content, sequence proximity or the latest input. */
  itemStarted(params: { threadId: string; turnId: string; item: { type: string; id: string; clientId?: unknown } }): void {
    if (params.item.type !== 'userMessage' || typeof params.item.clientId !== 'string' || !params.item.id) return;
    const entry = this.pending.get(params.item.clientId);
    if (!entry || entry.state.sessionId !== params.threadId || entry.state.turnId !== params.turnId) return;
    this.finish(entry, 'consumed', params.item.id);
  }

  /** Only an observed terminal on the uninterrupted stream proves absence of consumption. */
  turnCompleted(threadId: string, turnId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.state.sessionId === threadId && entry.state.turnId === turnId) this.finish(entry, 'unconsumed');
    }
  }

  uncertain(messageId: string): void {
    const entry = this.pending.get(messageId);
    if (entry) this.finish(entry, 'unknown');
  }

  /** Close, replacement and transport loss are not proof that the CLI restored a draft. */
  disconnect(): void {
    for (const entry of this.pending.values()) this.finish(entry, 'unknown');
  }

  private finish(entry: { state: AgentNativeInputConsumptionState; settle(state: AgentNativeInputConsumptionState): void },
    status: Exclude<AgentNativeInputConsumptionState['status'], 'pending'>, itemId?: string): void {
    entry.state = Object.freeze({ ...entry.state, status, ...(itemId ? { itemId } : {}) });
    this.pending.delete(entry.state.messageId);
    entry.settle(entry.state);
  }
}
