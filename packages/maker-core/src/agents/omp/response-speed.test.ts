import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmpTranslator } from './translator.js';
import { createConsoleLogger } from '../../interfaces/logger.js';

afterEach(() => vi.useRealTimers());
describe('OMP observed response speed', () => {
  it('calibrates only streamed output, excluding tools and request waiting, and resets each turn', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const t = new OmpTranslator({ logger: createConsoleLogger('speed') });
    const frame = (type: string, extra = {}) => t.translate({ type, ...extra });
    const delta = () => frame('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hello world' } });
    frame('agent_start');
    vi.setSystemTime(2000); delta();
    vi.setSystemTime(4000); delta();
    frame('message_end', { message: { id: 'first', role: 'assistant', usage: { output: 100 } } });
    frame('tool_execution_start', { toolCallId: 'a', toolName: 'read' });
    expect(t.getUsageSnapshot().responseSpeed).toMatchObject({ toolActive: true, durationMs: 2000 });
    vi.setSystemTime(9000); frame('tool_execution_end', { toolCallId: 'a', result: 'large tool output' });
    expect(t.getUsageSnapshot().responseSpeed).toMatchObject({ phase: 'waiting', outputTokens: 100 });
    vi.setSystemTime(10000); delta();
    vi.setSystemTime(11000);
    frame('message_end', { message: { id: 'last', role: 'assistant', usage: { output: 50 } } });
    frame('agent_end');
    expect(t.getUsageSnapshot().responseSpeed).toMatchObject({ phase: 'complete', firstResponseMs: 1000,
      outputTokens: 150, durationMs: 3000, averageRate: 50, estimated: false });
    frame('auto_retry_start');
    expect(t.getUsageSnapshot().responseSpeed?.phase).toBe('complete');
    frame('agent_start');
    expect(t.getUsageSnapshot().responseSpeed).toMatchObject({ outputTokens: 0, firstResponseMs: null, phase: 'waiting' });
  });

  it('does not invent TPS for a response with only terminal usage', () => {
    const t = new OmpTranslator({ logger: createConsoleLogger('speed') });
    t.translate({ type: 'agent_start' });
    t.translate({ type: 'message_end', message: { role: 'assistant', usage: { output: 300 } } });
    t.translate({ type: 'agent_end' });
    expect(t.getUsageSnapshot().responseSpeed).toMatchObject({ outputTokens: 300, averageRate: null, recentRate: null, samples: [] });
  });
});
