import { CodexNativeInputConsumption } from './native-consumption.js';
import type { UserMessage } from '../../types/common.js';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type SendOptions } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import type { TurnSteerParams, TurnSteerResponse, UserInput } from './app-server/protocol.js';
import { prepareCodexNativeInput } from './native-input-content.js';

/** Main/Core-owned continuation; never accepted from renderer JSON. */
export const CODEX_NATIVE_STEER = Symbol('codexNativeSteer');
export type CodexNativeSteerOptions = SendOptions & { [CODEX_NATIVE_STEER]?: {
  input(message: UserMessage): UserInput[];
  start(params: TurnSteerParams): Promise<TurnSteerResponse>;
} };
export interface CodexNativeSteerRequest {
  params: TurnSteerParams;
  signal: AbortSignal;
  dispatch(params: TurnSteerParams): Promise<TurnSteerResponse>;
}

/** Preserve original message identity and run the normal product steering lifecycle. */
export class CodexNativeSteerAdmission {
  readonly consumption = new CodexNativeInputConsumption();
  private resolver?: AgentNativeInputResolver;
  private media?: AgentNativeMediaResolver;
  private pending = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly thread: () => string, private readonly turn: () => string | null,
    private readonly steer: (message: UserMessage, options: CodexNativeSteerOptions) => Promise<void>) {}
  bind(resolver: AgentNativeInputResolver, media?: AgentNativeMediaResolver): void {
    if (this.lifetime.signal.aborted) throw new TurnDispatchRejectedError('Native steering owner closed');
    if (this.resolver && this.resolver !== resolver) this.consumption.disconnect();
    this.resolver = resolver; this.media = media;
  }
  close(): void { this.lifetime.abort(); this.consumption.disconnect(); this.resolver = undefined; this.media = undefined; }
  async accept(request: CodexNativeSteerRequest): Promise<TurnSteerResponse> {
    const params = structuredClone(request.params), owner = this.resolver, media = this.media;
    const threadId = this.thread(), turnId = this.turn(), messageId = params.clientUserMessageId;
    const signal = AbortSignal.any([this.lifetime.signal, request.signal]);
    const check = () => {
      if (signal.aborted || !owner || this.resolver !== owner || this.thread() !== threadId
        || !turnId || this.turn() !== turnId) throw new TurnDispatchRejectedError('Native steering owner or turn changed');
    };
    check();
    const fields = new Set(['threadId', 'expectedTurnId', 'input', 'clientUserMessageId']);
    if (this.pending || params.threadId !== threadId || params.expectedTurnId !== turnId
      || typeof messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
      || !Array.isArray(params.input) || !params.input.length
      || Object.entries(params).some(([key, value]) => value != null && !fields.has(key))) {
      throw new TurnDispatchRejectedError('Native steering has no matching product reservation');
    }
    const consumption = this.consumption.begin(threadId, turnId!, messageId);
    this.pending = true;
    let accepted = false, forwarded = false, response: TurnSteerResponse | undefined;
    try {
      const { content, prepare } = await prepareCodexNativeInput(params.input, threadId, messageId, signal, check, media);
      check();
      await owner!({ nativeSessionId: threadId, nativeTurnId: turnId!, nativeMessageId: messageId,
        message: { type: 'user', content }, signal, consumption, accept: async (message, options) => {
          check();
          if (accepted || options.signal?.aborted) throw new TurnDispatchRejectedError('Native steering already admitted or cancelled');
          accepted = true;
          const combined = AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]);
          await this.steer(message, { ...options, signal: combined, messageUuid: messageId,
            [CODEX_NATIVE_STEER]: { input: prepare, start: async prepared => {
              check();
              if (forwarded || combined.aborted || prepared.threadId !== threadId || prepared.expectedTurnId !== turnId) {
                throw new TurnDispatchRejectedError('Native steering dispatch no longer current');
              }
              forwarded = true;
              const receipt = await request.dispatch({ ...prepared, clientUserMessageId: messageId });
              if (!receipt || receipt.turnId !== turnId) throw new TurnDispatchUnconfirmedError('Native steering receipt identity unconfirmed');
              response = receipt; return receipt;
            } },
          });
        } });
      if (response) return response;
      if (forwarded) throw new TurnDispatchUnconfirmedError('Native steering delivery uncertain');
      throw new TurnDispatchRejectedError('Native steering was not accepted');
    } catch (error) {
      // A confirmed native receipt is irreversible even if product persistence or
      // task closure subsequently failed. Never invite a duplicate native send.
      if (response) return response;
      if (forwarded && !(error instanceof TurnDispatchRejectedError)) {
        throw new TurnDispatchUnconfirmedError('Native steering delivery uncertain');
      }
      throw error;
    } finally {
      if (!response) this.consumption.uncertain(messageId);
      this.pending = false;
    }
  }
}
