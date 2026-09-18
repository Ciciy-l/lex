import { describe, expect, it, vi } from 'vitest';
import { OmpRpcClient, type OmpRpcTransport } from './rpc-client.js';

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
  const client = new OmpRpcClient(transport, events, vi.fn());
  return {
    client,
    writeLine,
    events,
    emit: (value: unknown) => {
      for (const listener of lines) listener(JSON.stringify(value));
    },
    written: (): Record<string, unknown>[] =>
      writeLine.mock.calls.map(([line]) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('OMP RPC session requests', () => {
  it('sends new_session / switch_session with their payloads', () => {
    const test = fixture();
    test.client.request({ type: 'new_session' });
    test.client.request({ type: 'switch_session', sessionPath: '/managed/session.jsonl' });
    expect(test.written()).toEqual([
      { type: 'new_session', id: 'omp-1' },
      { type: 'switch_session', id: 'omp-2', sessionPath: '/managed/session.jsonl' },
    ]);
  });

  it('sends steer / follow_up messages', () => {
    const test = fixture();
    test.client.request({ type: 'steer', message: 'stop' });
    test.client.request({ type: 'follow_up', message: 'next' });
    expect(test.written()).toEqual([
      { type: 'steer', id: 'omp-1', message: 'stop' },
      { type: 'follow_up', id: 'omp-2', message: 'next' },
    ]);
  });

  it('sends set_model / set_thinking_level / compact / export_html', () => {
    const test = fixture();
    test.client.request({ type: 'set_model', provider: 'cindy', modelId: 'MiniMax-M2' });
    test.client.request({ type: 'set_thinking_level', level: 'high' });
    test.client.request({ type: 'compact' });
    test.client.request({ type: 'export_html', outputPath: '/tmp/session.html' });
    expect(test.written()).toEqual([
      { type: 'set_model', id: 'omp-1', provider: 'cindy', modelId: 'MiniMax-M2' },
      { type: 'set_thinking_level', id: 'omp-2', level: 'high' },
      { type: 'compact', id: 'omp-3' },
      { type: 'export_html', id: 'omp-4', outputPath: '/tmp/session.html' },
    ]);
  });

  it('validates each payload instead of forwarding arbitrary values', () => {
    const test = fixture();
    expect(() =>
      test.client.request({ type: 'switch_session', sessionPath: '' } as never),
    ).toThrow(/switch_session/);
    expect(() =>
      test.client.request({ type: 'set_model', provider: 'cindy', modelId: 7 } as never),
    ).toThrow(/modelId/);
    expect(() => test.client.request({ type: 'nope' } as never)).toThrow(
      /Invalid OMP RPC request/,
    );
    expect(test.writeLine).not.toHaveBeenCalled();
  });
});

describe('OMP RPC requestGeneration handling', () => {
  it('does not emit a generation when the request frame has none', () => {
    const test = fixture();
    test.emit({ type: 'extension_ui_request', id: '157cf60a9ce9ac08', method: 'select' });
    test.client.respondToUi('157cf60a9ce9ac08', { value: 'Approve' });
    expect(test.written()).toEqual([
      { type: 'extension_ui_response', id: '157cf60a9ce9ac08', value: 'Approve' },
    ]);
  });

  it('echoes the generation captured from the request frame', () => {
    const test = fixture();
    test.emit({
      type: 'extension_ui_request',
      id: 'abc',
      method: 'confirm',
      requestGeneration: 7,
    });
    test.client.respondToUi('abc', { confirmed: true });
    expect(test.written()).toEqual([
      { type: 'extension_ui_response', id: 'abc', confirmed: true, requestGeneration: 7 },
    ]);
  });

  it('prefers an explicit correlation over the captured generation', () => {
    const test = fixture();
    test.emit({
      type: 'extension_ui_request',
      id: 'abc',
      method: 'confirm',
      requestGeneration: 7,
    });
    test.client.respondToUi('abc', { confirmed: true }, { requestGeneration: 'gen-2' });
    expect(test.written()).toEqual([
      { type: 'extension_ui_response', id: 'abc', confirmed: true, requestGeneration: 'gen-2' },
    ]);
  });

  it('an explicit undefined correlation suppresses the captured generation', () => {
    const test = fixture();
    test.emit({
      type: 'extension_ui_request',
      id: 'abc',
      method: 'confirm',
      requestGeneration: 7,
    });
    test.client.respondToUi('abc', { confirmed: true }, {});
    expect(test.written()).toEqual([
      { type: 'extension_ui_response', id: 'abc', confirmed: true },
    ]);
  });

  it('rejects a generation that is not a small scalar', () => {
    const test = fixture();
    expect(() =>
      test.client.respondToUi('abc', { confirmed: true }, { requestGeneration: { a: 1 } }),
    ).toThrow(/correlation/);
    expect(() =>
      test.client.respondToUi('abc', { confirmed: true }, { requestGeneration: 1.5 }),
    ).toThrow(/correlation/);
    expect(test.writeLine).not.toHaveBeenCalled();
  });

  it('never treats an echoed response frame as a new inbound request', () => {
    const test = fixture();
    test.emit({
      type: 'extension_ui_response',
      id: 'abc',
      confirmed: true,
      requestGeneration: 3,
    });
    expect(test.events).not.toHaveBeenCalled();
  });

  it('forgets a captured generation once the request has been answered', () => {
    const test = fixture();
    test.emit({
      type: 'extension_ui_request',
      id: 'abc',
      method: 'confirm',
      requestGeneration: 7,
    });
    test.client.respondToUi('abc', { confirmed: true });
    test.client.respondToUi('abc', { confirmed: false });
    const frames = test.written();
    expect(frames[0]?.requestGeneration).toBe(7);
    expect(frames[1]?.requestGeneration).toBeUndefined();
  });
});
