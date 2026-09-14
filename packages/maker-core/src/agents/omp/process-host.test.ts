import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { startOmpProcess, type OmpProcessHostOptions } from './process-host.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(spawn).mockReset();
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 1234 as number | undefined,
  });
  vi.mocked(spawn).mockReturnValue(process as unknown as ChildProcessWithoutNullStreams);
  const options: OmpProcessHostOptions = {
    executablePath: 'C:/test/omp.exe',
    workingDirectory: 'C:/test/work',
    arguments: ['--mode', 'rpc'],
    environment: { OMP_TEST_ONLY: 'yes' },
    terminateProcessTree: vi.fn(),
    onEvent: vi.fn(),
    onState: vi.fn(),
  };
  if (globalThis.process.platform !== 'win32') {
    options.executablePath = '/test/omp';
    options.workingDirectory = '/test/work';
  }
  return { process, options };
}

describe('OMP process host boundary', () => {
  it.each(['write-callback', 'input-error'])(
    'preserves exit tail frames after a late %s with a genuinely stalled write',
    async (failure) => {
      const test = fixture();
      let finishWrite: ((error?: Error | null) => void) | undefined;
      const write = vi.fn((_chunk, _encoding, callback: (error?: Error | null) => void) => {
        finishWrite = callback;
      });
      const input = new Writable({ write });
      const child = Object.assign(test.process, { stdin: input });
      vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
      const host = startOmpProcess(test.options);
      const prompt = host.client.request({ type: 'prompt', message: 'test' });
      const state = host.client.request({ type: 'get_state' });
      expect(write).toHaveBeenCalledOnce();
      expect(input.writableLength).toBeGreaterThan(0);
      input.destroy();
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'write-callback') finishWrite!(new Error('synthetic-EPIPE'));
      else input.emit('error', new Error('synthetic-EPIPE'));
      await vi.advanceTimersByTimeAsync(0);
      expect(host.getState()).toBe('draining');
      expect(child.stdout.destroyed).toBe(false);
      expect(() => host.client.request({ type: 'get_state' })).toThrow('draining');
      const frames = [
        { type: 'response', id: prompt.id, command: 'prompt', success: true },
        {
          type: 'response',
          id: state.id,
          command: 'get_state',
          success: true,
          data: { sessionId: 'test' },
        },
        { type: 'prompt_result', id: prompt.id, agentInvoked: false },
      ];
      child.stdout.end(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
      await expect(prompt.response).resolves.toMatchObject({ success: true });
      await expect(state.response).resolves.toMatchObject({
        data: { sessionId: 'test' },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(test.options.onEvent).toHaveBeenCalledWith(frames[2]);
      expect(write).toHaveBeenCalledOnce();
      expect(test.options.terminateProcessTree).not.toHaveBeenCalled();
      child.emit('close', 0, null);
      expect(await host.stopAndWait()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['write-callback', 'input-error'])(
    'still closes immediately on %s before natural exit',
    async (failure) => {
      const test = fixture();
      let finishWrite: ((error?: Error | null) => void) | undefined;
      const input = new Writable({
        write: (_chunk, _encoding, callback) => {
          finishWrite = callback;
        },
      });
      const child = Object.assign(test.process, { stdin: input });
      vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
      const host = startOmpProcess(test.options);
      const prompt = host.client.request({ type: 'prompt', message: 'test' });
      const rejected = expect(prompt.response).rejects.toThrow('closed');
      if (failure === 'write-callback') finishWrite!(new Error('synthetic-EPIPE'));
      else input.emit('error', new Error('synthetic-EPIPE'));
      await rejected;
      expect(host.getState()).toBe('stopping');
      expect(child.stdout.destroyed).toBe(true);
      expect(test.options.terminateProcessTree).toHaveBeenCalledWith(child, false);
      child.emit('close', 1, null);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['stdout-error', 'invalid-frame'])(
    'does not suppress %s while draining',
    async (failure) => {
      const test = fixture();
      const host = startOmpProcess(test.options);
      const request = host.client.request({ type: 'get_state' });
      const rejected = expect(request.response).rejects.toThrow('closed');
      test.process.stdin.destroy();
      test.process.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'stdout-error')
        test.process.stdout.emit('error', new Error('synthetic-read-error'));
      else test.process.stdout.write('invalid-json\n');
      await rejected;
      expect(test.process.stdout.destroyed).toBe(true);
      expect(test.options.terminateProcessTree).not.toHaveBeenCalled();
      test.process.emit('close', 0, null);
      expect(await host.stopAndWait()).toBe(true);
    },
  );

  it('startup timeout immediately disables RPC and streams even if termination does not exit', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    const pending = host.client.request({ type: 'get_state' }, 60000);
    const rejected = expect(pending.response).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(host.getState()).toBe('stopping');
    expect(
      test.process.stdin.destroyed &&
        test.process.stdout.destroyed &&
        test.process.stderr.destroyed,
    ).toBe(true);
    expect(() => host.client.request({ type: 'get_state' })).toThrow('closed');
    expect(test.process.stdout.listenerCount('data')).toBe(0);
    const result = host.stopAndWait();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toBe(false);
    expect(test.options.terminateProcessTree).toHaveBeenCalledTimes(2);
    test.process.emit('close', 1, null);
    expect(host.getState()).toBe('exited');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing ready observer immediately closes resources and retains the exit deadline', async () => {
    const test = fixture();
    vi.mocked(test.options.onState).mockImplementation(() => {
      throw new Error('synthetic-observer');
    });
    const host = startOmpProcess(test.options);
    test.process.stdout.write(
      '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1]}\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getState()).toBe('stopping');
    expect(
      test.process.stdin.destroyed &&
        test.process.stdout.destroyed &&
        test.process.stderr.destroyed,
    ).toBe(true);
    expect(test.options.onEvent).not.toHaveBeenCalled();
    expect(() => host.client.request({ type: 'get_state' })).toThrow('closed');
    const result = host.stopAndWait();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toBe(false);
    test.process.emit('close', 1, null);
    expect(host.getState()).toBe('exited');
  });

  it('drains native exit tail frames after stdin destruction without re-signaling the exited process', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    const pending = host.client.request({ type: 'prompt', message: 'test' });
    test.process.stdin.destroy();
    test.process.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getState()).toBe('draining');
    expect(test.process.stdout.destroyed).toBe(false);
    expect(() => host.client.request({ type: 'get_state' })).toThrow('draining');
    expect(() => host.client.respondToUi('late', { cancelled: true })).toThrow('draining');
    expect(test.process.stdout.destroyed).toBe(false);
    const tail = [
      { type: 'response', command: 'prompt', id: pending.id, success: true },
      { type: 'prompt_result', id: pending.id, agentInvoked: false },
      { type: 'agent_end', messages: [] },
    ];
    test.process.stdout.end(tail.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await pending.response;
    await vi.advanceTimersByTimeAsync(0);
    expect(test.options.onEvent).toHaveBeenCalledWith(tail[1]);
    expect(test.options.onEvent).toHaveBeenCalledWith(tail[2]);
    expect(host.getState()).toBe('draining');
    expect(test.options.terminateProcessTree).not.toHaveBeenCalled();
    test.process.emit('close', 0, null);
    expect(await host.stopAndWait()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds natural-exit draining if pipes never finish without claiming a confirmed close', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    test.process.stdin.destroy();
    test.process.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(10000);
    expect(host.getState()).toBe('exit-unconfirmed');
    expect(test.process.stdout.destroyed && test.process.stderr.destroyed).toBe(true);
    expect(test.options.terminateProcessTree).not.toHaveBeenCalled();
    expect(await host.stopAndWait()).toBe(false);
    test.process.emit('close', 0, null);
    expect(host.getState()).toBe('exited');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('spawns directly with only caller-supplied environment and no shell', () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    expect(spawn).toHaveBeenCalledWith(test.options.executablePath, ['--mode', 'rpc'], {
      cwd: test.options.workingDirectory,
      env: { OMP_TEST_ONLY: 'yes' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(host.getState()).toBe('starting');
    test.process.emit('close', 0, null);
    expect(host.getState()).toBe('exited');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only enables a detached process group when the isolated caller opts in', () => {
    const test = fixture();
    startOmpProcess({ ...test.options, detached: true });
    expect(spawn).toHaveBeenCalledWith(test.options.executablePath, ['--mode', 'rpc'], {
      cwd: test.options.workingDirectory,
      env: { OMP_TEST_ONLY: 'yes' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    test.process.emit('close', 0, null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires an actual compatible ready frame and does not infer readiness from spawn', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    test.process.stdout.write(
      '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getState()).toBe('ready');
    expect(test.options.onEvent).toHaveBeenCalledOnce();
    test.process.emit('close', 0, null);
  });

  it('closes on incompatible readiness and does not report exited before process close', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    test.process.stdout.write(
      '{"type":"ready","protocolVersion":3,"supportedProtocolVersions":[3]}\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getState()).toBe('stopping');
    expect(test.options.onEvent).not.toHaveBeenCalled();
    expect(test.process.stdin.destroyed).toBe(true);
    expect(test.process.stdout.destroyed).toBe(true);
    expect(test.process.stderr.destroyed).toBe(true);
    expect(test.options.terminateProcessTree).toHaveBeenCalledWith(test.process, false);
    test.process.emit('close', 1, null);
    expect(await host.stopAndWait()).toBe(true);
  });

  it('does not equate stdout EOF or a successful termination request with process exit', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    test.process.stdout.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getState()).toBe('stopping');
    const stopped = host.stopAndWait();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await stopped).toBe(false);
    expect(host.getState()).toBe('exit-unconfirmed');
    expect(test.options.terminateProcessTree).toHaveBeenCalledTimes(2);
    test.process.emit('close', 0, null);
    expect(host.getState()).toBe('exited');
  });

  it('rejects in-flight RPC on unexpected process close without exposing raw error data', async () => {
    const test = fixture();
    const host = startOmpProcess(test.options);
    const pending = host.client.request({ type: 'get_state' });
    const rejected = expect(pending.response).rejects.toThrow('closed');
    test.process.emit('close', 1, null);
    await rejected;
    expect(test.options.terminateProcessTree).not.toHaveBeenCalled();
    expect(await host.stopAndWait()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains stderr without retaining or publishing raw diagnostic text', async () => {
    const test = fixture();
    startOmpProcess(test.options);
    test.process.stderr.write('synthetic-secret'.repeat(10000));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.process.stderr.readableLength).toBe(0);
    expect(test.options.onEvent).not.toHaveBeenCalled();
    test.process.emit('close', 0, null);
  });

  it('handles spawn failure with no PID without leaving a startup timer', () => {
    const test = fixture();
    test.process.pid = undefined;
    const host = startOmpProcess(test.options);
    expect(() => test.process.emit('error', new Error('synthetic-path'))).not.toThrow();
    expect(host.getState()).toBe('exited');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['relative', 'C:/test/omp.cmd', 'C:/test/omp.bat'])(
    'rejects shell wrappers and nonabsolute executables: %s',
    (executablePath) => {
      const test = fixture();
      expect(() => startOmpProcess({ ...test.options, executablePath })).toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
