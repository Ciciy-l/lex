import { ORCA_NATIVE_BODY, type OrcaNativeBodySource } from '@cindy/maker-core';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

// Only Main's authorized Orca dispatcher may create this receipt. The serialized
// form is interpreted exclusively when restoring the current owner's DB queue.
const SNAPSHOT = 'hostOrcaNativeBodySource';
type OrcaQueuedInput = AgentInputQueuedMessage & {
  [ORCA_NATIVE_BODY]?: OrcaNativeBodySource;
  [SNAPSHOT]?: OrcaNativeBodySource;
};

function valid(source: unknown, sessionId: string, clientId: string): source is OrcaNativeBodySource {
  if (!source || typeof source !== 'object') return false;
  const value = source as OrcaNativeBodySource;
  return value.version === 1 && value.targetSessionId === sessionId && value.clientId === clientId
    && typeof value.teamId === 'string' && value.teamId.length > 0
    && typeof value.leadSessionId === 'string' && value.leadSessionId.length > 0
    && (value.role === 'lead' ? value.leadSessionId === sessionId && value.workerId === undefined
      : value.role === 'worker' && typeof value.workerId === 'string' && value.workerId.length > 0);
}

/** Call at every renderer/device-link queue ingress, including edits. */
export function stripOrcaNativeBody(item: AgentInputQueuedMessage): AgentInputQueuedMessage {
  const clean = { ...item } as OrcaQueuedInput;
  delete clean[ORCA_NATIVE_BODY]; delete clean[SNAPSHOT];
  return clean;
}

export function stampOrcaNativeBody(item: AgentInputQueuedMessage, source: OrcaNativeBodySource | undefined): AgentInputQueuedMessage {
  const stamped = stripOrcaNativeBody(item) as OrcaQueuedInput;
  if (!source) return stamped;
  if (!valid(source, source.targetSessionId, item.clientId)) throw new Error('Invalid Orca native input receipt');
  stamped[ORCA_NATIVE_BODY] = stamped[SNAPSHOT] = Object.freeze({ ...source });
  return stamped;
}

export function restoreOrcaNativeBody(sessionId: string, item: AgentInputQueuedMessage): AgentInputQueuedMessage {
  const source = (item as OrcaQueuedInput)[SNAPSHOT];
  return stampOrcaNativeBody(item, valid(source, sessionId, item.clientId) ? source : undefined);
}

export function readOrcaNativeBody(item: AgentInputQueuedMessage): OrcaNativeBodySource | undefined {
  return (item as OrcaQueuedInput)[ORCA_NATIVE_BODY];
}
