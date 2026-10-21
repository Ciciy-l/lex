import type { NativeMessageSource } from '@cindy/maker-shared/message-presentation';
import type { UserContentBlock, UserMessage } from '../types/common.js';
import type { SendOptions } from './base-agent.js';

/** The product binding outlives an individual bridge HTTP request. */
export interface AgentNativeInputOwnership {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

/** Host-only continuation for an input held before the native provider starts. */
export interface AgentNativeInput {
  readonly nativeSessionId: string;
  /** Present only for input explicitly directed at the already-running turn. */
  readonly nativeTurnId?: string;
  readonly message: UserMessage;
  /** Install the prepared bytes in this input; never submit a second prompt. */
  accept(message: UserMessage, opts: SendOptions, ownership?: AgentNativeInputOwnership): Promise<void>;
}

/** Adapter-owned input identity; never supplied by an IPC caller. */
export type AgentNativeInputRequest = AgentNativeInput & {
  readonly signal: AbortSignal;
  /** Adapter-owned observation; an accepted steer is not necessarily consumed. */
  readonly consumption?: AgentNativeInputConsumption;
} & ({
  readonly nativeMessageId: string;
  readonly source?: NativeMessageSource;
  readonly submissionId?: never;
} | {
  /** OMP prepares context before it assigns a journal row. This is a bridge
   * submission, not a native message ID; the real receipt arrives before HTTP. */
  readonly submissionId: string;
  readonly nativeMessageId?: never;
  readonly source?: never;
});

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
