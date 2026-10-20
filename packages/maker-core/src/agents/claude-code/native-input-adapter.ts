import { isDeepStrictEqual } from 'node:util';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import type { UserContentBlock } from '../../types/common.js';
import type { ClaudeNativeInputPreparation } from './native-input-preparation.js';
import { claudeNativeMessageSource } from './native-messages.js';

/** Host owns media bytes/paths. Core only pairs the returned identity to its native block. */
export type ImportClaudeNativeMedia = AgentNativeMediaResolver;

/** Original native composer -> product Session -> exact pre-append continuation. */
export async function resolveClaudeNativeInput(
  input: ClaudeNativeInputPreparation, resolve: AgentNativeInputResolver, importMedia?: ImportClaudeNativeMedia,
): Promise<void> {
  const content: UserContentBlock[] = [];
  const media: Array<{ host: UserContentBlock; native: unknown }> = [];
  for (const [index, raw] of input.row.message.content.entries()) {
    if (input.signal.aborted) throw new Error('Native input cancelled');
    const block = raw as { type?: string; text?: unknown } | null;
    if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
    else if ((block?.type === 'image' || block?.type === 'document') && importMedia) {
      const host = await importMedia({ sessionId: input.row.sessionId, messageId: input.row.uuid, index,
        block: structuredClone(raw), signal: input.signal });
      if (input.signal.aborted) throw new Error('Native input cancelled');
      if ((block.type === 'image' && host.type !== 'image') || (block.type === 'document' && host.type !== 'file')) {
        throw new Error('Native media identity changed');
      }
      media.push({ host: structuredClone(host), native: raw }); content.push(host);
    } else throw new Error('Native input block requires a supported host importer');
  }
  await resolve({ nativeSessionId: input.row.sessionId, nativeMessageId: input.row.uuid,
    message: { type: 'user', content }, signal: input.signal,
    source: claudeNativeMessageSource({ row: input.row, display: { content: input.row.message.content } }),
    accept: async (message, options) => {
      if (input.signal.aborted || options.signal?.aborted) throw new Error('Native input cancelled');
      const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
      const available = [...media];
      const rewritten = blocks.map(block => {
        if (block.type === 'text') return block;
        const index = available.findIndex(candidate => isDeepStrictEqual(candidate.host, block));
        if (index < 0) throw new Error('Native input cannot introduce or replace an attachment');
        return available.splice(index, 1)[0]!.native;
      });
      await input.accept(rewritten, options.signal);
    },
  });
}
