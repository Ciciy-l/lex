import { describe, expect, it, vi, afterEach } from 'vitest';
import { OmpCommandCatalog } from './commands.js';
import { OmpRpcClient, type OmpRpcTransport } from './rpc-client.js';

function setup(
  onEvent = vi.fn<(event: Readonly<Record<string, unknown>>) => void>(),
) {
  const listeners = new Set<(line: string) => void>();
  const cleanupLine = vi.fn();
  const cleanupClose = vi.fn();
  const closed = vi.fn();
  const write = vi.fn();
  const transport: OmpRpcTransport = {
    writeLine: write,
    onLine: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        cleanupLine();
      };
    },
    onClose: () => cleanupClose,
  };
  const client = new OmpRpcClient(transport, onEvent, closed);
  return {
    client,
    onEvent,
    closed,
    write,
    cleanupLine,
    cleanupClose,
    emit: (frame: unknown) => {
      for (const listener of listeners) listener(JSON.stringify(frame));
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('OMP v18.1.18 dispatch contract', () => {
  it.each(['custom', 'file'])(
    'builtin alias precedes exact %s name and colon-prefixed names',
    (source) => {
      const catalog = new OmpCommandCatalog();
      catalog.replace([
        { name: 'model', aliases: ['models'], source: 'builtin' },
        { name: 'models', source },
        { name: 'model:fast', source },
      ]);
      expect(catalog.resolve('/models')?.source).toBe('builtin');
      expect(catalog.resolve('/model:fast')?.source).toBe('builtin');
      expect(catalog.resolve('/models:fast')?.name).toBe('model');
    },
  );

  it.each(['builtin', 'extension', 'custom', 'file', 'mcp_prompt'])(
    'does not trim before resolving %s',
    (source) => {
      const catalog = new OmpCommandCatalog();
      catalog.replace([{ name: 'pick', source }]);
      expect(catalog.resolve('  /pick option')).toBeUndefined();
      expect(catalog.resolve('\t\n/pick')).toBeUndefined();
      expect(catalog.resolve('/pick option')?.source).toBe(source);
      expect(catalog.resolve('/pick\toption')?.source).toBe(
        source === 'builtin' ? source : undefined,
      );
      expect(catalog.resolve('/pick\noption')?.source).toBe(
        source === 'builtin' ? source : undefined,
      );
      expect(catalog.resolve('/pick:option')?.source).toBe(
        source === 'builtin' ? source : undefined,
      );
    },
  );

  it('leading skills alone trim whitespace, split on ASCII space, and retain colon namespaces', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'skill:build', source: 'skill' }]);
    expect(catalog.resolve(' \t/skill:build argument')?.source).toBe('skill');
    expect(catalog.resolve('/skill:build\targument')).toBeUndefined();
    expect(catalog.resolve('/skill:build\nargument')).toBeUndefined();
    expect(catalog.resolve('/skill:build:argument')).toBeUndefined();
  });
});

describe('OMP asynchronous failure and callback boundary', () => {
  it('delivers a sanitized prompt failure after ACK, once, with original correlation', async () => {
    const test = setup();
    const pending = test.client.request({ type: 'prompt', message: '/plan' });
    test.emit({
      type: 'response',
      id: pending.id,
      command: 'prompt',
      success: true,
    });
    await pending.response;
    const failure = {
      type: 'response',
      id: pending.id,
      command: 'prompt',
      success: false,
      error: 'synthetic-secret',
      path: '/private',
    };
    test.emit(failure);
    test.emit(failure);
    expect(test.onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'omp_prompt_failure',
      id: pending.id,
      command: 'prompt',
      message: 'OMP prompt execution failed',
    });
    test.client.close();
  });

  it('retains timeout correlation without replaying the command or accepting unknown IDs', async () => {
    vi.useFakeTimers();
    const test = setup();
    const pending = test.client.request(
      { type: 'prompt', message: '/custom' },
      10,
    );
    const rejection = expect(pending.response).rejects.toThrow(
      'outcome is unknown',
    );
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    test.emit({
      type: 'response',
      id: 'unknown',
      command: 'prompt',
      success: false,
    });
    expect(test.onEvent).not.toHaveBeenCalled();
    test.emit({
      type: 'response',
      id: pending.id,
      command: 'prompt',
      success: false,
      error: 'synthetic-secret',
    });
    expect(test.onEvent).toHaveBeenCalledOnce();
    expect(test.write).toHaveBeenCalledOnce();
    test.client.close();
  });

  it('bounds retained ACKs and reclaims only explicitly finalized prompts', async () => {
    const test = setup();
    const ids: string[] = [];
    for (let index = 0; index < 64; index++) {
      const pending = test.client.request({
        type: 'prompt',
        message: '/custom',
      });
      ids.push(pending.id);
      test.emit({
        type: 'response',
        id: pending.id,
        command: 'prompt',
        success: true,
      });
      await pending.response;
    }
    expect(() =>
      test.client.request({ type: 'prompt', message: '/custom' }),
    ).toThrow('unresolved prompt limit');
    test.client.releasePrompt(ids[0]);
    test.emit({
      type: 'response',
      id: ids[0],
      command: 'prompt',
      success: false,
    });
    expect(test.onEvent).not.toHaveBeenCalled();
    const pending = test.client.request({ type: 'prompt', message: '/custom' });
    const rejection = expect(pending.response).rejects.toThrow('closed');
    test.client.close();
    await rejection;
  });

  it('isolates a catalog validation callback exception and rejects all pending requests', async () => {
    const catalog = new OmpCommandCatalog();
    const test = setup(vi.fn((event) => catalog.replace(event.commands)));
    const pending = test.client.request({ type: 'get_state' });
    const rejection = expect(pending.response).rejects.toThrow('closed');
    expect(() =>
      test.emit({
        type: 'available_commands_update',
        commands: [{ name: 'bad', source: 'future' }],
      }),
    ).not.toThrow();
    await rejection;
    expect(catalog.getSnapshot().status).toBe('failed');
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.cleanupLine).toHaveBeenCalledOnce();
    expect(test.cleanupClose).toHaveBeenCalledOnce();
  });

  it('attempts every cleanup and closing notification once even when each throws', async () => {
    const test = setup();
    test.cleanupLine.mockImplementation(() => {
      throw new Error('secret-line');
    });
    test.cleanupClose.mockImplementation(() => {
      throw new Error('secret-close');
    });
    test.closed.mockImplementation(() => {
      throw new Error('secret-notify');
    });
    const pending = test.client.request({ type: 'get_state' });
    const rejection = expect(pending.response).rejects.toThrow('closed');
    expect(() => test.client.close()).not.toThrow();
    expect(() => test.client.close()).not.toThrow();
    await rejection;
    expect(test.cleanupLine).toHaveBeenCalledOnce();
    expect(test.cleanupClose).toHaveBeenCalledOnce();
    expect(test.closed).toHaveBeenCalledOnce();
  });
});
