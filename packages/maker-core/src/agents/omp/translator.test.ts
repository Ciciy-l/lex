import { describe, expect, it } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';
import { isOmpRecord } from './commands.js';
import {
  extractOmpMessageText,
  OmpTranslator,
  redactOmpText,
  stringifyOmpToolResult,
} from './translator.js';

function translator(): OmpTranslator {
  return new OmpTranslator({ logger: createConsoleLogger('omp-test') });
}

function events(result: ReturnType<OmpTranslator['translate']>): readonly AgentEvent[] {
  return result.kind === 'events' ? result.events : [];
}

/** 读事件 data 上的字符串字段（data 是 unknown，测试里也不做断言式 cast）。 */
function textField(event: AgentEvent | undefined, key: string): string {
  const data = event?.data;
  if (!isOmpRecord(data)) return '';
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

describe('OmpTranslator streaming subtypes', () => {
  it('maps text_delta to an incremental text event', () => {
    const result = translator().translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
    expect(result.kind).toBe('events');
    expect(events(result)).toHaveLength(1);
    expect(events(result)[0]?.type).toBe('text');
    expect(events(result)[0]?.data).toMatchObject({ text: 'hello', isFinal: false });
  });

  it('maps thinking_delta to a thinking event', () => {
    const result = translator().translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
    });
    expect(events(result)[0]?.type).toBe('thinking');
    expect(events(result)[0]?.data).toMatchObject({ stage: 'delta', text: 'hmm' });
  });

  it('drops toolcall_delta instead of emitting a duplicate tool card', () => {
    const result = translator().translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path":' },
    });
    expect(result.kind).toBe('ignored');
  });

  it('drops unknown subtypes and malformed frames', () => {
    const instance = translator();
    expect(instance.translate({ type: 'message_update' }).kind).toBe('ignored');
    expect(
      instance.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'future_subtype', delta: 'x' },
      }).kind,
    ).toBe('ignored');
    expect(instance.translate({}).kind).toBe('ignored');
  });

  it('emits a full text event only when no delta was streamed', () => {
    const streamed = translator();
    streamed.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
    });
    expect(
      events(
        streamed.translate({
          type: 'message_end',
          message: { role: 'assistant', content: 'partial but complete' },
        }),
      ),
    ).toHaveLength(0);

    const fresh = translator();
    const result = fresh.translate({
      type: 'message_end',
      message: { role: 'assistant', content: 'only full text' },
    });
    expect(events(result)[0]?.data).toMatchObject({ text: 'only full text', isFullText: true });
  });
});

describe('OmpTranslator tool lifecycle', () => {
  it('emits tool_use, bounded partial output and a terminal tool_result', () => {
    const instance = translator();
    const start = instance.translate({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: 'hello.txt' },
      intent: 'Create hello.txt with text hi',
    });
    expect(events(start)[0]).toMatchObject({
      type: 'tool_use',
      data: { toolUseId: 'call-1', toolName: 'write', intent: 'Create hello.txt with text hi' },
    });

    const update = instance.translate({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: 'writing…',
      details: { resolvedPath: 'C:\\work\\hello.txt' },
    });
    expect(events(update)[0]).toMatchObject({
      type: 'tool_result_full',
      data: { fullText: 'writing…', partial: true, resolvedPath: 'C:\\work\\hello.txt' },
    });

    const end = instance.translate({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    });
    const produced = events(end);
    expect(produced.map((event) => event.type)).toEqual(['tool_result_full', 'tool_result']);
    expect(produced[0]?.data).toMatchObject({ fullText: 'done', isError: false });
    expect(produced[1]?.data).toMatchObject({ summary: 'done', toolUseIds: ['call-1'] });
  });

  it('marks tool errors and truncates oversized output', () => {
    const instance = translator();
    const result = instance.translate({
      type: 'tool_execution_end',
      toolCallId: 'call-2',
      result: 'x'.repeat(40_000),
      isError: true,
    });
    const full = events(result)[0];
    expect(full?.data).toMatchObject({ isError: true, truncated: true });
    const text = textField(full, 'fullText');
    expect(text.length).toBeLessThan(31_000);
    expect(text).toContain('truncated by Lex');
    expect(events(result)[1]?.data).toMatchObject({ summary: 'failed' });
  });
});

describe('OmpTranslator terminal and error frames', () => {
  it('routes extension_ui_request to the bridge instead of the event stream', () => {
    const result = translator().translate({
      type: 'extension_ui_request',
      id: '157cf60a9ce9ac08',
      method: 'select',
      title: 'Allow tool: write\nPath: hello.txt',
      options: ['Approve', 'Deny'],
    });
    expect(result.kind).toBe('ui-request');
    if (result.kind !== 'ui-request') throw new Error('expected a ui request');
    expect(result.request.method).toBe('select');
    expect(result.request.options).toEqual(['Approve', 'Deny']);
  });

  it('drops malformed interaction frames without responding', () => {
    expect(translator().translate({ type: 'extension_ui_request', method: 'select' }).kind).toBe(
      'ignored',
    );
  });

  it('emits a terminal error for an OMP error message and redacts secrets', () => {
    const result = translator().translate({
      type: 'message_end',
      message: {
        id: 'm-1',
        role: 'assistant',
        stopReason: 'error',
        errorStatus: 401,
        errorMessage: '401 Incorrect API key provided: sk-ant-abc1234567890def',
      },
    });
    const produced = events(result);
    expect(produced[0]?.type).toBe('error');
    expect(produced[0]?.data).toMatchObject({ isTerminal: true });
    const text = textField(produced[0], 'message');
    expect(text).not.toContain('sk-ant-abc1234567890def');
    expect(text).toContain('[redacted]');
  });

  it('drops a duplicate message_end (replay / re-projection guard)', () => {
    const instance = translator();
    const frame = {
      type: 'message_end',
      message: { id: 'dup-1', role: 'assistant', content: 'once' },
    };
    expect(events(instance.translate(frame))).toHaveLength(1);
    expect(instance.translate(frame).kind).toBe('ignored');
  });

  it('emits done at a terminal agent_end and ignores non-terminal ones', () => {
    const instance = translator();
    instance.translate({ type: 'agent_start' });
    expect(instance.isStreaming()).toBe(true);
    expect(instance.translate({ type: 'agent_end', isTerminal: false }).kind).toBe('ignored');
    const done = instance.translate({ type: 'agent_end', isTerminal: true });
    expect(events(done).map((event) => event.type)).toEqual(['status', 'done']);
    expect(events(done)[0]?.data).toMatchObject({ status: 'Done', isRunning: false });
    expect(instance.isStreaming()).toBe(false);
  });

  it('projects the synthesized prompt-failure frame as a terminal error', () => {
    const result = translator().translate({
      type: 'omp_prompt_failure',
      id: 'omp-1',
      command: 'prompt',
      message: 'OMP prompt execution failed',
    });
    expect(events(result)[0]).toMatchObject({ type: 'error' });
  });

  it('projects auto compaction as a compact_boundary', () => {
    expect(events(translator().translate({ type: 'auto_compaction_start' }))[0]?.type).toBe(
      'compact_boundary',
    );
  });

  it('accumulates usage across messages', () => {
    const instance = translator();
    instance.translate({
      type: 'message_end',
      message: {
        id: 'u-1',
        role: 'assistant',
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 },
      },
    });
    const snapshot = instance.getUsageSnapshot();
    expect(snapshot.tokenUsage).toBe(120);
    expect(snapshot.contextTokens).toBe(106);
    expect(snapshot.outputTokens).toBe(20);
  });
});

describe('OmpTranslator helpers', () => {
  it('stringifies every tool result shape', () => {
    expect(stringifyOmpToolResult('plain')).toBe('plain');
    expect(stringifyOmpToolResult({ content: [{ type: 'text', text: 'a' }] })).toBe('a');
    expect(stringifyOmpToolResult({ text: 'b' })).toBe('b');
    expect(stringifyOmpToolResult(undefined)).toBe('');
  });

  it('extracts only text blocks from a message', () => {
    expect(
      extractOmpMessageText({
        content: [{ type: 'text', text: 'a' }, { type: 'image', path: 'x.png' }],
      }),
    ).toBe('a');
  });

  it('redacts long hex blobs as well as key-shaped tokens', () => {
    expect(redactOmpText('token 0123456789abcdef0123456789abcdef')).toContain('[redacted]');
    expect(redactOmpText('key sk-ant-abc1234567890def leaked')).toContain('[redacted]');
  });
});
