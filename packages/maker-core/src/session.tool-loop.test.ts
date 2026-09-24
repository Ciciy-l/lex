import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import { OmpTranslator } from './agents/omp/translator.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import type { AgentEvent } from './types/events.js';
import { createConsoleLogger } from './interfaces/logger.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

describe('Session tool loop detection', () => {
  it('counts OMP terminal results, not partial updates, and interrupts after the matching summary', async () => {
    vi.useFakeTimers();
    const queue = createAsyncQueue<AgentEvent>();
    let running = false;
    const handle = {
      id: 'omp-session', agentKind: 'omp', model: 'test-model', events: () => queue,
      send: vi.fn(async () => { running = true; }),
      abort: vi.fn(async () => { running = false; }),
      close: vi.fn(async () => { running = false; queue.end(); }),
      isTurnRunning: () => running, setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({ id: 'loop-test', agentKind: 'omp', handle, workDir: '/test', capabilities: {} as never, logger: createConsoleLogger('loop-test') });
    sessions.push(session);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));
    const translator = new OmpTranslator({ logger: createConsoleLogger('omp-loop-test') });
    const emit = async (frame: Record<string, unknown>) => {
      const result = translator.translate(frame);
      if (result.kind === 'events') for (const event of result.events) queue.push(event);
      await vi.advanceTimersByTimeAsync(0);
    };
    await session.send('investigate');
    for (let index = 0; index < 4; index += 1) {
      const toolCallId = `tool-${index}`;
      await emit({ type: 'tool_execution_start', toolCallId, toolName: 'read', args: { path: 'same.ts' } });
      await emit({ type: 'tool_execution_update', toolCallId, partialResult: `progress-${index}` });
      await emit({ type: 'tool_execution_end', toolCallId, result: 'same result', isError: false });
    }
    const errorIndex = seen.findIndex((event) => event.type === 'error');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(seen.slice(0, errorIndex).filter((event) => event.type === 'tool_result_full')).toHaveLength(8);
    const summaryIndices = seen.flatMap((event, index) => event.type === 'tool_result' ? [index] : []);
    expect(summaryIndices).toHaveLength(4);
    expect(summaryIndices.at(-1)).toBe(errorIndex - 1);
    for (const summaryIndex of summaryIndices) {
      const summary = seen[summaryIndex];
      const data = summary.data as { toolUseIds?: unknown };
      const toolUseId = Array.isArray(data.toolUseIds) ? data.toolUseIds[0] : undefined;
      const fullIndex = seen.findIndex((event, index) =>
        index < summaryIndex && event.type === 'tool_result_full' &&
        (event.data as { toolUseId?: unknown; partial?: unknown }).toolUseId === toolUseId &&
        (event.data as { partial?: unknown }).partial !== true,
      );
      expect(fullIndex).toBeGreaterThanOrEqual(0);
    }
    expect(seen[errorIndex]).toMatchObject({
      type: 'error', source: 'omp',
      data: { reason: 'tool_use_loop_detected', isTerminal: true, toolLoop: { kind: 'consecutive', count: 4 } },
    });
    expect(handle.abort).toHaveBeenCalledOnce();
  });
});
