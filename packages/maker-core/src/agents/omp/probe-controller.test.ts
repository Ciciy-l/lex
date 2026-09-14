import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmpProbeController } from './probe-controller.js';
import { OmpRpcClient, type OmpRpcTransport } from './rpc-client.js';

function fixture() {
  const lines = new Set<(line: string) => void>();
  const closes = new Set<() => void>();
  const writes: string[] = [];
  const transport: OmpRpcTransport = {
    writeLine: (line) => writes.push(line),
    onLine: (listener) => {
      lines.add(listener);
      return () => lines.delete(listener);
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
  };
  const client = new OmpRpcClient(
    transport,
    () => undefined,
    () => undefined,
  );
  return {
    client,
    writes,
    emit: (event: Record<string, unknown>) => {
      for (const listener of lines) listener(JSON.stringify(event));
    },
    disconnect: () => {
      for (const listener of closes) listener();
    },
  };
}

function requestId(line: string, command: string): string {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(parsed.type).toBe(command);
  expect(typeof parsed.id).toBe('string');
  return parsed.id as string;
}

function command(name: string, source = 'builtin') {
  return { name, aliases: [], source };
}

afterEach(() => vi.useRealTimers());

describe('OMP zero-prompt capability probe', () => {
  it('only reads native state and command metadata, preserving command source fields', async () => {
    const test = fixture();
    const snapshots = vi.fn();
    const probe = new OmpProbeController({
      client: test.client,
      onSnapshot: snapshots,
    });

    const result = probe.start();
    expect(test.writes).toHaveLength(2);
    const commandsId = requestId(test.writes[0]!, 'get_available_commands');
    const stateId = requestId(test.writes[1]!, 'get_state');
    expect(test.writes.map((line) => JSON.parse(line))).not.toContainEqual(
      expect.objectContaining({ type: 'prompt' }),
    );

    test.emit({
      type: 'response',
      id: commandsId,
      command: 'get_available_commands',
      success: true,
      data: {
        commands: [
          {
            name: 'plan',
            aliases: ['p'],
            description: 'Native plan command',
            source: 'builtin',
            subcommands: [{ name: 'off', usage: '/plan off' }],
          },
          { name: 'skill:Review', aliases: [], source: 'skill' },
        ],
      },
    });
    test.emit({
      type: 'response',
      id: stateId,
      command: 'get_state',
      success: true,
      data: { sessionId: 'isolated-probe', model: { secret: 'not-projected' } },
    });

    await expect(result).resolves.toMatchObject({
      status: 'ready',
      stateAvailable: true,
      commands: {
        status: 'loaded',
        commands: [
          expect.objectContaining({
            name: 'plan',
            aliases: ['p'],
            source: 'builtin',
          }),
          expect.objectContaining({ name: 'skill:Review', source: 'skill' }),
        ],
      },
    });
    expect(probe.getSnapshot()).not.toHaveProperty('sessionId');
    expect(probe.getSnapshot()).not.toHaveProperty('model');
    expect(Object.isFrozen(probe.getSnapshot())).toBe(true);
    expect(snapshots).toHaveBeenCalled();
  });

  it('keeps a newer command push when the initial read returns late', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const commandsId = requestId(test.writes[0]!, 'get_available_commands');
    const stateId = requestId(test.writes[1]!, 'get_state');

    probe.observe({
      type: 'available_commands_update',
      commands: [command('fresh', 'extension')],
    });
    test.emit({
      type: 'response',
      id: commandsId,
      command: 'get_available_commands',
      success: true,
      data: { commands: [command('stale')] },
    });
    test.emit({
      type: 'response',
      id: stateId,
      command: 'get_state',
      success: true,
      data: { sessionId: 'isolated-probe' },
    });

    await expect(result).resolves.toMatchObject({ status: 'ready' });
    expect(probe.getSnapshot().commands.commands).toEqual([
      expect.objectContaining({ name: 'fresh', source: 'extension' }),
    ]);
  });

  it('fails closed on malformed catalog data without exposing the transport error', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const commandsId = requestId(test.writes[0]!, 'get_available_commands');
    const stateId = requestId(test.writes[1]!, 'get_state');

    test.emit({
      type: 'response',
      id: commandsId,
      command: 'get_available_commands',
      success: true,
      data: { commands: [{ name: 'unsafe', source: 'future' }] },
    });
    test.emit({
      type: 'response',
      id: stateId,
      command: 'get_state',
      success: true,
      data: { sessionId: 'isolated-probe' },
    });

    await expect(result).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        stateAvailable: false,
        failure: 'invalid_command_catalog',
        commands: { status: 'failed', commands: [] },
      }),
    );
    expect(() => test.client.request({ type: 'get_state' })).toThrow('closed');
  });

  it('never turns a native interaction into an approval or UI response', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const beforeInteraction = test.writes.length;

    probe.observe({
      type: 'extension_ui_request',
      id: 'native-select',
      method: 'select',
      title: 'Approve tool execution?',
      options: ['Approve', 'Deny'],
    });

    await expect(result).resolves.toMatchObject({
      status: 'failed',
      failure: 'unexpected_interaction',
    });
    expect(test.writes).toHaveLength(beforeInteraction);
    expect(test.writes.map((line) => JSON.parse(line))).not.toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response' }),
    );
  });

  it('reports a bounded RPC failure with a stable public reason', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const probe = new OmpProbeController({
      client: test.client,
      requestTimeoutMs: 1,
    });
    const result = probe.start();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      failure: 'probe_request_failed',
    });
    expect(probe.getSnapshot()).not.toHaveProperty('error');
    test.disconnect();
  });

  it('contains a synchronous first-write failure without a second write or unhandled rejection', async () => {
    const lines = new Set<(line: string) => void>();
    const closes = new Set<() => void>();
    const writes: string[] = [];
    const transport: OmpRpcTransport = {
      writeLine: (line) => {
        writes.push(line);
        throw new Error('synthetic transport failure');
      },
      onLine: (listener) => {
        lines.add(listener);
        return () => lines.delete(listener);
      },
      onClose: (listener) => {
        closes.add(listener);
        return () => closes.delete(listener);
      },
    };
    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const probe = new OmpProbeController({
        client: new OmpRpcClient(
          transport,
          () => undefined,
          () => undefined,
        ),
      });
      await expect(probe.start()).resolves.toMatchObject({
        status: 'failed',
        stateAvailable: false,
        failure: 'probe_request_failed',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        type: 'get_available_commands',
      });
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
