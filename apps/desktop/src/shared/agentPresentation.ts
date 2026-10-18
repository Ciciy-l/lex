import type { AgentPresentationState, AgentTerminalControl, AgentTerminalReplay } from '@cindy/maker-core';

/** Additive task-bound protocol. No executable, environment, credentials or paths. */
export const AGENT_PRESENTATION_CHANNEL = 'maker:presentation:v1';
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
export type AgentPresentationStatus = { supported: false } | { supported: true; state: AgentPresentationState };
export interface AgentPresentationAttached { attachmentId: string; replay: AgentTerminalReplay }
export type { AgentPresentationState, AgentTerminalControl, AgentTerminalReplay };
