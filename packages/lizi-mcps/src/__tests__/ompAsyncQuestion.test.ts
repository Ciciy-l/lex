import { describe, expect, it, vi } from 'vitest';
import { createOmpAsyncQuestionTools } from '../xdt-helper/omp-async-question.js';
import type { LiziMcpSessionContext } from '../types.js';

const context: LiziMcpSessionContext = { agentKind: 'omp', workingDir: '/remote/project',
  remoteHostId: 'ssh', sessionId: 'task', sessionInstanceId: 'instance',
  mcpCallerKind: 'root', mcpCallerAttested: true };
const args = { questions: [{ question: 'Which scope?' }] };

describe('OMP optional question host tool', () => {
  it('returns a pending receipt through the native bridge without invoking an approval', async () => {
    const ask = vi.fn(() => 'question-1');
    const tools = createOmpAsyncQuestionTools({ askUserQuestionAsync: ask }, context);
    expect(tools.map(t => t.name)).toEqual(['mcp__cindy_helper__ask_user_question_async']);
    const result = await tools[0].execute(args, { signal: new AbortController().signal });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, request_id: 'question-1', status: 'pending' }) }]);
    expect(ask).toHaveBeenCalledWith(context, args.questions);
  });

  it.each(['restricted', 'cancelled', 'descendant', 'spoofed', 'stale'] as const)('rejects %s calls', async (kind) => {
    const ask = vi.fn(() => { if (kind === 'stale') throw new Error('old instance'); return 'id'; });
    const controller = new AbortController();
    const [tool] = createOmpAsyncQuestionTools({ askUserQuestionAsync: ask,
      resolveSurface: async () => {
        if (kind === 'cancelled') controller.abort();
        return kind === 'restricted' ? 'restricted' : 'default';
      },
    }, { ...context, ...(kind === 'descendant' ? { mcpCallerKind: 'descendant' } : {}) });
    const result = await tool.execute(kind === 'spoofed' ? { ...args, sessionId: 'other' } : args, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(ask).toHaveBeenCalledTimes(kind === 'stale' ? 1 : 0);
  });
});
