import {
  isMakerAgentKind,
  type MakerAgentKindWire,
} from './agentKindConversion';

/** Main → renderer invalidation only; command bodies are re-read through the normal IPC boundary. */
export const AGENT_COMMAND_CATALOG_CHANGED_CHANNEL = 'maker:agent-command-catalog:changed';

export type AgentCommandCatalogStatus = 'unknown' | 'loaded' | 'failed';

export interface AgentCommandCatalogChangedPayload {
  readonly sessionId: string;
  readonly agentKind: MakerAgentKindWire;
  /** Per-live-session command catalog revision; only suitable for invalidation. */
  readonly revision: number;
  readonly status: AgentCommandCatalogStatus;
}

const CATALOG_STATUSES: readonly AgentCommandCatalogStatus[] = [
  'unknown',
  'loaded',
  'failed',
];

function isSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\0');
}

function isCatalogStatus(value: unknown): value is AgentCommandCatalogStatus {
  return typeof value === 'string'
    && (CATALOG_STATUSES as readonly string[]).includes(value);
}

function isCatalogRevision(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

/**
 * Validate and copy a push payload before it crosses the preload bridge.
 * Device-link peers and stale renderer builds are untrusted at this boundary.
 */
export function parseAgentCommandCatalogChangedPayload(
  value: unknown,
): AgentCommandCatalogChangedPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    !isSessionId(input.sessionId)
    || !isMakerAgentKind(input.agentKind)
    || !isCatalogRevision(input.revision)
    || !isCatalogStatus(input.status)
  ) {
    return null;
  }
  return Object.freeze({
    sessionId: input.sessionId,
    agentKind: input.agentKind,
    revision: input.revision,
    status: input.status,
  });
}

/** Main-only convenience constructor; keeps emitted payloads and preload parsing in lockstep. */
export function createAgentCommandCatalogChangedPayload(
  payload: AgentCommandCatalogChangedPayload,
): AgentCommandCatalogChangedPayload {
  const parsed = parseAgentCommandCatalogChangedPayload(payload);
  if (!parsed) throw new Error('Invalid agent command catalog payload');
  return parsed;
}
