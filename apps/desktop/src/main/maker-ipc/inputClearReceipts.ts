import type { AgentInputClearReceipt } from '../../shared/agentInputQueue.js';

/** Bounded acknowledgements for local clear delivery recovery. The DB client is
 * the owner identity; neither a renderer timestamp nor a task ID grants access.
 * Missing/evicted receipts are unknown, never permission to repeat a mutation. */
export class InputClearReceipts {
  private readonly owners = new WeakMap<object, { generation: number; records: Map<string, AgentInputClearReceipt> }>();

  begin(owner: object, generation: number, sessionId: string, requestAt: string): AgentInputClearReceipt {
    let scope = this.owners.get(owner);
    if (!scope || scope.generation !== generation) this.owners.set(owner, scope = { generation, records: new Map() });
    const records = scope.records;
    if (records.get(sessionId)?.status === 'pending') throw new Error('Session clear is still pending');
    if (records.size >= 256 && !records.has(sessionId)) {
      const expired = [...records].find(([, receipt]) => receipt.status !== 'pending');
      if (!expired) throw new Error('Session clear acknowledgement capacity reached');
      records.delete(expired[0]);
    }
    const receipt: AgentInputClearReceipt = { requestAt, status: 'pending' };
    records.set(sessionId, receipt);
    return receipt;
  }

  read(owner: object, generation: number, sessionId: string, requestAt: string): AgentInputClearReceipt {
    const scope = this.owners.get(owner);
    const receipt = scope?.generation === generation ? scope.records.get(sessionId) : undefined;
    return receipt?.requestAt === requestAt ? { ...receipt } : { requestAt, status: 'unknown' };
  }
}
