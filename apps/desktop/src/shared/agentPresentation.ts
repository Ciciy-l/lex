import type { AgentPresentationState, AgentTerminalControl, AgentTerminalReplay, AgentPresentationUnavailableReason, Capabilities } from '@cindy/maker-core';
import { dbToMakerAgentKind } from './agentKindConversion';

/** Additive task-bound protocol. No executable, environment, credentials or paths. */
export const AGENT_PRESENTATION_CHANNEL = 'maker:presentation:v1';

/** These engines have a task-owned interactive host, rather than a second CLI. */
export function hasLocalNativePresentation(agentKind: string | undefined): boolean {
  const kind = agentKind === 'cc' ? dbToMakerAgentKind(agentKind) : agentKind;
  return kind === 'codex' || kind === 'claude-code' || kind === 'omp' || kind === 'pi';
}
/** Local native adapters confirm role/catalog identity before exposing control.
 * SSH and Review still require their own transports and policy boundaries. */
export function canPrepareLocalNativePresentation(options: { agentKind?: string; remoteHostId?: string | null; reviewMode?: boolean; orcaRole?: string | null }): boolean {
  return hasLocalNativePresentation(options.agentKind) && !options.remoteHostId && !options.reviewMode
    && (!options.orcaRole || options.orcaRole === 'lead' || options.orcaRole === 'worker');
}
export type AgentRuntimeCapabilities = Pick<Capabilities,
  'switchModel' | 'effort' | 'setPermissionModeMidSession' | 'planMode' | 'sameTurnSteer' | 'sessionTree' | 'fork' | 'rewind' | 'manualCompact'>;
export interface AgentRuntimeSnapshot {
  agentKind: string;
  capabilities: AgentRuntimeCapabilities;
  /** Descriptive only: Host still decides and authorizes the input route. */
  guiInputMode?: 'plain-text' | 'append-plain-text';
}
export type AgentPresentationRequest = { sessionId: string } & (
  | { action: 'status' }
  | { action: 'attach' }
  | { action: 'read'; attachmentId: string; afterSequence: number; wait?: boolean }
  | { action: 'control'; attachmentId: string; takeOver?: boolean }
  | { action: 'release'; attachmentId: string; control: AgentTerminalControl }
  | { action: 'write'; attachmentId: string; control: AgentTerminalControl; sequence: number; data: string }
  | { action: 'resize'; attachmentId: string; control: AgentTerminalControl; cols: number; rows: number }
  | { action: 'detach'; attachmentId: string }
);
export type AgentPresentationStatus = ({ supported: false; reason?: AgentPresentationUnavailableReason } | { supported: true; state: AgentPresentationState })
  & { runtime?: AgentRuntimeSnapshot };
export interface AgentPresentationAttached { attachmentId: string; replay: AgentTerminalReplay }
export type { AgentPresentationState, AgentTerminalControl, AgentTerminalReplay };
