import type { AgentNativeInputConsumption, AgentNativeInputConsumptionState } from '../native-input.js';

/** OMP prepares context before persistence; only its later journal gate proves consumption. */
export class OmpNativeConsumption implements AgentNativeInputConsumption {
  private state: AgentNativeInputConsumptionState;
  private resolve!: (state: AgentNativeInputConsumptionState) => void;
  readonly settled = new Promise<AgentNativeInputConsumptionState>(resolve => { this.resolve = resolve; });
  constructor(sessionId: string, turnId: string, submissionId: string) {
    this.state = Object.freeze({ version: 1, engine: 'omp', sessionId, turnId, messageId: submissionId, status: 'pending' });
  }
  read(): AgentNativeInputConsumptionState { return this.state; }
  finish(status: 'consumed' | 'unconsumed' | 'unknown', itemId?: string): void {
    if (this.state.status !== 'pending') return;
    if (status === 'consumed' && !itemId) throw new Error('OMP consumption requires its original journal ID');
    this.state = Object.freeze({ ...this.state, status, ...(itemId ? { itemId } : {}) });
    this.resolve(this.state);
  }
}
