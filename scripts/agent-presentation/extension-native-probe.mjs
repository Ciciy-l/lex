/** Native Pi/OMP extension-sidechannel experiment. Explicit opt-in, no product wiring. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedEnvironment } from './codex-native-probe.mjs';
import { observeTerminal } from './terminal-observation.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function fixturePrompt(content) {
  const text = typeof content === 'string' ? content : content?.map(p => p.text ?? '').join('');
  const lastLine = text?.trim().split('\n').at(-1);
  return ['LEX_GUI_FIRST', 'LEX_GUI_QUEUED', 'LEX_TUI_THIRD', 'LEX_GUI_ABORT'].includes(lastLine) ? lastLine : null;
}

export const extensionSource = String.raw`
export default function (pi) {
  const endpoint = process.env.LEX_PROBE_ENDPOINT;
  const headers = { authorization: 'Bearer ' + process.env.LEX_PROBE_TOKEN, 'content-type': 'application/json' };
  pi.registerProvider('lex-probe', {
    baseUrl: endpoint, api: 'anthropic-messages', apiKey: 'lex-probe-not-a-real-key',
    models: [{ id: 'lex-native', name: 'Lex native fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  let context, stopped = false;
  const controller = new AbortController();
  const post = async (value) => {
    if (stopped) return;
    await fetch(endpoint + '/event', { method: 'POST', headers, body: JSON.stringify({
      ...value, sessionId: context?.sessionManager.getSessionId(), pid: process.pid,
    }), signal: controller.signal });
  };
  pi.registerCommand('lex-probe-ready', { description: 'Confirm fixture native editor readiness',
    handler: async (_args, ctx) => { context = ctx; await post({ nativeEditorReady: true, idle: ctx.isIdle() }); } });
  for (const name of ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update',
    'message_end', 'tool_call', 'tool_result', 'input']) {
    pi.on(name, async (event, ctx) => { context = ctx; await post({ event }); });
  }
  pi.on('session_start', async (event, ctx) => {
    context = ctx;
    await post({ event, capabilities: { sendUserMessage: typeof pi.sendUserMessage,
      abort: typeof ctx.abort, isIdle: typeof ctx.isIdle, shutdown: typeof ctx.shutdown } });
    void (async () => {
      while (!stopped) {
        const response = await fetch(endpoint + '/command', { headers, signal: controller.signal });
        const command = await response.json();
        if (command.type === 'prompt') {
          pi.sendUserMessage(command.text, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
          await post({ ack: command.id, kind: 'queued-not-completed' });
        } else if (command.type === 'abort') {
          ctx.abort(); await post({ ack: command.id, kind: 'abort-requested' });
        } else if (command.type === 'status') {
          await post({ ack: command.id, idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
        } else if (command.type === 'shutdown') {
          await post({ ack: command.id, kind: 'shutdown-requested' }); ctx.shutdown(); break;
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    })().catch(async error => { if (!stopped) await post({ extensionError: error.message }); });
  });
  pi.on('session_shutdown', async () => { stopped = true; controller.abort(); });
}
`;

export async function probe({ engine = 'pi', binary, deadlineMs = 55_000 } = {}) {
  if (!['pi', 'omp'].includes(engine)) throw new Error('Unknown engine');
  const fixture = await mkdtemp(path.join(tmpdir(), 'lex-' + engine + '-presentation-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'work');
  const agentHome = path.join(home, engine === 'pi' ? '.pi' : '.omp', 'agent');
  const env = { ...isolatedEnvironment(process.env, home), PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: '1' };
  const token = randomBytes(32).toString('base64url');
  const started = Date.now(); const now = () => Date.now() - started;
  const report = { engine, fixture: 'temporary-isolated-home-loopback-provider', events: [], streams: [],
    actions: [], terminal: '', terminalText: '', checks: {} };
  const ansiState = { mode: 'text' };
  const commands = []; const pending = new Set();
  let terminal;
  let nextId = 0;
  const command = value => { const id = ++nextId; commands.push({ ...value, id }); report.actions.push({ ...value, id, at: now() }); return id; };
  const waitFor = async (predicate, label, timeout = 15_000) => {
    const end = Math.min(started + deadlineMs, Date.now() + timeout);
    while (Date.now() < end && !report.exit) { const result = predicate(); if (result) return result; await delay(40); }
    throw new Error('Timed out or exited: ' + label);
  };
  const waitForIdle = async label => {
    const end = Math.min(started + deadlineMs, Date.now() + 15_000);
    while (Date.now() < end) {
      const id = command({ type: 'status' });
      const response = await waitFor(() => report.events.find(e => e.ack === id), label);
      if (response.idle && !response.pending) return;
      await delay(50);
    }
    throw new Error('Timed out: ' + label);
  };
  const server = createServer((req, res) => {
    const task = (async () => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url === '/command' || req.url === '/event') {
        if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
        res.setHeader('content-type', 'application/json');
        if (req.url === '/command') res.end(JSON.stringify(commands.shift() ?? { type: 'none' }));
        else { report.events.push({ at: now(), ...JSON.parse(raw) }); res.end('{}'); }
        return;
      }
      if (!req.url?.startsWith('/v1/messages')) {
        (report.unexpectedRequests ??= []).push({ method: req.method, url: req.url });
        res.writeHead(404); res.end('{}'); return;
      }
      const body = JSON.parse(raw);
      const last = body.messages?.findLast(message => message.role === 'user');
      const prompt = fixturePrompt(last?.content);
      const stream = { at: now(), prompt, model: body.model, id: 'msg_lex_' + (report.streams.length + 1) };
      report.streams.push(stream);
      res.on('close', () => { stream.closedAt = now(); });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = value => res.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
      send({ type: 'message_start', message: { id: stream.id, type: 'message', role: 'assistant',
        model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LEX_LIVE_' } });
      stream.firstDeltaAt = now();
      if (prompt === 'LEX_GUI_ABORT') return; // Native abort must close this provider response.
      await delay(2_000);
      if (res.destroyed) return;
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NATIVE_RESPONSE' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      stream.completedAt = now(); send({ type: 'message_stop' }); res.end();
    })().catch(error => { report.serverError ??= error.stack; res.destroy(); });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  try {
    await Promise.all([mkdir(agentHome, { recursive: true }), mkdir(cwd, { recursive: true })]);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const extensionFile = path.join(fixture, 'presentation-probe.ts');
    await writeFile(extensionFile, extensionSource);
    if (engine === 'omp') {
      // OMP resolves CLI model selection before invoking extension factories.
      // JSON is valid YAML; this fixture contains no real key.
      await writeFile(path.join(agentHome, 'models.yml'), JSON.stringify({ providers: {
        'lex-probe': { baseUrl: endpoint, api: 'anthropic-messages', apiKey: 'lex-probe-not-a-real-key',
          models: [{ id: 'lex-native', name: 'Lex native fixture', reasoning: false, input: ['text'],
            contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      } }));
      // Test profile only: no onboarding/login/browser or network update check.
      await writeFile(path.join(agentHome, 'config.yml'), JSON.stringify({
        startup: { setupWizard: false, checkUpdate: false, showSplash: false },
      }));
    }
    const executable = binary ?? path.join(root, 'apps/' + engine + '-bin',
      process.platform + '-' + process.arch, engine + (process.platform === 'win32' ? '.exe' : ''));
    report.binaryVersion = execFileSync(executable, ['--version'], { cwd, env, encoding: 'utf8', timeout: 10_000 }).trim();
    report.help = execFileSync(executable, ['--help'], { cwd, env, encoding: 'utf8', timeout: 10_000 });
    const args = ['--provider', 'lex-probe', '--model', 'lex-native', '--extension', extensionFile,
      ...(engine === 'pi' ? ['--no-approve', '--no-extensions', '--no-skills']
        : ['--no-extensions', '--no-skills', '--no-rules', '--no-title'])];
    terminal = require('node-pty').spawn(executable, args, { cwd,
      env: { ...env, LEX_PROBE_ENDPOINT: endpoint, LEX_PROBE_TOKEN: token,
        ...(engine === 'omp' ? { PI_BUILD_URL: endpoint } : {}) },
      name: 'xterm-256color', cols: 120, rows: 36, useConpty: true });
    report.pid = terminal.pid;
    terminal.onData(data => {
      report.terminal += data;
      if (report.terminal.length > 200_000) {
        report.terminal = report.terminal.slice(-200_000); report.terminalTruncated = true;
      }
      report.terminalText = (report.terminalText + observeTerminal(ansiState, data)).slice(-100_000);
      if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    terminal.onExit(event => { report.exit = { at: now(), ...event }; });
    const ready = await waitFor(() => report.events.find(e => e.event?.type === 'session_start'), 'extension ready');
    report.sessionId = ready.sessionId;
    if (engine === 'omp') {
      await waitFor(() => report.terminalText.includes('to change thinking effort'), 'OMP startup animation finishes');
    }
    terminal.write('\x1b[200~/lex-probe-ready\x1b[201~'); await delay(100); terminal.write('\r');
    await waitFor(() => report.events.some(e => e.nativeEditorReady), 'native editor readiness acknowledgement');
    command({ type: 'prompt', text: 'LEX_GUI_FIRST' });
    await waitFor(() => report.streams.some(s => s.prompt === 'LEX_GUI_FIRST'), 'GUI first accepted');
    command({ type: 'prompt', text: 'LEX_GUI_QUEUED' });
    await waitFor(() => report.streams.some(s => s.prompt === 'LEX_GUI_QUEUED' && s.completedAt), 'queued follow-up completed');
    await waitForIdle('native idle after queue');
    terminal.write('\x1b[200~LEX_TUI_THIRD\x1b[201~'); await delay(100); terminal.write('\r');
    report.actions.push({ at: now(), type: 'native-editor-submit' });
    await waitFor(() => report.streams.some(s => s.prompt === 'LEX_TUI_THIRD' && s.completedAt), 'native TUI turn completed');
    await delay(150);
    command({ type: 'prompt', text: 'LEX_GUI_ABORT' });
    const abortStream = await waitFor(() => report.streams.find(s => s.prompt === 'LEX_GUI_ABORT'), 'abort turn started');
    await delay(300); command({ type: 'abort' });
    await waitFor(() => abortStream.closedAt, 'native abort closes provider');
    await waitForIdle('idle after abort');
    const first = report.streams.find(s => s.prompt === 'LEX_GUI_FIRST');
    report.checks.structuredLiveOutput = report.events.some(e => e.event?.type === 'message_update'
      && e.event.assistantMessageEvent?.type === 'text_delta' && e.at < first.completedAt);
    report.checks.sameNativeSession = report.events.length > 0 && report.events.every(e => e.sessionId === report.sessionId && e.pid === report.pid);
    report.checks.queuedInputAfterFirst = report.streams.find(s => s.prompt === 'LEX_GUI_QUEUED').at >= first.completedAt;
    report.checks.nativeTuiInputObserved = report.events.some(e => e.event?.type === 'message_start'
      && e.event.message?.role === 'user' && JSON.stringify(e.event.message.content).includes('LEX_TUI_THIRD'));
    report.checks.nativeScreenContainsResponse = report.terminalText.includes('LEX_LIVE_NATIVE_RESPONSE');
    report.checks.abortWithoutProcessExit = Boolean(abortStream.closedAt) && !report.exit;
  } catch (error) { report.error = error.stack ?? String(error); } finally {
    process.stderr.write('probe observation: ' + JSON.stringify({ error: report.error, checks: report.checks,
      streams: report.streams, actions: report.actions, exit: report.exit }) + '\n');
    report.observationCompletedAt = now(); report.checks.fullAdapterProven = false;
    if (terminal && !report.exit) {
      command({ type: 'shutdown' });
      for (let i = 0; i < 30 && !report.exit; i++) await delay(100);
      if (!report.exit) { terminal.write('\x03'); await delay(100); terminal.write('\x03'); }
      for (let i = 0; i < 30 && !report.exit; i++) await delay(100);
      if (!report.exit) terminal.kill();
      for (let i = 0; i < 30 && !report.exit; i++) await delay(100);
    }
    process.stderr.write('probe cleanup: native stopped ' + JSON.stringify(report.exit) + '\n');
    const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing;
    process.stderr.write('probe cleanup: server closed\n');
    await Promise.allSettled([...pending]);
    if (!terminal || report.exit) {
      try {
        await rm(fixture, { recursive: true, force: true, maxRetries: 0 });
        report.cleanup = { nativeExited: true, profileRemoved: true };
      } catch (error) {
        report.cleanup = { nativeExited: true, profileRemoved: false, retainedFixture: fixture, error: error.message };
      }
    } else report.cleanup = { nativeExited: false, profileRemoved: false, retainedFixture: fixture };
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const engine = process.argv.find(arg => arg.startsWith('--engine='))?.split('=')[1] ?? 'pi';
  const report = await probe({ engine });
  const failed = report.error || !report.cleanup?.profileRemoved
    || Object.entries(report.checks).some(([key, value]) => key !== 'fullAdapterProven' && !value);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(failed ? 1 : 0));
}
