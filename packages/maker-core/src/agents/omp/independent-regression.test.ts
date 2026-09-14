import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmpCommandCatalog, OMP_COMPATIBILITY_BASELINE, parseOmpCommands } from './commands.js';
import { OmpRpcClient, type OmpRpcTransport, type OmpUiResponse } from './rpc-client.js';

function buildTransport() {
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
  const events = vi.fn<(event: Readonly<Record<string, unknown>>) => void>();
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

describe('OMP catalog adversarial', () => {
  it('freezes every nested level of a loaded catalog', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([
      {
        name: 'plan',
        source: 'builtin',
        aliases: ['p'],
        description: 'Plan work',
        input: { hint: 'instructions' },
        subcommands: [{ name: 'off', description: 'Stop planning', usage: '/plan off' }],
      },
    ]);
    const snapshot = catalog.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.commands)).toBe(true);
    expect(Object.isFrozen(snapshot.commands[0])).toBe(true);
    expect(Object.isFrozen(snapshot.commands[0].aliases)).toBe(true);
    expect(Object.isFrozen(snapshot.commands[0].input)).toBe(true);
    expect(Object.isFrozen(snapshot.commands[0].subcommands)).toBe(true);
    expect(Object.isFrozen(snapshot.commands[0].subcommands[0])).toBe(true);
  });

  it('rejects names that hide whitespace, slash, NUL or DEL inside the token', () => {
    for (const bad of [
      'a\tb',
      'a\nb',
      'a\rb',
      'a b',
      'a/b',
      'a\u0001b',
      'a\u007fb',
      '\uFEFFfoo',
      'foo\uFEFF',
    ]) {
      expect(() => parseOmpCommands([{ name: bad, source: 'builtin' }])).toThrow(
        /Invalid OMP command name|Invalid OMP command metadata/,
      );
    }
  });

  it('keeps pure non-whitespace Unicode tokens in the catalog', () => {
    const parsed = parseOmpCommands([{ name: '中文', source: 'builtin', aliases: ['🤖'] }]);
    expect(parsed[0].name).toBe('中文');
    expect(parsed[0].aliases[0]).toBe('🤖');
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: '中文', source: 'builtin', aliases: ['🤖'] }]);
    expect(catalog.resolve('/中文 something')?.name).toBe('中文');
    expect(catalog.resolve('/🤖')?.name).toBe('中文');
  });

  it('refuses descriptions / hints / usage that blow past the documented byte ceiling', () => {
    const base = { name: 'ok', source: 'builtin' } as const;
    expect(() => parseOmpCommands([{ ...base, description: 'x'.repeat(8192) }])).not.toThrow();
    expect(() => parseOmpCommands([{ ...base, description: 'x'.repeat(8193) }])).toThrow(
      /Invalid OMP command metadata/,
    );
    expect(() => parseOmpCommands([{ ...base, input: { hint: 'h'.repeat(8192) } }])).not.toThrow();
    expect(() => parseOmpCommands([{ ...base, input: { hint: 'h'.repeat(8193) } }])).toThrow(
      /Invalid OMP command metadata/,
    );
    expect(() =>
      parseOmpCommands([{ ...base, subcommands: [{ name: 'off', usage: 'u'.repeat(8192) }] }]),
    ).not.toThrow();
    expect(() =>
      parseOmpCommands([{ ...base, subcommands: [{ name: 'off', usage: 'u'.repeat(8193) }] }]),
    ).toThrow(/Invalid OMP command metadata/);
  });

  it('treats the command as suspect when description / hint contain NUL', () => {
    expect(() =>
      parseOmpCommands([{ name: 'ok', source: 'builtin', description: 'a\u0000b' }]),
    ).toThrow(/Invalid OMP command metadata/);
    expect(() =>
      parseOmpCommands([{ name: 'ok', source: 'builtin', input: { hint: 'a\u0000b' } }]),
    ).toThrow(/Invalid OMP command metadata/);
  });

  it('rejects 257 aliases on a single command even when individually valid', () => {
    const aliases = Array.from({ length: 257 }, (_, i) => 'a' + i);
    expect(() => parseOmpCommands([{ name: 'ok', source: 'builtin', aliases }])).toThrow(
      /Invalid OMP command metadata/,
    );
  });

  it('rejects 257 subcommands on a single command even when individually valid', () => {
    const subcommands = Array.from({ length: 257 }, (_, i) => ({
      name: 's' + i,
    }));
    expect(() => parseOmpCommands([{ name: 'ok', source: 'builtin', subcommands }])).toThrow(
      /Invalid OMP command metadata/,
    );
  });

  it('resolves plain slash, bare slash, and messages without leading slash to undefined', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'model', source: 'builtin' }]);
    expect(catalog.resolve('')).toBeUndefined();
    expect(catalog.resolve('   ')).toBeUndefined();
    expect(catalog.resolve('/')).toBeUndefined();
    expect(catalog.resolve('/   ')).toBeUndefined();
    expect(catalog.resolve('plain text')).toBeUndefined();
    expect(catalog.resolve('text /model')).toBeUndefined();
    expect(catalog.resolve('//model')).toBeUndefined();
  });

  it('consumes the first whitespace-delimited token after the leading slash', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'model', source: 'builtin' }]);
    expect(catalog.resolve('/model')?.name).toBe('model');
    expect(catalog.resolve('/model extra args')?.name).toBe('model');
    expect(catalog.resolve('/model\nnext line')?.name).toBe('model');
    expect(catalog.resolve('\t\n  /model')).toBeUndefined();
  });

  it('collapses duplicate catalog snapshots so a stale replace never resurrects an unsafe directory', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'safe', source: 'builtin' }]);
    const snapshotBefore = catalog.getSnapshot();
    expect(() =>
      catalog.replace([
        { name: 'unsafe', source: 'extension' },
        { name: 'oops', source: 'plugin' as never },
      ]),
    ).toThrow();
    const snapshotFailed = catalog.getSnapshot();
    expect(snapshotFailed.status).toBe('failed');
    expect(snapshotFailed.commands).toEqual([]);
    expect(snapshotFailed).not.toBe(snapshotBefore);
    expect(catalog.resolve('/safe')).toBeUndefined();
  });

  it('keeps an in-flight read from overwriting a newer authoritative push', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'v1', source: 'builtin' }]);
    const pending = catalog.beginRead();
    catalog.replace([{ name: 'v2', source: 'builtin' }]);
    expect(catalog.completeRead(pending, [{ name: 'v1', source: 'builtin' }])).toBe(false);
    expect(catalog.getSnapshot().commands[0].name).toBe('v2');
    expect(catalog.resolve('/v1')).toBeUndefined();
    expect(catalog.resolve('/v2')?.name).toBe('v2');
  });

  it('refuses reused tickets from a different catalog instance', () => {
    const catalogA = new OmpCommandCatalog();
    const catalogB = new OmpCommandCatalog();
    const ticket = catalogA.beginRead();
    expect(catalogB.completeRead(ticket, [{ name: 'x', source: 'builtin' }])).toBe(false);
    expect(catalogB.getSnapshot()).toEqual({
      status: 'unknown',
      commands: [],
    });
  });

  it('marks the catalog as failed when an authoritative replace throws', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([{ name: 'baseline', source: 'builtin' }]);
    expect(() => catalog.replace([{ name: 'no-source', source: 'plugin' as never }])).toThrow();
    expect(catalog.getSnapshot().status).toBe('failed');
    expect(catalog.resolve('/baseline')).toBeUndefined();
    catalog.completeRead(catalog.beginRead(), []);
    expect(catalog.getSnapshot()).toEqual({
      status: 'loaded',
      commands: [],
    });
  });

  it('exposes the documented compatibility baseline as an ASCII version string', () => {
    expect(typeof OMP_COMPATIBILITY_BASELINE).toBe('string');
    expect(OMP_COMPATIBILITY_BASELINE).toMatch(/^[\d.]+$/);
  });
});

describe('OMP RPC client adversarial', () => {
  it('rejects a request that targets an unknown wire command', () => {
    const test = buildTransport();
    expect(() => test.client.request({ type: 'bogus' as never })).toThrow(
      /Invalid OMP RPC request/,
    );
    test.client.close();
  });

  it('rejects malformed timeout values that are not positive safe integers', () => {
    const test = buildTransport();
    for (const bad of [0, -1, 600_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => test.client.request({ type: 'get_state' }, bad)).toThrow(
        /Invalid OMP RPC request/,
      );
    }
    test.client.close();
  });

  it('accepts the documented upper bound timeout of 600_000 ms', () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' }, 600_000);
    expect(test.writeLine).toHaveBeenCalledTimes(1);
    handle.response.catch(() => {});
    test.client.close();
  });

  it('rejects a prompt whose message is not a string', () => {
    const test = buildTransport();
    expect(() => test.client.request({ type: 'prompt', message: 1 as never })).toThrow(
      /Invalid OMP prompt/,
    );
    test.client.close();
  });

  it('serializes the exact slash payload and keeps the ID monotonic per client', async () => {
    const test = buildTransport();
    const message = '  /plan off\nkeep spacing\tnext line';
    const handle = test.client.request({ type: 'prompt', message });
    expect(test.writeLine).toHaveBeenCalledTimes(1);
    expect(JSON.parse(test.writeLine.mock.calls[0][0])).toEqual({
      type: 'prompt',
      id: handle.id,
      message,
    });
    expect(handle.id).toBe('omp-1');
    const second = test.client.request({ type: 'get_state' });
    expect(second.id).toBe('omp-2');
    handle.response.catch(() => {});
    second.response.catch(() => {});
    test.client.close();
  });

  it('returns the first matched response and silently drops late replies for the same id', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' });
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'get_state',
      success: true,
      data: { ok: true },
    });
    expect((await handle.response).data).toEqual({ ok: true });
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'get_state',
      success: true,
      data: { ok: false },
    });
    expect(test.closed).not.toHaveBeenCalled();
    expect(test.events).not.toHaveBeenCalled();
    test.client.close();
  });

  it('stops the channel when a correlated reply carries a different command than the pending one', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' });
    const failure = expect(handle.response).rejects.toThrow(/closed/);
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'abort',
      success: true,
    });
    await failure;
    expect(test.closed).toHaveBeenCalledOnce();
  });

  it('closes the channel when the success field is not a boolean', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' });
    const failure = expect(handle.response).rejects.toThrow(/closed/);
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'get_state',
      success: 'yes',
    });
    await failure;
    expect(test.closed).toHaveBeenCalledOnce();
  });

  it('drops a response that targets an unknown id without closing the channel', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' });
    test.emit({
      type: 'response',
      id: 'omp-9999',
      command: 'get_state',
      success: true,
    });
    expect(test.closed).not.toHaveBeenCalled();
    expect(test.events).not.toHaveBeenCalled();
    handle.response.catch(() => {});
    test.client.close();
  });

  it('does not auto-retry a timed-out request even if a delayed ACK arrives', async () => {
    vi.useFakeTimers();
    const test = buildTransport();
    const handle = test.client.request({ type: 'prompt', message: '/custom' }, 25);
    const failure = expect(handle.response).rejects.toThrow('outcome is unknown');
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'prompt',
      success: true,
    });
    expect(test.writeLine).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    test.client.close();
  });

  it('treats a transport write failure during request as a terminal close, not a retry', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' });
    const failure = expect(handle.response).rejects.toThrow(/closed/);
    test.writeLine.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    const second = test.client.request({ type: 'abort' });
    await expect(second.response).rejects.toThrow(/closed/);
    await failure;
    expect(test.closed).toHaveBeenCalledOnce();
  });

  it('enforces the 64-pending ceiling before the 65th request can be issued', async () => {
    const test = buildTransport();
    for (let i = 0; i < 64; i += 1) {
      test.client.request({ type: 'get_state' }).response.catch(() => {});
    }
    expect(() => test.client.request({ type: 'get_state' })).toThrow(
      /OMP RPC request limit reached/,
    );
    expect(test.writeLine).toHaveBeenCalledTimes(64);
    test.client.close();
  });

  it('closes the channel when an inbound frame exceeds 1 MiB, without parsing it', () => {
    const test = buildTransport();
    const huge = 'a'.repeat(1024 * 1024);
    for (const listener of test.lines) listener('{' + huge);
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.events).not.toHaveBeenCalled();
  });

  it('refuses to encode a payload whose UTF-8 byte length exceeds 1 MiB', () => {
    const test = buildTransport();
    expect(() =>
      test.client.request({
        type: 'prompt',
        message: '字'.repeat(350_000),
      }),
    ).toThrow(/frame exceeds limit/);
    expect(test.writeLine).not.toHaveBeenCalled();
    test.client.close();
  });

  it('closes the channel on a malformed JSON frame instead of recovering', () => {
    const test = buildTransport();
    for (const listener of test.lines) listener('\u0000not-json');
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.events).not.toHaveBeenCalled();
  });

  it('closes the channel on an inbound frame whose type field is not a string', () => {
    const test = buildTransport();
    for (const listener of test.lines) listener(JSON.stringify({ type: 1 }));
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.events).not.toHaveBeenCalled();
  });

  it('closes the channel on an inbound array payload because it is not an OMP record', () => {
    const test = buildTransport();
    for (const listener of test.lines) listener(JSON.stringify([]));
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.events).not.toHaveBeenCalled();
  });

  it('treats blank or whitespace-only lines as no-ops rather than closing the channel', () => {
    const test = buildTransport();
    for (const listener of test.lines) listener('   ');
    expect(test.closed).not.toHaveBeenCalled();
    expect(test.events).not.toHaveBeenCalled();
    test.client.close();
  });

  it('refuses rpc_chunk frames without negotiating framing', () => {
    const test = buildTransport();
    test.emit({ type: 'rpc_chunk', payload: { partial: 'json' } });
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.events).not.toHaveBeenCalled();
  });

  it('passes through the documented native event types without mutation', () => {
    const test = buildTransport();
    const cases = [
      { type: 'command_output', payload: { value: 'kept' } },
      { type: 'config_update', payload: { value: 'kept' } },
      { type: 'session_info_update', payload: { value: 'kept' } },
      { type: 'available_commands_update', payload: { value: 'kept' } },
      { type: 'extension_ui_request', payload: { value: 'kept' } },
      { type: 'message_update', payload: { value: 'kept' } },
      { type: 'agent_end', payload: { value: 'kept' } },
      { type: 'future_event', payload: { value: 'kept' } },
      { type: 'prompt_result', id: 'omp-1', agentInvoked: false },
    ] as const;
    for (const event of cases) {
      test.emit(event);
    }
    expect(test.events.mock.calls.map(([c]) => c)).toEqual(cases);
    test.client.close();
  });

  it('never redacts prompt_result or other native events into the RPC response stream', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'prompt', message: '/x' });
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'prompt',
      success: true,
    });
    await handle.response;
    test.emit({
      type: 'prompt_result',
      id: handle.id,
      agentInvoked: true,
      body: 'host-only payload',
    });
    expect(test.events).toHaveBeenCalledTimes(1);
    expect(test.events).toHaveBeenCalledWith({
      type: 'prompt_result',
      id: handle.id,
      agentInvoked: true,
      body: 'host-only payload',
    });
    test.client.close();
  });

  it('writes UI responses with the exact payload shape per union variant', () => {
    const test = buildTransport();
    test.client.respondToUi('selection', { value: 'option' });
    test.client.respondToUi('confirm', { confirmed: true });
    test.client.respondToUi('cancel', { cancelled: true });
    test.client.respondToUi('cancel-timeout', { cancelled: true, timedOut: true });
    test.client.respondToUi('cancel-no-flag', { cancelled: true, timedOut: false });
    expect(test.writeLine.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { type: 'extension_ui_response', id: 'selection', value: 'option' },
      { type: 'extension_ui_response', id: 'confirm', confirmed: true },
      { type: 'extension_ui_response', id: 'cancel', cancelled: true },
      {
        type: 'extension_ui_response',
        id: 'cancel-timeout',
        cancelled: true,
        timedOut: true,
      },
      { type: 'extension_ui_response', id: 'cancel-no-flag', cancelled: true },
    ]);
    test.client.close();
  });

  it('refuses to write a UI response that mixes variants or omits the discriminator', () => {
    const test = buildTransport();
    expect(() => test.client.respondToUi('id', { value: 'x', confirmed: true })).toThrow(
      /Invalid OMP interaction response/,
    );
    expect(() =>
      test.client.respondToUi('id', { confirmed: 'maybe' } as unknown as OmpUiResponse),
    ).toThrow(/Invalid OMP interaction response/);
    expect(() =>
      test.client.respondToUi('id', { cancelled: false } as unknown as OmpUiResponse),
    ).toThrow(/Invalid OMP interaction response/);
    expect(() => test.client.respondToUi('id', {} as OmpUiResponse)).toThrow(
      /Invalid OMP interaction response/,
    );
    expect(test.writeLine).not.toHaveBeenCalled();
    test.client.close();
  });

  it('refuses a UI response id that is empty, too long, or contains a control character', () => {
    const test = buildTransport();
    expect(() => test.client.respondToUi('', { value: 'x' })).toThrow(
      /Invalid OMP interaction identity/,
    );
    const long = 'x'.repeat(257);
    expect(() => test.client.respondToUi(long, { value: 'x' })).toThrow(
      /Invalid OMP interaction identity/,
    );
    expect(() => test.client.respondToUi('id\u0001', { value: 'x' })).toThrow(
      /Invalid OMP interaction identity/,
    );
    expect(test.writeLine).not.toHaveBeenCalled();
    test.client.close();
  });

  it('treats a transport write failure during respondToUi as both a close and a thrown error', () => {
    const test = buildTransport();
    test.writeLine.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    expect(() => test.client.respondToUi('id', { value: 'x' })).toThrow(/transport failed/);
    expect(test.closed).toHaveBeenCalledOnce();
  });

  it('rejects every entry point after close and never writes through the transport again', () => {
    const test = buildTransport();
    test.client.close();
    expect(() => test.client.request({ type: 'get_state' })).toThrow(/OMP RPC is closed/);
    expect(() => test.client.respondToUi('id', { value: 'x' })).toThrow(/OMP RPC is closed/);
    test.client.close();
    expect(test.writeLine).not.toHaveBeenCalled();
  });

  it('calls onClosed exactly once even when the transport emits multiple disconnects', () => {
    const test = buildTransport();
    test.disconnect();
    test.disconnect();
    test.disconnect();
    expect(test.closed).toHaveBeenCalledOnce();
    expect(test.lines.size).toBe(0);
    expect(test.closes.size).toBe(0);
  });

  it('rejects every pending request with the documented closed error after disconnect', async () => {
    const test = buildTransport();
    const handles = [
      test.client.request({ type: 'get_state' }),
      test.client.request({ type: 'abort' }),
    ];
    const failures = handles.map((h) => expect(h.response).rejects.toThrow('outcome is unknown'));
    test.disconnect();
    await Promise.all(failures);
  });

  it('does not leak any timers after close even when a pending request had a long timeout', () => {
    vi.useFakeTimers();
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' }, 30_000);
    handle.response.catch(() => {});
    test.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes a failed RPC response into a stable error message', async () => {
    const test = buildTransport();
    const handle = test.client.request({ type: 'get_state' });
    test.emit({
      type: 'response',
      id: handle.id,
      command: 'get_state',
      success: false,
      error: 'fake-secret-path',
    });
    await expect(handle.response).rejects.toThrow(/^OMP RPC command failed$/);
    test.client.close();
  });

  it('survives an onClose event that fires synchronously inside onLine registration', () => {
    const lines = new Set<(line: string) => void>();
    const closes = new Set<() => void>();
    let fireClose: (() => void) | undefined;
    const writeLine = vi.fn<(line: string) => void>();
    const transport: OmpRpcTransport = {
      writeLine,
      onLine: (listener) => {
        lines.add(listener);
        return () => lines.delete(listener);
      },
      onClose: (listener) => {
        closes.add(listener);
        fireClose = () => listener();
        return () => {
          closes.delete(listener);
          fireClose = undefined;
        };
      },
    };
    const events = vi.fn();
    const closed = vi.fn();
    const client = new OmpRpcClient(transport, events, closed);
    expect(client).toBeDefined();
    expect(fireClose).toBeDefined();
    fireClose?.();
    expect(closed).toHaveBeenCalledOnce();
    expect(lines.size).toBe(0);
    expect(closes.size).toBe(0);
  });

  it('refuses a request whose prompt body is missing the documented message field', () => {
    const test = buildTransport();
    expect(() =>
      test.client.request({
        type: 'prompt',
      } as never),
    ).toThrow(/Invalid OMP prompt/);
    test.client.close();
  });

  it('drops future protocol version hints and never negotiates v2 today', () => {
    const test = buildTransport();
    test.emit({
      type: 'ready',
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
    });
    test.emit({
      type: 'ready',
      protocolVersion: 2,
      supportedProtocolVersions: [2],
    });
    expect(test.writeLine).not.toHaveBeenCalled();
    expect(test.closed).not.toHaveBeenCalled();
    expect(test.events.mock.calls.map(([c]) => c.type)).toEqual(['ready', 'ready']);
    test.client.close();
  });
});
