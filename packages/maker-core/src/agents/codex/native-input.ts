import type { CodexNativeApprovalEvent, CodexNativeApprovalFrontend } from './native-approvals.js';
import { isDeepStrictEqual } from 'node:util';
import type { UserContentBlock, UserMessage } from '../../types/common.js';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError, type SendOptions, type AgentSessionHandle } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import type { TurnStartParams, TurnStartResponse, UserInput } from './app-server/protocol.js';

/** A host-only continuation. It cannot be constructed by a Renderer or vendor option. */
export const CODEX_NATIVE_TURN = Symbol('codexNativeTurn');
export interface CodexNativeTurnDispatch {
  input(message: UserMessage): UserInput[];
  start(params: TurnStartParams): Promise<TurnStartResponse>;
}
export type CodexNativeSendOptions = SendOptions & { [CODEX_NATIVE_TURN]?: CodexNativeTurnDispatch };
export interface CodexNativeTurnRequest {
  params: TurnStartParams;
  signal: AbortSignal;
  /** The gateway forwards once on the original TUI connection, preserving request ownership. */
  dispatch(params: TurnStartParams): Promise<TurnStartResponse>;
}
/** A frozen read of the actual task route, never a global preference. */
export interface CodexNativeRuntimeSnapshot {
  catalogModel: string;
  nativeModel: string;
  providerId: string | null;
  nativeModelProvider?: string;
  effort: string;
  fastMode: boolean;
}
/** Engine-specific host handle; this never becomes an IPC shape. */
export interface CodexNativeSessionHandle extends AgentSessionHandle {
  readNativeRuntimeSnapshot(): Readonly<CodexNativeRuntimeSnapshot>;
  attachNativeApprovalFrontend(receive: (event: CodexNativeApprovalEvent) => void): CodexNativeApprovalFrontend;
  acceptNativeTurn(request: CodexNativeTurnRequest): Promise<TurnStartResponse>;
  applyNativeRuntimeSettings(params: unknown, signal: AbortSignal): Promise<Record<string, never>>;
  interruptNativeTurn(params: unknown, signal: AbortSignal): Promise<Record<string, never>>;
}

/** Reuse the product reservation and normal Codex send policy before forwarding a native turn. */
export class CodexNativeInputAdmission {
  private resolver?: AgentNativeInputResolver;
  private importMedia?: AgentNativeMediaResolver;
  private pending = false;
  private closed = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly sessionId: () => string,
    private readonly send: (message: UserMessage, options: CodexNativeSendOptions) => Promise<void>) {}

  bind(resolver: AgentNativeInputResolver, importMedia?: AgentNativeMediaResolver): void {
    if (this.closed) throw new TurnDispatchRejectedError('Native Codex task is closed');
    this.resolver = resolver; this.importMedia = importMedia;
  }
  close(): void { this.closed = true; this.lifetime.abort(); this.resolver = undefined; this.importMedia = undefined; }

  async accept(request: CodexNativeTurnRequest): Promise<TurnStartResponse> {
    const owner = this.resolver, importer = this.importMedia, threadId = this.sessionId();
    const params = structuredClone(request.params);
    const messageId = params.clientUserMessageId;
    const signal = AbortSignal.any([request.signal, this.lifetime.signal]);
    const check = () => {
      if (this.closed || signal.aborted || owner !== this.resolver || threadId !== this.sessionId()) {
        throw new TurnDispatchRejectedError('Native Codex input owner is no longer active');
      }
    };
    check();
    if (!owner || this.pending || params.threadId !== threadId
      || typeof messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
      || !Array.isArray(params.input) || !params.input.length) {
      throw new TurnDispatchRejectedError('Native Codex input has no matching product reservation');
    }
    this.pending = true;
    let accepted = false, forwarded = false, response: TurnStartResponse | undefined;
    try {
      const content: UserContentBlock[] = [];
      const originals: Array<{ host: UserContentBlock; native: UserInput }> = [];
      for (const [index, block] of params.input.entries()) {
        check();
        let host: UserContentBlock;
        if (block.type === 'text' && typeof block.text === 'string') host = { type: 'text', text: block.text };
        else if ((block.type === 'skill' || block.type === 'mention') && typeof block.name === 'string' && typeof block.path === 'string') {
          host = { type: 'mention', name: block.name, path: block.path };
        } else if ((block.type === 'image' || block.type === 'localImage') && importer) {
          host = await importer({ sessionId: threadId, messageId, index, block: structuredClone(block), signal });
          check();
          if (host.type !== 'image') throw new TurnDispatchRejectedError('Native Codex image identity changed');
        } else throw new TurnDispatchRejectedError('Native Codex input requires a supported host importer');
        content.push(host); originals.push({ host: structuredClone(host), native: block });
      }
      const prepare = (message: UserMessage): UserInput[] => {
        const remaining = [...originals];
        const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
        return blocks.map(block => {
          const index = remaining.findIndex(original => isDeepStrictEqual(original.host, block));
          if (index >= 0) return structuredClone(remaining.splice(index, 1)[0]!.native);
          if (block.type === 'text') return { type: 'text', text: block.text };
          throw new TurnDispatchRejectedError('Native Codex input cannot introduce an unprepared attachment');
        });
      };
      await owner({ nativeSessionId: threadId, nativeMessageId: messageId, message: { type: 'user', content }, signal,
        accept: async (message, options) => {
          check();
          if (accepted || options.signal?.aborted) throw new TurnDispatchRejectedError('Native Codex input was already admitted or cancelled');
          accepted = true;
          await this.send(message, { ...options, messageUuid: messageId, throwOnStartFailure: true,
            signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
            [CODEX_NATIVE_TURN]: { input: prepare, start: async prepared => {
              check();
              if (forwarded || options.signal?.aborted || prepared.threadId !== threadId) {
                throw new TurnDispatchRejectedError('Native Codex input dispatch is no longer current');
              }
              forwarded = true;
              response = await request.dispatch({ ...prepared, clientUserMessageId: messageId });
              return response;
            } },
          });
        },
      });
      if (!response) {
        if (forwarded) throw new TurnDispatchUnconfirmedError('Native Codex acceptance is unconfirmed');
        throw new TurnDispatchRejectedError('Native Codex input was not accepted');
      }
      return response;
    } catch (error) {
      // A lost gateway response cannot become a normal retryable queue entry.
      if (forwarded && !response && !(error instanceof TurnDispatchRejectedError)) {
        throw new TurnDispatchUnconfirmedError('Native Codex acceptance is unconfirmed');
      }
      throw error;
    } finally { this.pending = false; }
  }
}
