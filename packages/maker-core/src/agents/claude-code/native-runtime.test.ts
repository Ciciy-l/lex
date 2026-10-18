import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTerminalDriver } from '../presentation.js';
import { createClaudeNativeRuntime, type ClaudeNativeLaunch, type ClaudeNativeRuntime } from './native-runtime.js';

const runtimes: ClaudeNativeRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });
function fixture() {
  let launch!: ClaudeNativeLaunch;
  const exits = new Set<(exit: { code: number | null }) => void>();
  const driver: AgentTerminalDriver = { write: vi.fn(), resize: vi.fn(), close: vi.fn(), onData: () => vi.fn(),
    onExit: (fn) => { exits.add(fn); return () => { exits.delete(fn); }; } };
  const options = { nativeSessionId: 'native', executable: 'owned-cli', cwd: 'owned-cwd', args: ['--model', 'fixture'], env: { PROVIDER: 'fixture' },
    launch: vi.fn(async (spec: ClaudeNativeLaunch) => { launch = spec; return driver; }),
    onEvent: vi.fn(), onRequest: vi.fn(async () => ({ behavior: 'deny' })), onExit: vi.fn(), onFault: vi.fn() };
  const start = async (overrides: Partial<Parameters<typeof createClaudeNativeRuntime>[0]> = {}) => {
    const runtime = await createClaudeNativeRuntime({ ...options, ...overrides }); runtimes.push(runtime); return runtime;
  };
  const post = async (events: object[]) => {
    const response = await fetch(launch.env.LEX_CLAUDE_BRIDGE_URL + '/exchange', { method: 'POST',
      headers: { authorization: 'Bearer ' + launch.env.LEX_CLAUDE_BRIDGE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'native', generation: launch.env.LEX_CLAUDE_BRIDGE_GENERATION, events }) });
    return response.json() as Promise<any>;
  };
  const ready = () => post([{ sequence: 1, kind: 'ready', value: { sessionId: 'native', isInteractive: true } }]);
  const pluginRoot = () => launch.args[launch.args.indexOf('--plugin-dir') + 1];
  return { options, driver, start, post, ready, pluginRoot, spec: () => launch,
    exit: (code: number) => { for (const fn of exits) fn({ code }); } };
}

describe('continuous Claude native runtime', () => {
  it('does not terminate an interactive startup merely because the user has not answered yet', async () => {
    const f = fixture(), runtime = await f.start();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.options.onFault).not.toHaveBeenCalled(); expect(f.driver.close).not.toHaveBeenCalled();
    const view = runtime.presentation.attach('desktop', vi.fn());
    view.write(view.acquireControl()!, 1, '\r');
    expect(f.driver.write).toHaveBeenCalledWith('\r');
    vi.useRealTimers(); await f.ready(); await runtime.ready;
  });

  it('retains an explicit bounded deadline for unattended native probes', async () => {
    const f = fixture(), runtime = await f.start({ readyTimeoutMs: 20 });
    await expect(runtime.ready).rejects.toThrow('timed out');
    await runtime.close();
    expect(f.options.onFault).toHaveBeenCalledOnce(); expect(f.driver.close).toHaveBeenCalledOnce();
  });

  it('routes native permission callbacks through the existing product policy and retires its exact signal', async () => {
    const f = fixture();
    let signal!: AbortSignal;
    const policy = vi.fn(async (_tool: string, _input: object, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return { behavior: 'deny' as const, message: 'product policy' };
    });
    const runtime = await f.start({ canUseTool: policy }); await f.ready(); await runtime.ready;
    const spec = f.spec();
    const reply = await fetch(spec.env.LEX_CLAUDE_BRIDGE_URL + '/request', { method: 'POST',
      headers: { authorization: 'Bearer ' + spec.env.LEX_CLAUDE_BRIDGE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'native', generation: spec.env.LEX_CLAUDE_BRIDGE_GENERATION,
        request: { requestId: '1', kind: 'permission', input: { session_id: 'native', hook_event_name: 'PermissionRequest',
          tool_name: 'Read', tool_use_id: 'native-tool', tool_input: { file_path: '/fixture' } } } }) });
    expect(await reply.json()).toEqual({ result: { behavior: 'deny', message: 'product policy' } });
    expect(policy).toHaveBeenCalledWith('Read', { file_path: '/fixture' }, expect.objectContaining({ toolUseID: 'native-tool' }));
    expect(f.options.onRequest).not.toHaveBeenCalled();
    await f.post([{ sequence: 2, kind: 'request-retired', value: { requestId: '1' } }]);
    expect(signal.aborted).toBe(true);
  });

  it('requires model admission installation and routes authenticated input identities to the host', async () => {
    const missing = fixture(), rejected = await missing.start({ onTurnAdmission: async () => {} });
    const failure = expect(rejected.ready).rejects.toThrow('identity');
    await missing.ready(); await failure; await rejected.close();
    const f = fixture(), admission = vi.fn(async () => {}), runtime = await f.start({ onTurnAdmission: admission });
    expect(f.spec().env.LEX_CLAUDE_BRIDGE_TURN_ADMISSION).toBe('1');
    await f.post([{ sequence: 1, kind: 'ready', value: { sessionId: 'native', isInteractive: true, hostTurnAdmission: true } }]);
    await runtime.ready;
    const spec = f.spec();
    const request = fetch(spec.env.LEX_CLAUDE_BRIDGE_URL + '/request', { method: 'POST',
      headers: { authorization: 'Bearer ' + spec.env.LEX_CLAUDE_BRIDGE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'native', generation: spec.env.LEX_CLAUDE_BRIDGE_GENERATION,
        request: { requestId: '1', kind: 'turn-admission', input: { turnId: 'turn' } } }) });
    await f.post([
      { sequence: 2, kind: 'session.append', value: { uuid: 'row', door: 'prompt', origin: { kind: 'composer' },
        result: { uuid: 'row', message: { type: 'user', content: [{ type: 'text', text: 'native' }] } } } },
      { sequence: 3, kind: 'turn.start', value: { turnId: 'turn', messageIds: ['row'] } },
    ]);
    expect(await (await request).json()).toEqual({ result: { allow: true } });
    expect(admission).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'native', turnId: 'turn',
      messages: [expect.objectContaining({ row: expect.objectContaining({ uuid: 'row' }) })] }), expect.any(AbortSignal));
    expect(f.options.onRequest).not.toHaveBeenCalled();
  });

  it('delivers host-bound GUI input and native TUI input through the same history callback', async () => {
    const f = fixture(), onUserMessage = vi.fn(), runtime = await f.start({ onUserMessage });
    await f.ready(); await runtime.ready;
    const sent = runtime.submit({ messageId: 'gui-row', text: 'identical', originalContent: [{ type: 'text', text: 'identical' }] });
    await Promise.resolve();
    const exchange = await f.post([]);
    expect(exchange.commands).toEqual([{ id: 1, kind: 'submit', payload: { text: 'identical' } }]);
    const append = (uuid: string, origin: object, submissionId?: number) => ({ uuid, door: 'prompt', origin, submissionId,
      result: { uuid, message: { type: 'user', content: [{ type: 'text', text: 'native content' }] } } });
    await f.post([
      { sequence: 2, kind: 'session.append', value: append('native-gui', { kind: 'plugin', name: 'lex-native-bridge' }, 1) },
      { sequence: 3, kind: 'command-result', value: { id: 1, ok: true } },
      { sequence: 4, kind: 'session.append', value: append('native-tui', { kind: 'composer' }) },
    ]);
    expect(await sent).toEqual({ nativeMessageId: 'native-gui' });
    expect(onUserMessage.mock.calls.map(([message]) => [message.row.uuid, message.submission?.submissionId, message.display.content])).toEqual([
      ['native-gui', 'gui-row', [{ type: 'text', text: 'identical' }]],
      ['native-tui', undefined, [{ type: 'text', text: 'native content' }]],
    ]);
    expect(f.options.launch).toHaveBeenCalledOnce();
  });

  it('requires the native ready handshake to confirm configured host hooks are installed', async () => {
    const hooks = { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] };
    const missing = fixture(), rejected = await missing.start({ hooks });
    const failure = expect(rejected.ready).rejects.toThrow('identity');
    expect(missing.spec().env.LEX_CLAUDE_BRIDGE_HOST_HOOKS).toBe('1');
    await missing.ready(); await failure;
    await rejected.close();
    expect(missing.driver.close).toHaveBeenCalledOnce();
    const confirmed = fixture(), runtime = await confirmed.start({ hooks });
    await confirmed.post([{ sequence: 1, kind: 'ready', value: { sessionId: 'native', isInteractive: true, hostHooksEnabled: true } }]);
    await runtime.ready;
    expect(confirmed.options.onFault).not.toHaveBeenCalled();
  });

  it('owns one interactive launch and publishes its presentation before the native ready signal', async () => {
    const f = fixture(), runtime = await f.start();
    expect(f.options.launch).toHaveBeenCalledOnce();
    expect(f.spec().args).toContain('--session-id'); expect(f.spec().args).not.toContain('--print');
    expect(await fs.readFile(path.join(f.pluginRoot(), 'commands/send.md'), 'utf8')).toContain('$ARGUMENTS');
    expect(f.options.env).toEqual({ PROVIDER: 'fixture' });
    const view = runtime.presentation.attach('desktop', vi.fn()); view.detach();
    expect(f.driver.close).not.toHaveBeenCalled();
    await f.ready(); await runtime.ready;
    const pending = runtime.command('snapshot', {});
    await Promise.resolve();
    const exchange = await f.post([]);
    expect(exchange.commands).toEqual([{ id: 1, kind: 'snapshot', payload: {} }]);
    await f.post([{ sequence: 2, kind: 'command-result', value: { id: 1, ok: true, result: { draft: 'native draft' } } }]);
    expect(await pending).toEqual({ draft: 'native draft' });
    await runtime.close(); await runtime.close();
    expect(f.driver.close).toHaveBeenCalledOnce();
    await expect(fs.stat(f.pluginRoot())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps final terminal state readable after natural exit until the task closes', async () => {
    const f = fixture(), runtime = await f.start(); await f.ready(); await runtime.ready;
    const view = runtime.presentation.attach('desktop', vi.fn()); f.exit(0);
    expect(view.read().state).toMatchObject({ status: 'exited', exit: { code: 0 } });
    await expect(runtime.command('submit', { text: 'late' })).rejects.toThrow('closed');
    expect(f.driver.close).not.toHaveBeenCalled();
  });

  it('waits for a pending launch to settle before removing its plugin on cancellation', async () => {
    const f = fixture(), controller = new AbortController();
    let complete!: (driver: AgentTerminalDriver) => void, pluginRoot = '';
    f.options.launch.mockImplementation((spec) => {
      pluginRoot = spec.args[spec.args.indexOf('--plugin-dir') + 1];
      return new Promise(resolve => { complete = resolve; });
    });
    const pending = createClaudeNativeRuntime({ ...f.options, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(complete).toBeDefined()); controller.abort();
    expect((await fs.stat(pluginRoot)).isDirectory()).toBe(true);
    complete(f.driver); await rejected;
    expect(f.driver.close).toHaveBeenCalledOnce();
    await expect(fs.stat(pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a second session or an SDK launch before starting a process', async () => {
    const f = fixture();
    for (const args of [['--print'], ['--session-id=other'], ['--input-format=stream-json']]) {
      await expect(createClaudeNativeRuntime({ ...f.options, args })).rejects.toThrow('interactive session');
    }
    expect(f.options.launch).not.toHaveBeenCalled();
  });
});
