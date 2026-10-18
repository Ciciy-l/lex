import type { ClaudeBridgeEvent, ClaudeNativeCommand } from './native-bridge.js';
import { CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME } from './native-mod-source.js';
import { projectClaudeNativeMessage, type ClaudeBridgeSubmission, type ClaudeMessageProjection, type ClaudeNativeMessageRow } from './native-message-projection.js';

export interface ClaudeNativeSubmission {
  /** Existing host queue/message identity; never inferred from text. */
  messageId: string;
  text: string;
  imagePaths?: readonly string[];
  /** Display input before native plugin wrapping, including managed attachments. */
  originalContent: readonly unknown[];
}

export interface ClaudeNativeUserMessage {
  row: ClaudeNativeMessageRow;
  display: ClaudeMessageProjection;
  /** Persist beside the native row; only this authenticated association hides the built-in source. */
  submission?: ClaudeBridgeSubmission;
}

interface PendingSubmission {
  input: ClaudeNativeSubmission;
  nativeMessageId?: string;
}

/** Runtime-scoped associations. A lost receipt never permits input replay. */
export class ClaudeNativeMessages {
  private readonly pending = new Map<number, PendingSubmission>();
  constructor(private readonly sessionId: string, private readonly onMessage: (message: ClaudeNativeUserMessage) => void) {}

  submit(input: ClaudeNativeSubmission, enqueue: (payload: unknown) => ClaudeNativeCommand): Promise<{ nativeMessageId: string }> {
    if (this.pending.size >= 128) throw new Error('Native input identity queue full');
    if (typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 256
      || typeof input.text !== 'string' || !Array.isArray(input.originalContent)) throw new Error('Invalid native input');
    if ([...this.pending.values()].some(entry => entry.input.messageId === input.messageId)) {
      throw new Error('Native input already pending');
    }
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > 1_048_576) throw new Error('Native input exceeds identity limit');
    const owned = JSON.parse(encoded) as ClaudeNativeSubmission;
    const command = enqueue({ text: owned.text, ...(owned.imagePaths ? { imagePaths: owned.imagePaths } : {}) });
    const pending: PendingSubmission = { input: owned };
    this.pending.set(command.id, pending);
    // Keep unresolved associations after a timeout: the native process may still
    // append this input. Only its explicit receipt or runtime disposal retires it.
    return command.result.then(() => {
      if (!pending.nativeMessageId) throw new Error('Native input was not recorded');
      return { nativeMessageId: pending.nativeMessageId };
    });
  }

  accept(event: ClaudeBridgeEvent): void {
    const value = record(event.value);
    if (!value) return;
    if (event.kind === 'command-result') {
      if (Number.isSafeInteger(value.id)) this.pending.delete(value.id as number);
      return;
    }
    if (event.kind !== 'session.append') return;
    const result = record(value.result), message = record(result?.message), origin = record(value.origin);
    // Use the row actually accepted by native hooks, not the pre-hook proposal.
    if (!result || typeof result.uuid !== 'string' || !result.uuid || result.uuid !== value.uuid
      || !message || message.type !== 'user' || message.isMeta === true || !Array.isArray(message.content)
      || value.agentId !== undefined || typeof value.door !== 'string'
      || !origin || typeof origin.kind !== 'string'
      || (origin.name !== undefined && typeof origin.name !== 'string')) return;
    // Tool-result/meta rows are not new user inputs. Native commands and plugin
    // prompts keep their original provenance; no envelope parsing is involved.
    if (value.door !== 'prompt' && value.door !== 'command') return;
    const row: ClaudeNativeMessageRow = { sessionId: this.sessionId, uuid: result.uuid, door: value.door,
      origin: origin as ClaudeNativeMessageRow['origin'], message: message as unknown as ClaudeNativeMessageRow['message'] };
    const pending = Number.isSafeInteger(value.submissionId) ? this.pending.get(value.submissionId as number) : undefined;
    let submission: ClaudeBridgeSubmission | undefined;
    if (pending && !pending.nativeMessageId && origin.kind === 'plugin' && origin.name === CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME
      && (pending.input.imagePaths ? value.door === 'command' && value.submissionKind === 'media' : value.door === 'prompt')) {
      pending.nativeMessageId = row.uuid;
      submission = { sessionId: this.sessionId, nativeMessageId: row.uuid, submissionId: pending.input.messageId,
        pluginName: CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, originalContent: pending.input.originalContent,
        ...(pending.input.imagePaths ? { inputKind: 'media' as const } : {}) };
    }
    this.onMessage({ row, display: projectClaudeNativeMessage(row, CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, submission),
      ...(submission ? { submission } : {}) });
  }

  close(): void { this.pending.clear(); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
