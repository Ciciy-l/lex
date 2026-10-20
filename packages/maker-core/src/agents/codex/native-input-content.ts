import { isDeepStrictEqual } from 'node:util';
import type { UserContentBlock, UserMessage } from '../../types/common.js';
import { TurnDispatchRejectedError } from '../base-agent.js';
import type { AgentNativeMediaResolver } from '../native-input.js';
import type { UserInput } from './app-server/protocol.js';

/** Native metadata survives unchanged unless product preparation rewrites that block. */
export async function prepareCodexNativeInput(input: UserInput[], threadId: string, messageId: string,
  signal: AbortSignal, check: () => void, importer?: AgentNativeMediaResolver) {
  const content: UserContentBlock[] = [];
  const originals: Array<{ host: UserContentBlock; native: UserInput }> = [];
  for (const [index, block] of input.entries()) {
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
  return { content, prepare };
}
