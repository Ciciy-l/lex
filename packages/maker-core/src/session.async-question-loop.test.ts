import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import type { AgentEvent, InteractionDecision, InteractionResolver } from './types/events.js';
import type { Logger } from './interfaces/logger.js';
import type { ToolLoopReviewer } from './agents/shared/tool-loop-review.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

function setup(agentKind: 'pi' | 'codex' | 'claude-code' | 'omp', hangAbort = false, toolLoopReviewer?: ToolLoopReviewer) {
  vi.useFakeTimers();
  const queue = createAsyncQueue<AgentEvent>();
  let running = false;
  let resolveInteraction!: InteractionResolver;
  const handle = {
    id: 'native-session', agentKind, model: 'test-model',
    events: () => queue,
    send: vi.fn(async () => { running = true; }),
    abort: vi.fn(async () => {
      if (hangAbort) return new Promise<void>(() => {});
      running = false;
      queue.push({ type: 'done', data: {}, source: agentKind });
    }),
    close: vi.fn(async () => { running = false; queue.end(); }),
    isTurnRunning: () => running,
    setInteractionResolver(resolve: InteractionResolver) { resolveInteraction = resolve; },
  } as unknown as AgentSessionHandle;
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = new Session({
    id: 'test-session', agentKind, handle, workDir: '/test', capabilities: {} as never, logger, toolLoopReviewer,
  });
  sessions.push(session);
  const seen: AgentEvent[] = [];
  session.onEvent((event) => seen.push(event));
  const tool = async (id: string, extra: Partial<AgentEvent> = {}, name = 'read', input: unknown = { path: 'same.ts' }) => {
    queue.push({ type: 'tool_use', data: { toolUseId: id, toolName: name, input }, source: agentKind, ...extra });
    queue.push({ type: 'tool_result_full', data: { toolUseId: id, fullText: 'same result' }, source: agentKind, ...extra });
    queue.push({ type: 'tool_result', data: { toolUseIds: [id], summary: 'done' }, source: agentKind, ...extra });
    await vi.advanceTimersByTimeAsync(0);
  };
  const errors = () => seen.filter((event) => event.type === 'error');
  return { queue, session, seen, handle, tool, errors,
    ask: (delivery?: 'async') => resolveInteraction({ kind: 'ask_user_question', requestId: 'question',
      questions: [{ question: 'Scope?' }], ...(delivery ? { delivery } : {}) }),
    end: async () => {
      running = false;
      queue.push({ type: 'done', data: {}, source: agentKind });
      await vi.advanceTimersByTimeAsync(0);
    } };
}

describe.each(['pi', 'codex', 'omp'] as const)('%s Session tool loop coverage', (agentKind) => {
  it.each(['sync', 'async'] as const)('only suspends loop detection for a blocking question: %s', async (delivery) => {
    const t = setup(agentKind);
    let answer!: (decision: InteractionDecision) => void;
    t.session.setInteractionListener(() => new Promise((resolve) => { answer = resolve; }));
    await t.session.send('investigate');
    const pending = t.ask(delivery === 'async' ? delivery : undefined);
    for (let i = 0; i < 4; i++) await t.tool(`pending-${i}`);
    expect(t.handle.abort).toHaveBeenCalledTimes(delivery === 'async' ? 1 : 0);
    answer({ kind: 'ask_user_question', answers: {} });
    await pending;
    if (delivery === 'sync') {
      for (let i = 0; i < 4; i++) await t.tool(`resumed-${i}`);
      expect(t.handle.abort).toHaveBeenCalledOnce();
    }
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ data: { reason: 'tool_use_loop_detected' } });
  });

});
