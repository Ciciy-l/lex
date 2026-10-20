import type { AgentPresentationState, AgentTerminalControl, AgentTerminalReplay, AgentPresentationUnavailableReason } from '@cindy/maker-core';
import { dbToMakerAgentKind } from './agentKindConversion';

/** Additive task-bound protocol. No executable, environment, credentials or paths. */
export const AGENT_PRESENTATION_CHANNEL = 'maker:presentation:v1';

/** These engines have a task-owned interactive host, rather than a second CLI. */
export function hasLocalNativePresentation(agentKind: string | undefined): boolean {
  const kind = agentKind === 'cc' ? dbToMakerAgentKind(agentKind) : agentKind;
  return kind === 'codex' || kind === 'claude-code';
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
export type AgentPresentationStatus = { supported: false; reason?: AgentPresentationUnavailableReason } | { supported: true; state: AgentPresentationState };
export interface AgentPresentationAttached { attachmentId: string; replay: AgentTerminalReplay }
export type { AgentPresentationState, AgentTerminalControl, AgentTerminalReplay };
