import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OmpRpcClient,
  type OmpRpcTransport,
  type OmpUiResponse,
} from './rpc-client.js';

function fixture() {
  const lines = new Set<(line: string) => void>();
  const closes = new Set<() => void>();
  const writeLine = vi.fn<(line: string) => void>();
  const transport: OmpRpcTransport = {
    writeLine,
    onLine: (listener) => {
      lines.add(listener);
      return () => {
        lines.delete(listener);
      };
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => {
        closes.delete(listener);
      };
    },
  };
  const events = vi.fn();
  const closed = vi.fn();
  const client = new OmpRpcClient(transport, events, closed);
  return {
    client,
    writeLine,
    events,
    closed,
    lines,
    closes,
    emit: (value: unknown) => {
      for (const listener of lines) listener(JSON.stringify(value));
    },
    disconnect: () => {
      for (const listener of closes) listener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OMP RPC command channel', () => {
  it.each([
    { value: 'x', confirmed: true },
    { value: 'x', cancelled: true },
    { confirmed: false, cancelled: true },
    { value: 'x', confirmed: undefined },
    { value: 'x', timedOut: true },
    { cancelled: true, timedOut: 'yes' },
    { value: 'x', type: 'abort' },
  ])(
    'rejects ambiguous or malformed UI responses before writing: %j',
    (response) => {
      const test = fixture();
      expect(() =>
        test.client.respondToUi('interaction', response as OmpUiResponse),
      ).toThrow('Invalid OMP interaction response');
      expect(test.writeLine).not.toHaveBeenCalled();
      test.client.close();
    },
  );
  it('correlates overlapping reads by both ID and command', async () => {
    const test = fixture();
    const first = test.client.request({ type: 'get_available_commands' });
    const second = test.client.request({ type: 'get_state' });
    test.emit({
      type: 'response',
      id: second.id,
      command: 'get_state',
      success: true,
      data: { sessionId: 'native-omp' },
    });
    test.emit({
      type: 'response',
      id: first.id,
      command: 'get_available_commands',
      success: true,
      data: { commands: [] },
    });
    expect((await second.response).data).toEqual({ sessionId: 'native-omp' });
    expect((await first.response).data).toEqual({ commands: [] });
    test.client.close();
  });

  it('preserves the slash invocation and distinguishes ACK from later local-only completion', async () => {
    const test = fixture();
    const message = '  /plan off  keep spacing\nnext line';
    const request = test.client.request({ type: 'prompt', message });
    expect(JSON.parse(test.writeLine.mock.calls[0][0])).toEqual({
      type: 'prompt',
      id: request.id,
      message,
    });
    test.emit({
      type: 'response',
      id: request.id,
      command: 'prompt',
      success: true,
    });
    expect((await request.response).data).toBeUndefined();
    expect(test.events).not.toHaveBeenCalled();
    const localOnly = {
      type: 'prompt_result',
      id: request.id,
      agentInvoked: false,
    };
    test.emit(localOnly);
    expect(test.events).toHaveBeenLastCalledWith(localOnly);
    test.client.close();
  });

  it.each([
    'command_output',
    'config_update',
    'session_info_update',
    'available_commands_update',
    'extension_ui_request',
    'message_update',
    'agent_end',
    'future_event',
  ])('preserves %s for the host projection', (type) => {
    const test = fixture();
    const event = { type, payload: { value: 'kept' } };
    test.emit(event);
    expect(test.events).toHaveBeenCalledWith(event);
    test.client.close();
  });

  it('writes UI responses while a prompt is pending, without waiting for its ACK', async () => {
    const test = fixture();
    const pending = test.client.request({ type: 'prompt', message: '/choose' });
    test.client.respondToUi('selection-1', { value: 'option' });
    test.client.respondToUi('confirm-1', { confirmed: false });
    test.client.respondToUi('cancel-1', { cancelled: true, timedOut: true });
    expect(
      test.writeLine.mock.calls.slice(1).map(([line]) => JSON.parse(line)),
    ).toEqual([
      { type: 'extension_ui_response', id: 'selection-1', value: 'option' },
      { type: 'extension_ui_response', id: 'confirm-1', confirmed: false },
      {
        type: 'extension_ui_response',
        id: 'cancel-1',
        cancelled: true,
        timedOut: true,
      },
    ]);
    const failure = expect(pending.response).rejects.toThrow(
      'outcome is unknown',
    );
    test.disconnect();
    await failure;
    expect(test.lines.size + test.closes.size).toBe(0);
  });

  it('times out without replaying a potentially side-effecting command', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const request = test.client.request(
      { type: 'prompt', message: '/custom' },
      10,
    );
    const failure = expect(request.response).rejects.toThrow(
      'outcome is unknown',
    );
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    test.emit({
      type: 'response',
      id: request.id,
      command: 'prompt',
      success: true,
    });
    expect(test.writeLine).toHaveBeenCalledTimes(1);
    test.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { command: 'get_state', success: true },
    { command: 'prompt', success: 'yes' },
  ])('fails closed for malformed correlated replies: %j', async (reply) => {
    const test = fixture();
    const pending = test.client.request({ type: 'prompt', message: '/model' });
    const failure = expect(pending.response).rejects.toThrow('closed');
    test.emit({ type: 'response', id: pending.id, ...reply });
    await failure;
    expect(test.closed).toHaveBeenCalledOnce();
  });

  it('does not leak raw runtime errors into the host error', async () => {
    const test = fixture();
    const pending = test.client.request({ type: 'get_state' });
    test.emit({
      type: 'response',
      id: pending.id,
      command: 'get_state',
      success: false,
      error: 'fake-secret-path',
    });
    await expect(pending.response).rejects.toThrow(/^OMP RPC command failed$/);
    test.client.close();
  });

  it('rejects oversized frames before parsing or writing', () => {
    const test = fixture();
    expect(() =>
      test.client.request({ type: 'prompt', message: '字'.repeat(400_000) }),
    ).toThrow('limit');
    expect(test.writeLine).not.toHaveBeenCalled();
    test.emit({ type: 'command_output', text: '字'.repeat(400_000) });
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.events).not.toHaveBeenCalled();
  });

  it('cleans up all pending requests on a transport write failure', async () => {
    const test = fixture();
    const first = test.client.request({ type: 'get_state' });
    const firstFailure = expect(first.response).rejects.toThrow('closed');
    test.writeLine.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    const second = test.client.request({ type: 'abort' });
    await expect(second.response).rejects.toThrow('closed');
    await firstFailure;
    test.client.close();
    expect(test.closed).toHaveBeenCalledOnce();
  });

  it('does not negotiate chunk framing until a bounded decoder is available', () => {
    const test = fixture();
    test.emit({
      type: 'ready',
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
    });
    expect(test.writeLine).not.toHaveBeenCalled();
    test.emit({ type: 'rpc_chunk' });
    expect(test.closed).toHaveBeenCalledOnce();
  });
});
