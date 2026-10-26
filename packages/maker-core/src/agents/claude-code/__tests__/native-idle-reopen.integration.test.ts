/** Opt-in: the pinned native CLI, private profile and a loopback fake provider. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vitest';
import { createClaudeNativeSession, type ClaudeNativeSessionHandle } from '../native-session.js';
import { manageClaudeNativeModel } from '../native-idle-reopen.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import type { AgentEvent } from '../../../types/events.js';

const binary = process.env.CINDY_TEST_CLAUDE_BINARY;
it.skipIf(!binary).each(['plain', 'mapped-1m'])('reopens the exact Claude history with a different exact model and both input leases fenced (%s)', async variant => {
  const oldModel = variant === 'plain' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
  const nextModel = variant === 'plain' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6';
  const root = await mkdtemp(path.join(tmpdir(), 'lex-claude-idle-reopen-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), config = path.join(home, '.claude');
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  const key = 'sk-ant-api03-lex-native-probe-not-a-real-key', nativeId = randomUUID();
  const bodies: any[] = [], events: AgentEvent[] = [], executors: Array<{ pid: number; exited: boolean }> = [];
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8'); // Decode split UTF-8 sequences across network chunks.
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
    const body = raw ? JSON.parse(raw) : {};
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    bodies.push(body);
    const frames = [
      { type: 'message_start', message: { id: 'fixture-' + bodies.length, role: 'assistant', type: 'message', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FAKE_NATIVE_REPLY' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''));
  });
  const pty = createRequire(path.resolve('../../package.json'))('node-pty');
  let managed: ReturnType<typeof manageClaudeNativeModel> | undefined;
  const rawHandles: ClaudeNativeSessionHandle[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture endpoint');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string'
      && /^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)) env[key] = value;
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + address.port, ANTHROPIC_API_KEY: key,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', TERM: 'xterm-256color' });
    await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [cwd.split(path.sep).join('/')]: { hasTrustDialogAccepted: true } } }));
    const settings = path.join(config, 'settings.json');
    await writeFile(settings, JSON.stringify({ availableModels: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-6[1m]'] }));
    const usageTracker = new UsageTracker();
    const factory = async (model: string, resume?: string) => {
      expect(executors.every(executor => executor.exited)).toBe(true);
      const nativeModel = variant === 'mapped-1m' && model === nextModel ? model + '[1m]' : model;
      const handle = await createClaudeNativeSession({ model, nativeModel, usageTracker,
        policy: { beforeInput() {}, setInteractionResolver() {}, close() {} },
        async prepareInput(message) { return { text: String(message.content) }; }, onFault() {},
        runtime: { nativeSessionId: nativeId, ...(resume ? { resumeSessionId: resume } : {}), executable: binary!, cwd, env,
          args: ['--model', nativeModel, '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--tools', ''],
          readyTimeoutMs: 20000, onEvent() {},
          launch(spec) {
            const child = pty.spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, cols: 100, rows: 30, name: 'xterm-256color' });
            const owned = { pid: child.pid, exited: false }; executors.push(owned);
            const exit = new Promise<void>(resolve => child.onExit(() => { owned.exited = true; resolve(); }));
            const escape = String.fromCharCode(27); let text = '', trusted = false;
            child.onData((data: string) => {
              text = (text + stripVTControlCharacters(data)).slice(-10000);
              if (!trusted && text.replace(/\s/g, '').includes('Yes,Itrustthisfolder')) {
                trusted = true; child.write(escape + '[B'); setTimeout(() => child.write(String.fromCharCode(13)), 100);
              }
              if (data.includes(escape + '[6n')) child.write(escape + '[1;1R');
              if (data.includes(escape + '[c')) child.write(escape + '[?1;2c');
            });
            return { write: (value: string) => child.write(value), resize: (cols: number, rows: number) => child.resize(cols, rows),
              onData: (listener: (data: string) => void) => { const sub = child.onData(listener); return () => sub.dispose(); },
              onExit: (listener: (exit: { code: number }) => void) => { const sub = child.onExit((exit: { exitCode: number }) => listener({ code: exit.exitCode })); return () => sub.dispose(); },
              async close() {
                if (!owned.exited) { child.write(String.fromCharCode(3)); await new Promise(resolve => setTimeout(resolve, 100)); child.write(String.fromCharCode(3)); }
                for (let i = 0; i < 20 && !owned.exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
                if (!owned.exited) child.kill(); await exit;
              },
            };
          },
        },
      });
      rawHandles.push(handle); return handle;
    };
    const first = await factory(oldModel);
    managed = manageClaudeNativeModel({ initial: first, cwd, reopen: factory });
    void (async () => { for await (const event of managed!.events()) events.push(event); })();
    await first.nativeRuntime.ready;
    await managed.send({ type: 'user', content: 'FIRST_NATIVE_MODEL' });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 15000 });
    expect(bodies).toHaveLength(1);
    await managed.restoreNativeEditorDraft!('保留未发送草稿 /native-command');
    const beforeUsage = managed.getUsageSnapshot();
    const view = managed.presentation!.attach('controller', () => {}), other = managed.presentation!.attach('observer', () => {});
    const oldLease = view.acquireControl()!;
    const changing = managed.setModel!(nextModel);
    expect(other.acquireControl(true)).toBeNull();
    expect(() => view.write(oldLease, 1, 'late')).toThrow();
    await changing;
    expect(managed.id).toBe(nativeId); expect(managed.model).toBe(nextModel);
    expect(await managed.readNativeEditorDraft!()).toBe('保留未发送草稿 /native-command');
    expect(managed.getUsageSnapshot()).toEqual(beforeUsage);
    expect(bodies).toHaveLength(1);
    expect(executors).toHaveLength(2); expect(executors[0]!.exited).toBe(true);
    await managed.send({ type: 'user', content: 'SECOND_NATIVE_MODEL' });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(2), { timeout: 15000 });
    expect(bodies).toHaveLength(2); expect(bodies[1].model).toBe(nextModel);
    expect(JSON.stringify(bodies[1].messages)).toContain('FIRST_NATIVE_MODEL');
    expect(JSON.stringify(bodies[1].messages)).toContain('SECOND_NATIVE_MODEL');
    expect(JSON.stringify(bodies[1].messages)).not.toContain('保留未发送草稿');
    process.stdout.write(JSON.stringify({ nativeClaudeModelReopen: { variant, requests: bodies.length, exactHistory: managed.id, models: bodies.map(body => body.model),
      draftRetained: true, oldExitConfirmed: executors[0]!.exited, usagePreserved: true } }) + '\n');
  } finally {
    await managed?.close(); for (const handle of rawHandles) await handle.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
