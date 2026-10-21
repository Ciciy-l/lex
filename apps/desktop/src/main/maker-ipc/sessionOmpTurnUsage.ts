import type { AgentEvent, Session } from '@cindy/maker-core';
import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import type { TurnUsageContext } from './turnUsageContext.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';

export interface RecordSessionOmpTurnUsageDeps {
  readonly turnUsageContextBySession: Map<string, TurnUsageContext>;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
}

/** Persist native token facts without inventing an OMP price or subscription bill. */
export function recordSessionOmpTurnUsage(
  deps: RecordSessionOmpTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId: string | undefined,
): void {
  if (event.type !== 'done' || event.source !== 'omp') return;
  deps.turnUsageContextBySession.delete(session.id);
  const model = deps.turnModelPromiseBySession.get(session.id);
  deps.turnModelPromiseBySession.delete(session.id);
  // The upstream translator supplies per-turn facts. Status remains a live
  // context snapshot and must never be added to the durable session total.
  const data = event.data;
  const usage = data && typeof data === 'object' && 'usage' in data
    ? normalizeTurnUsageDetails(data.usage) : undefined;
  if (!usage) return;
  const owner = captureDataOwnerBroadcastScope();
  void recordSessionTurnTokens(session.id, usage.totalTokens);
  if (!turnAssistantPersistId) return;
  void (model ?? deps.readSessionModelForUsage(session.id)).catch(() => undefined).then(async turnModel => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
    await recordTurnUsageOnMessage({ sessionId: session.id, clientId: turnAssistantPersistId,
      turnUsageDetails: { ...usage, ...(turnModel ? { model: turnModel } : {}) } });
  });
}
