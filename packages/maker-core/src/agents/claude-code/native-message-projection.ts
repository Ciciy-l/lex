/** GUI-only projection of a native Claude row. Never write this back to Claude. */
export interface ClaudeNativeMessageRow {
  sessionId: string;
  uuid: string;
  agentId?: string;
  door: string;
  origin: { kind: string; name?: string };
  message: { type: string; isMeta?: boolean; content: readonly unknown[] };
}

/**
 * Host-owned association, produced by the authenticated built-in bridge when
 * its serialized submission enters session.append. Persist with that message
 * for history/remote display; never accept a renderer-supplied association.
 * A plugin name alone is not evidence that Lex submitted this row.
 */
export interface ClaudeBridgeSubmission {
  sessionId: string;
  nativeMessageId: string;
  submissionId: string;
  pluginName: string;
  /** Set by the host only when the authenticated command expands staged media. */
  inputKind?: 'text' | 'media';
  originalContent: readonly unknown[];
}

export interface ClaudeMessageProjection {
  content: readonly unknown[];
  pluginSource?: string;
}

export function projectClaudeNativeMessage(
  row: ClaudeNativeMessageRow,
  /** Identity of the built-in plugin actually installed by this host. */
  bridgePluginName: string,
  submission?: ClaudeBridgeSubmission,
): ClaudeMessageProjection {
  const pluginSource = row.origin.kind === 'plugin' ? row.origin.name : undefined;
  if (submission && bridgePluginName.length > 0 && submission.submissionId.length > 0
    && row.sessionId === submission.sessionId && row.uuid === submission.nativeMessageId
    && !row.agentId && (row.door === 'prompt' || (row.door === 'command' && submission.inputKind === 'media'))
    && row.message.type === 'user' && !row.message.isMeta
    && row.origin.kind === 'plugin' && pluginSource === bridgePluginName
    && submission.pluginName === bridgePluginName) {
    // Original input includes attachments and literal plugin-looking text. No
    // envelope regex, trimming, native history mutation, or model-input rewrite.
    return { content: submission.originalContent };
  }
  return { content: row.message.content, ...(pluginSource !== undefined ? { pluginSource } : {}) };
}
