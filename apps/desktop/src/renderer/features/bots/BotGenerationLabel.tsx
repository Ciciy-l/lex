import type { AgentIslandSessionPhase } from '../../../shared/agentIsland';

/** Compact, host-owned status label for hidden group lanes. */
export function BotGenerationLabel({
  phase = 'running',
  detail,
}: {
  sessionId?: string;
  phase?: AgentIslandSessionPhase | string;
  startedAt?: number | null;
  detail?: string | null;
}) {
  if (detail?.trim()) return <>{detail}</>;
  if (phase === 'needs-interaction') return <>…</>;
  return <>…</>;
}
