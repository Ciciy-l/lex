import { isDeepStrictEqual } from 'node:util';
import type { CommandExecutionRequestApprovalResponse } from './app-server/protocol.js';

export interface CodexNativeApprovalRequest {
  id: string | number;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
  params: Record<string, unknown>;
}
export type CodexNativeApprovalDecision = CommandExecutionRequestApprovalResponse['decision'];
export interface CodexNativeApprovalResponse { decision: CodexNativeApprovalDecision }
export interface CodexNativeInteractionRequest {
  id: string | number;
  method: 'item/permissions/requestApproval' | 'mcpServer/elicitation/request' | 'item/tool/requestUserInput';
  params: Record<string, unknown>;
}
export type CodexNativePromptRequest = CodexNativeApprovalRequest | CodexNativeInteractionRequest;
export type CodexNativeApprovalEvent = { kind: 'request'; request: CodexNativePromptRequest }
  | { kind: 'resolved'; id: string | number; threadId: string };
export interface CodexNativeApprovalFrontend {
  answer(id: string | number, response: unknown): boolean;
  detach(): void;
}
interface Entry {
  request: CodexNativePromptRequest;
  prepare: (response: unknown) => (() => void) | undefined;
}

/**
 * Native choices become eligible only at the existing host's human-confirmation
 * boundary. This is not a second policy engine and never writes to app-server.
 * The ordinary host callback remains the sole upstream response writer.
 */
export class CodexNativeApprovals {
  private readonly pending = new Map<string | number, Entry>();
  private readonly frontends = new Map<(event: CodexNativeApprovalEvent) => void, Set<string | number>>();
  private closed = false;

  open(request: CodexNativeApprovalRequest, options: {
    allowPersistent: boolean;
    accept: (response: CodexNativeApprovalResponse, behavior: 'allow' | 'deny', session: boolean) => void;
  }): { close(): void } {
    const copy = structuredClone(request);
    const advertised = Array.isArray(copy.params.availableDecisions) ? copy.params.availableDecisions
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const decisions = advertised.filter(decision => {
      if (decision === 'accept' || decision === 'decline' || decision === 'cancel') return true;
      if (!options.allowPersistent) return false;
      if (decision === 'acceptForSession') return true;
      // Preserve native rule/network proposals only when the server advertised
      // that exact value. The frontend cannot invent a broader amendment.
      return request.method === 'item/commandExecution/requestApproval'
        && amendmentBehavior(decision) !== null;
    });
    copy.params.availableDecisions = decisions;
    return this.register(copy, response => {
      if (!record(response) || Object.keys(response).length !== 1 || !('decision' in response)
        || !decisions.some(value => isDeepStrictEqual(value, response.decision))) return undefined;
      const decision = structuredClone(response.decision) as CodexNativeApprovalDecision;
      const behavior = typeof decision === 'string'
        ? decision === 'decline' || decision === 'cancel' ? 'deny' : 'allow'
        : amendmentBehavior(decision)!;
      return () => options.accept({ decision }, behavior, decision === 'acceptForSession');
    });
  }

  /** Only the existing request owner opens this after its policy checks. */
  openInteraction<T>(request: CodexNativeInteractionRequest, options: {
    normalize(response: unknown): T | undefined;
    accept(response: T): void;
  }): { close(): void } {
    return this.register(structuredClone(request), response => {
      const answer = options.normalize(response);
      return answer === undefined ? undefined : () => options.accept(answer);
    });
  }

  private register(copy: CodexNativePromptRequest, prepare: Entry['prepare']): { close(): void } {
    if (this.closed || this.pending.has(copy.id) || this.pending.size >= 128
      || (typeof copy.id !== 'string' && !Number.isSafeInteger(copy.id))
      || typeof copy.params.threadId !== 'string' || !copy.params.threadId) {
      throw new Error('Native Codex approval owner unavailable');
    }
    const entry: Entry = { request: copy, prepare };
    this.pending.set(copy.id, entry);
    // Do not call a frontend reentrantly before the owner has its close handle.
    queueMicrotask(() => { if (this.pending.get(copy.id) === entry) this.emit({ kind: 'request', request: copy }); });
    return { close: () => {
      if (this.pending.get(copy.id) !== entry) return;
      this.pending.delete(copy.id);
      this.emit({ kind: 'resolved', id: copy.id, threadId: copy.params.threadId as string });
    } };
  }

  attach(receive: (event: CodexNativeApprovalEvent) => void): CodexNativeApprovalFrontend {
    if (this.closed || this.frontends.size >= 128) throw new Error('Native Codex approval owner closed or full');
    // A distinct wrapper makes independently attached frontends independent
    // even if their caller supplies the same function.
    const sink = (event: CodexNativeApprovalEvent) => receive(structuredClone(event));
    this.frontends.set(sink, new Set());
    for (const entry of [...this.pending.values()]) {
      if (this.pending.get(entry.request.id) === entry) {
        this.deliver(sink, { kind: 'request', request: entry.request });
      }
    }
    return {
      answer: (id, response) => {
        if (this.closed || !this.frontends.has(sink)) return false;
        const entry = this.pending.get(id);
        if (!entry) return false;
        const accept = entry.prepare(response);
        if (!accept) return false;
        // Revoke first: observer/callback reentrancy cannot accept twice.
        this.pending.delete(id);
        try { accept(); }
        finally { this.emit({ kind: 'resolved', id, threadId: entry.request.params.threadId as string }); }
        return true;
      },
      detach: () => { this.frontends.delete(sink); },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const prior = [...this.pending.values()]; this.pending.clear();
    for (const entry of prior) this.emit({ kind: 'resolved', id: entry.request.id, threadId: entry.request.params.threadId as string });
    this.frontends.clear();
  }
  private emit(event: CodexNativeApprovalEvent): void {
    for (const sink of [...this.frontends.keys()]) this.deliver(sink, event);
  }
  private deliver(sink: (event: CodexNativeApprovalEvent) => void, event: CodexNativeApprovalEvent): void {
    const delivered = this.frontends.get(sink);
    if (!delivered) return;
    if (event.kind === 'request') {
      if (this.pending.get(event.request.id)?.request !== event.request) return;
      if (delivered.has(event.request.id)) return;
      delivered.add(event.request.id);
    } else if (!delivered.delete(event.id)) return;
    try { sink(event); } catch { this.frontends.delete(sink); }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// These are the structured variants exported by the managed native protocol.
// A network policy amendment may DENY a host; it is not necessarily approval.
function amendmentBehavior(value: unknown): 'allow' | 'deny' | null {
  if (!record(value) || Object.keys(value).length !== 1) return null;
  if (record(value.acceptWithExecpolicyAmendment)) {
    const amendment = value.acceptWithExecpolicyAmendment.execpolicy_amendment;
    return Array.isArray(amendment) && amendment.length > 0
      && amendment.every(part => typeof part === 'string') ? 'allow' : null;
  }
  if (record(value.applyNetworkPolicyAmendment)) {
    const amendment = value.applyNetworkPolicyAmendment.network_policy_amendment;
    if (record(amendment) && typeof amendment.host === 'string' && amendment.host.length > 0
      && (amendment.action === 'allow' || amendment.action === 'deny')) return amendment.action;
  }
  return null;
}
