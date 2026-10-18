import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCodexNativeService } from './native-service.js';
import type { Transport } from './app-server/transport.js';
import type { StdioTransportOptions } from './app-server/stdioTransport.js';

function transport() {
  const lines: Array<(line: string) => void> = [], errors: Array<(line: string) => void> = [];
  const closes: Array<(info: { reason: string }) => void> = [];
  const value: Transport = {
    writeLine: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onLine: handler => { lines.push(handler); return () => {}; },
    onStderr: handler => { errors.push(handler); return () => {}; },
    onClose: handler => { closes.push(handler); return () => {}; },
  };
  return { value, line: (line: string) => lines.forEach(fn => fn(line)),
    diagnostic: (line: string) => errors.forEach(fn => fn(line)),
    closed: (reason: string) => closes.forEach(fn => fn({ reason })) };
}
function fixture() {
  const native = transport(), connection = transport();
  const createProcess = vi.fn((_options: StdioTransportOptions) => native.value), connect = vi.fn(() => connection.value);
  const service = createCodexNativeService({ binaryPath: 'managed-codex', extraArgs: ['-c', 'cli_auth_credentials_store="ephemeral"'],
    env: { CODEX_HOME: 'isolated-home' }, connect }, createProcess);
  return { native, connection, createProcess, connect, service, listen: () => native.diagnostic('  listening on: ws://127.0.0.1:31415') };
}
describe('Codex native service ownership', () => {
  it('preserves host launch policy and passes only a capability verifier in argv', async () => {
    const f = fixture(); f.listen(); const endpoint = await f.service.endpoint;
    const launch = f.createProcess.mock.calls[0]![0];
    expect(launch.env).toEqual({ CODEX_HOME: 'isolated-home' });
    expect(launch.extraArgs!.slice(0, 2)).toEqual(['-c', 'cli_auth_credentials_store="ephemeral"']);
    expect(launch.extraArgs).toContain('ws://127.0.0.1:0');
    expect(launch.extraArgs).not.toContain(endpoint.token);
    expect(launch.extraArgs!.at(-1)).toBe(createHash('sha256').update(endpoint.token).digest('hex'));
    expect(f.connect).toHaveBeenCalledExactlyOnceWith(endpoint);
    await f.service.close();
  });

  it('uses diagnostic listener framing without feeding it to the JSON-RPC client', async () => {
    const f = fixture(), lines = vi.fn(), diagnostics = vi.fn();
    f.service.onLine(lines); f.service.onStderr?.(diagnostics);
    const write = f.service.writeLine('{"id":1}');
    f.native.line('codex app-server (WebSockets)');
    expect(f.connect).not.toHaveBeenCalled();
    f.listen(); await write;
    expect(f.connection.value.writeLine).toHaveBeenCalledExactlyOnceWith('{"id":1}');
    expect(f.native.value.writeLine).not.toHaveBeenCalled();
    expect(lines).not.toHaveBeenCalled(); expect(diagnostics).toHaveBeenCalledWith('codex app-server (WebSockets)');
    f.connection.line('{"id":1,"result":{}}');
    expect(lines).toHaveBeenCalledExactlyOnceWith('{"id":1,"result":{}}');
    await f.service.close();
  });

  it('cancels before listener readiness without opening a socket or replaying input', async () => {
    const f = fixture(); const sent = f.service.writeLine('never send');
    const rejected = expect(sent).rejects.toThrow('closed');
    await f.service.close(); await rejected;
    f.listen(); expect(f.connect).not.toHaveBeenCalled();
    expect(f.native.value.close).toHaveBeenCalledOnce();
    await expect(f.service.endpoint).rejects.toThrow('closed');
  });

  it('fences a disconnected protocol without silently recreating the shared native service', async () => {
    const f = fixture(); f.listen(); await f.service.endpoint; const close = vi.fn(); f.service.onClose(close);
    f.connection.closed('connection lost');
    await expect(f.service.writeLine('no replay')).rejects.toThrow('connection lost');
    expect(close).toHaveBeenCalledExactlyOnceWith({ reason: 'connection lost' });
    expect(f.createProcess).toHaveBeenCalledOnce(); expect(f.native.value.close).not.toHaveBeenCalled();
    // Only the authoritative host lifecycle closes its service.
    await f.service.close(); expect(f.native.value.close).toHaveBeenCalledOnce();
  });

  it('does not report cleanup success when native exit cannot be confirmed', async () => {
    const f = fixture(); f.listen(); await f.service.endpoint;
    vi.mocked(f.native.value.close).mockRejectedValue(new Error('exit unconfirmed'));
    await expect(f.service.close()).rejects.toThrow('exit unconfirmed');
    expect(f.connection.value.close).toHaveBeenCalledOnce();
  });

  it('refuses conflicting listener flags before native launch', () => {
    const spawn = vi.fn();
    for (const flag of ['--listen', '--listen=ws://0.0.0.0:123', '--ws-token-file=unsafe', '--ws-auth', '--']) {
      expect(() => createCodexNativeService({ binaryPath: 'managed', connect: vi.fn(), extraArgs: [flag] }, spawn)).toThrow('one owner');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('times out only a listener that never becomes ready and closes its owned process', async () => {
    vi.useFakeTimers();
    const native = transport(), connect = vi.fn();
    const service = createCodexNativeService({ binaryPath: 'managed', connect, startupTimeoutMs: 100 }, () => native.value);
    try {
      const sent = service.writeLine('pending');
      const rejected = expect(sent).rejects.toThrow('startup timed out');
      await vi.advanceTimersByTimeAsync(100); await rejected;
      await expect(service.endpoint).rejects.toThrow('startup timed out');
      expect(native.value.close).toHaveBeenCalledOnce();
      native.diagnostic('listening on: ws://127.0.0.1:31415');
      expect(connect).not.toHaveBeenCalled();
    } finally { await service.close(); vi.useRealTimers(); }
  });

  it('bounds pre-listener sends without allowing a late listener to revive cancelled input', async () => {
    const f = fixture();
    const writes = Array.from({ length: 256 }, () => f.service.writeLine('pending'));
    const cancelled = writes.map(write => expect(write).rejects.toThrow('closed'));
    await expect(f.service.writeLine('overflow')).rejects.toThrow('buffer exceeded');
    await f.service.close(); await Promise.all(cancelled);
    f.listen(); expect(f.connect).not.toHaveBeenCalled();
  });

  it('retains early frames in order and reports native exit to a late observer', async () => {
    const f = fixture(); f.listen(); await f.service.endpoint;
    f.connection.line('first'); f.connection.line('second');
    const lines = vi.fn(); f.service.onLine(lines);
    expect(lines.mock.calls).toEqual([['first'], ['second']]);
    f.native.closed('native exited');
    const closed = vi.fn(); f.service.onClose(closed);
    await Promise.resolve(); expect(closed).toHaveBeenCalledExactlyOnceWith({ reason: 'native exited' });
    await expect(f.service.writeLine('never replay')).rejects.toThrow('native exited');
    await f.service.close();
  });
});
