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
    lines,
    emit: (event: Record<string, unknown>) => {
      for (const listener of lines) listener(JSON.stringify(event));
    },
    disconnect: () => {
      for (const listener of closes) listener();
    },
  };
}

function command(name: string, source = 'builtin') {
  return { name, source };
}

afterEach(() => vi.useRealTimers());

describe('OMP probe controller adversarial', () => {
  it('never writes a prompt or extension_ui_response frame during a successful probe', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const writesAtStart = [...test.writes];

    test.emit({
      type: 'response',
      id: JSON.parse(writesAtStart[0]!).id as string,
      command: 'get_available_commands',
      success: true,
      data: { commands: [command('plan')] },
    });
    test.emit({
      type: 'response',
      id: JSON.parse(writesAtStart[1]!).id as string,
      command: 'get_state',
      success: true,
      data: { sessionId: 'isolated-probe' },
    });
    await result;

    const allTypes = test.writes.map((line) => JSON.parse(line).type);
    expect(allTypes).toEqual(['get_available_commands', 'get_state']);
    expect(allTypes).not.toContain('prompt');
    expect(allTypes).not.toContain('extension_ui_response');
    expect(allTypes).not.toContain('abort');
  });
  it.each([
    'extension_ui_request',
    'host_tool_call',
    'host_tool_cancel',
    'host_uri_request',
    'host_uri_cancel',
  ])('treats a %s as a hard failure and writes nothing back', async (eventType) => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const writesAtStart = [...test.writes];

    probe.observe({
      type: eventType,
      id: 'native-x',
      method: 'approve',
      title: 'Approve?',
    });

    await expect(result).resolves.toMatchObject({
      status: 'failed',
      failure: 'unexpected_interaction',
    });
    expect(test.writes).toHaveLength(writesAtStart.length);
    expect(
      test.writes.slice(writesAtStart.length).map((line) => JSON.parse(line).type),
    ).not.toContain('extension_ui_response');
    expect(
      test.writes.slice(writesAtStart.length).map((line) => JSON.parse(line).type),
    ).not.toContain('prompt');
    expect(() => test.client.request({ type: 'get_state' })).toThrow('closed');
  });
  it('a fresh available_commands_update after the probe completes wins over the stale initial read', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const commandsId = JSON.parse(test.writes[0]!).id as string;
    const stateId = JSON.parse(test.writes[1]!).id as string;

    test.emit({
      type: 'response',
      id: commandsId,
      command: 'get_available_commands',
      success: true,
      data: { commands: [command('initial')] },
    });
    test.emit({
      type: 'response',
      id: stateId,
      command: 'get_state',
      success: true,
      data: { sessionId: 'isolated-probe' },
    });
    await result;

    probe.observe({
      type: 'available_commands_update',
      commands: [command('fresh'), command('second')],
    });

    const snap = probe.getSnapshot();
    expect(snap.status).toBe('ready');
    expect(snap.commands.commands.map((entry) => entry.name)).toEqual(['fresh', 'second']);
    expect(test.writes).toHaveLength(2);
  });
  it('a malformed update after ready fails the probe without resurrecting the stale snapshot', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    const commandsId = JSON.parse(test.writes[0]!).id as string;
    const stateId = JSON.parse(test.writes[1]!).id as string;

    test.emit({
      type: 'response',
      id: commandsId,
      command: 'get_available_commands',
      success: true,
      data: { commands: [command('v1')] },
    });
    test.emit({
      type: 'response',
      id: stateId,
      command: 'get_state',
      success: true,
      data: { sessionId: 'isolated-probe' },
    });
    await result;

    probe.observe({
      type: 'available_commands_update',
      commands: [{ name: 'bad', source: 'future' }],
    });

    const snap = probe.getSnapshot();
    expect(snap.status).toBe('failed');
    expect(snap.failure).toBe('invalid_command_catalog');
    expect(snap.commands.commands).toEqual([]);
    expect(() => test.client.request({ type: 'get_state' })).toThrow('closed');
  });
  it('fails closed when the transport writeLine throws synchronously on the first request', async () => {
    const lines = new Set<(line: string) => void>();
    const closes = new Set<() => void>();
    const writes: string[] = [];
    const transport: OmpRpcTransport = {
      writeLine: (line) => {
        writes.push(line);
        throw new Error('transport write blew up');
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
    const client = new OmpRpcClient(
      transport,
      () => undefined,
      () => undefined,
    );
    const probe = new OmpProbeController({ client });
    const result = probe.start();
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      failure: 'probe_request_failed',
    });
    expect(probe.getSnapshot()).not.toHaveProperty('error');
    expect(() => client.request({ type: 'get_state' })).toThrow('closed');
  });
  it('close() before start() seals the client and prevents any later read or write', () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    probe.close();
    expect(probe.getSnapshot().status).toBe('closed');
    expect(() => test.client.request({ type: 'get_available_commands' })).toThrow('closed');
    expect(test.writes).toHaveLength(0);
  });

  it('close() during a pending read rejects the promise without leaking the request', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const result = probe.start();
    probe.close();
    await expect(result).resolves.toMatchObject({ status: 'closed' });
    expect(() => test.client.request({ type: 'get_state' })).toThrow('closed');
  });

  it('observe() after close is a no-op and never reopens the snapshot', () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    probe.close();
    probe.observe({
      type: 'available_commands_update',
      commands: [command('resurrect')],
    });
    probe.observe({ type: 'extension_ui_request', id: 'n', method: 'select' });
    const snap = probe.getSnapshot();
    expect(snap.status).toBe('closed');
    expect(snap.commands.commands).toEqual([]);
    expect(test.writes).toHaveLength(0);
  });

  it('start() called twice returns the same promise and never re-issues requests', async () => {
    const test = fixture();
    const probe = new OmpProbeController({ client: test.client });
    const first = probe.start();
    const second = probe.start();
    expect(second).toBe(first);
    expect(test.writes).toHaveLength(2);
  });
});
