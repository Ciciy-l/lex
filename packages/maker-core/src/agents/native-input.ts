import type { NativeMessageSource } from '@cindy/maker-shared/message-presentation';
import type { UserContentBlock, UserMessage } from '../types/common.js';
import type { SendOptions } from './base-agent.js';

/** Host-only continuation for an input held before the native provider starts. */
export interface AgentNativeInput {
  readonly nativeSessionId: string;
  /** Present only for input explicitly directed at the already-running turn. */
  readonly nativeTurnId?: string;
  readonly message: UserMessage;
  /** Install the prepared bytes in this input; never submit a second prompt. */
  accept(message: UserMessage, opts: SendOptions): Promise<void>;
}

/** One native row, delivered by the adapter rather than an IPC caller. */
export interface AgentNativeInputRequest extends AgentNativeInput {
  readonly nativeMessageId: string;
  readonly source?: NativeMessageSource;
  readonly signal: AbortSignal;
  /** Adapter-owned observation; an accepted steer is not necessarily consumed. */
  readonly consumption?: AgentNativeInputConsumption;
}

export type AgentNativeInputResolver = (input: AgentNativeInputRequest) => Promise<void>;

/** Engine-owned content, imported by the same product owner as native admission. */
export interface AgentNativeMediaInput {
  readonly sessionId: string;
  readonly messageId: string;
  readonly index: number;
  readonly block: unknown;
  readonly signal: AbortSignal;
}
export type AgentNativeMediaResolver = (input: AgentNativeMediaInput) =>
  Promise<Extract<UserContentBlock, { type: 'image' | 'file' }>>;

export type AgentNativeInputConsumptionState = import('@cindy/maker-shared/message-presentation').NativeMessageConsumption;
export interface AgentNativeInputConsumption {
  read(): AgentNativeInputConsumptionState;
  readonly settled: Promise<AgentNativeInputConsumptionState>;
}
