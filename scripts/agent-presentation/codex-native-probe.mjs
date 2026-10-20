/** Opt-in native experiment, not a production adapter. No real account/profile. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function isolatedEnvironment(parent, home) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)
      && typeof value === 'string') env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TERM: 'xterm-256color', NO_PROXY: '127.0.0.1,localhost' };
}

export function fixturePrompt(input) {
  const lastUser = Array.isArray(input) ? input.findLast(item => item.role === 'user') : undefined;
  const text = lastUser?.content?.map(part => part.text ?? '').join('');
  return ['LEX_GUI_FIRST', 'LEX_TUI_SECOND', 'LEX_GUI_AFTER_TUI'].includes(text) ? text : null;
}

export async function probe({ binary, deadlineMs = 60_000 } = {}) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'lex-codex-presentation-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'work');
  const env = isolatedEnvironment(process.env, home);
  const token = randomBytes(32).toString('base64url');
  const started = Date.now();
  const now = () => Date.now() - started;
  const report = { engine: 'codex', fixture: 'temporary-isolated-home-loopback-provider',
    protocol: [], streams: [], actions: [], terminal: '', serverOutput: '', checks: {} };
  let native, terminal, gui, proxy, proxyHttp;
  const sockets = new Set();
  const pendingStreams = new Set();
  const pendingRpc = new Map();
  let rpcId = 0;
  const waitFor = async (predicate, label, timeout = 12_000) => {
    const end = Math.min(started + deadlineMs, Date.now() + timeout);
    while (Date.now() < end) {
      const result = predicate();
      if (result) return result;
      await delay(30);
    }
    throw new Error('Timed out: ' + label);
  };
  const provider = createServer((req, res) => {
    const task = (async () => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (!req.url?.endsWith('/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] })); return;
      }
      const body = JSON.parse(raw);
      const stream = { at: now(), prompt: fixturePrompt(body.input), model: body.model,
        id: 'resp_lex_' + (report.streams.length + 1) };
      report.streams.push(stream);
      res.on('close', () => { stream.closedAt = now(); });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = value => res.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
      const response = { id: stream.id, object: 'response', created_at: 1, status: 'in_progress', model: body.model, output: [] };
      const item = { type: 'message', id: 'msg_' + stream.id, role: 'assistant', status: 'in_progress', content: [] };
      send({ type: 'response.created', response });
      send({ type: 'response.output_item.added', output_index: 0, item });
      send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
      const chunks = ['LEX_LIVE_', 'NATIVE_', 'RESPONSE'];
      for (const chunk of chunks) {
        await delay(1_500);
        if (res.destroyed) return;
        stream.firstDeltaAt ??= now();
        send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: chunk });
      }
      const text = chunks.join('');
      const completedItem = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
      send({ type: 'response.output_item.done', output_index: 0, item: completedItem });
      stream.completedAt = now();
      send({ type: 'response.completed', response: { ...response, status: 'completed', output: [completedItem],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
      res.end();
    })().catch(error => { report.providerError = error.message; res.destroy(); });
    pendingStreams.add(task); void task.finally(() => pendingStreams.delete(task));
  });
  const record = (client, direction, value) => report.protocol.push({ at: now(), client, direction, value });
  const rpc = async (method, params) => {
    const id = ++rpcId;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pendingRpc.delete(id); reject(new Error('RPC timeout: ' + method)); }, 12_000);
      pendingRpc.set(id, { resolve, reject, timeout });
    });
    const value = { id, method, params }; record('gui', 'send', value); gui.send(JSON.stringify(value));
    return promise;
  };
  const hasEvent = (client, method, predicate = () => true) => report.protocol.find(event =>
    event.client === client && event.direction === 'receive' && event.value.method === method && predicate(event.value.params, event));
  try {
    await Promise.all([mkdir(env.CODEX_HOME, { recursive: true }), mkdir(cwd, { recursive: true })]);
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + provider.address().port;
    await writeFile(path.join(env.CODEX_HOME, 'config.toml'), [
      'model = "gpt-6-astra"', 'model_provider = "probe"', 'cli_auth_credentials_store = "ephemeral"',
      'check_for_update_on_startup = false', '[model_providers.probe]', 'name = "Probe"',
      'base_url = ' + JSON.stringify(baseUrl), 'wire_api = "responses"',
      'requires_openai_auth = false', 'stream_max_retries = 0', 'request_max_retries = 0',
      '[projects.' + JSON.stringify(cwd) + ']', 'trust_level = "trusted"',
    ].join('\n'));
    const executable = binary ?? path.join(root, 'apps/codex-package-bin',
      process.platform + '-' + process.arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    report.binaryVersion = execFileSync(executable, ['--version'], { cwd, env, encoding: 'utf8', timeout: 10_000 }).trim();
    native = spawn(executable, ['--disable', 'plugins', '--disable', 'remote_plugin', 'app-server',
      '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token',
      '--ws-token-sha256', createHash('sha256').update(token).digest('hex')],
    { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    report.serverPid = native.pid;
    native.on('error', error => { report.serverError = error.message; });
    native.on('exit', (code, signal) => { report.serverExit = { at: now(), code, signal }; });
    for (const stream of [native.stdout, native.stderr]) stream.on('data', data => { report.serverOutput += data.toString(); });
    const address = await waitFor(() => report.serverOutput.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0], 'app-server listener');
    report.address = address;
    gui = new WebSocket(address, { headers: { Authorization: 'Bearer ' + token } }); sockets.add(gui);
    gui.on('error', error => { report.guiError = error.message; });
    gui.on('message', raw => {
      const value = JSON.parse(raw.toString()); record('gui', 'receive', value);
      if (value.id !== undefined && !value.method) {
        const pending = pendingRpc.get(value.id);
        if (pending) { clearTimeout(pending.timeout); pendingRpc.delete(value.id);
          if (value.error) pending.reject(new Error(JSON.stringify(value.error))); else pending.resolve(value.result); }
      }
    });
    await waitFor(() => gui.readyState === WebSocket.OPEN, 'GUI connection');
    await rpc('initialize', { clientInfo: { name: 'lex_native_probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    gui.send(JSON.stringify({ method: 'initialized' }));
    const thread = await rpc('thread/start', { model: 'gpt-6-astra', modelProvider: 'probe', cwd,
      approvalPolicy: 'never', sandbox: 'read-only' });
    report.threadId = thread.thread.id;
    const turn = await rpc('turn/start', { threadId: report.threadId, input: [{ type: 'text', text: 'LEX_GUI_FIRST', text_elements: [] }] });
    report.firstTurnId = turn.turn.id;
    await waitFor(() => report.streams.length, 'first provider stream');

    // Observe real TUI frames transparently. Both sides authenticate with the
    // generated capability, which is never included in evidence.
    proxyHttp = createServer();
    let acceptTui = true;
    proxy = new WebSocketServer({ server: proxyHttp, verifyClient: ({ req }) => acceptTui && req.headers.authorization === 'Bearer ' + token });
    proxy.on('connection', client => {
      sockets.add(client);
      const upstream = new WebSocket(address, { headers: { Authorization: 'Bearer ' + token } }); sockets.add(upstream);
      const queued = [];
      client.on('message', raw => {
        record('tui', 'send', JSON.parse(raw.toString()));
        if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString()); else queued.push(raw.toString());
      });
      upstream.on('open', () => { for (const raw of queued) upstream.send(raw); queued.length = 0; });
      upstream.on('message', raw => { record('tui', 'receive', JSON.parse(raw.toString()));
        if (client.readyState === WebSocket.OPEN) client.send(raw.toString()); });
      client.on('close', () => upstream.close()); upstream.on('close', () => client.close());
      for (const socket of [client, upstream]) socket.on('error', error => { report.proxyError ??= error.message; });
    });
    await new Promise(resolve => proxyHttp.listen(0, '127.0.0.1', resolve));
    terminal = require('node-pty').spawn(executable, ['resume', report.threadId,
      '--remote', 'ws://127.0.0.1:' + proxyHttp.address().port, '--remote-auth-token-env', 'LEX_PROBE_TOKEN',
      '--no-alt-screen'],
    { cwd, env: { ...env, LEX_PROBE_TOKEN: token }, name: 'xterm-256color', cols: 120, rows: 36, useConpty: true });
    report.tuiPid = terminal.pid;
    terminal.onData(data => {
      if (report.terminal.length < 200_000) report.terminal += data;
      if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    terminal.onExit(event => { report.tuiExit = { at: now(), ...event }; });
    await waitFor(() => hasEvent('tui', 'turn/completed', p => p.turn.id === report.firstTurnId), 'TUI observes first completion', 20_000);
    await waitFor(() => hasEvent('gui', 'turn/completed', p => p.turn.id === report.firstTurnId), 'GUI observes first completion');
    terminal.write('\x1b[200~LEX_TUI_SECOND\x1b[201~'); await delay(100); terminal.write('\r');
    report.actions.push({ at: now(), kind: 'native-editor-submit' });
    await waitFor(() => report.streams.some(s => s.prompt === 'LEX_TUI_SECOND'), 'TUI submitted second turn');
    const second = await waitFor(() => hasEvent('gui', 'turn/completed', p => p.threadId === report.threadId && p.turn.id !== report.firstTurnId), 'GUI observes TUI completion', 15_000);
    report.secondTurnId = second.value.params.turn.id;
    const third = await rpc('turn/start', { threadId: report.threadId, input: [{ type: 'text', text: 'LEX_GUI_AFTER_TUI', text_elements: [] }] });
    await waitFor(() => report.streams.some(s => s.prompt === 'LEX_GUI_AFTER_TUI'), 'third provider stream');
    acceptTui = false;
    for (const socket of sockets) if (socket !== gui) socket.terminate();
    report.actions.push({ at: now(), kind: 'disconnect-tui-transport' });
    await waitFor(() => hasEvent('gui', 'turn/completed', p => p.turn.id === third.turn.id), 'third turn survives TUI disconnect', 15_000);
    const snapshot = await rpc('thread/read', { threadId: report.threadId, includeTurns: true });
    report.finalThread = snapshot.thread;
    report.checks.sameOwnerSurvives = !report.serverExit && report.finalThread.id === report.threadId;
    report.checks.guiSeesTuiTurn = second.value.params.turn.status === 'completed';
    report.checks.tuiSeesLiveDelta = Boolean(hasEvent('tui', 'item/agentMessage/delta', (p, event) =>
      p.threadId === report.threadId && event.at < report.streams[0].completedAt));
    report.checks.guiSeesLiveDelta = Boolean(hasEvent('gui', 'item/agentMessage/delta', (p, event) =>
      p.threadId === report.threadId && event.at < report.streams[0].completedAt));
    report.checks.turnSurvivesTuiDisconnect = Boolean(hasEvent('gui', 'turn/completed', p => p.turn.id === third.turn.id && p.turn.status === 'completed'));
    report.checks.nativeScreenContainsResponse = stripVTControlCharacters(report.terminal).includes('LEX_LIVE_NATIVE_RESPONSE');
    report.checks.exactlyThreeMainTurns = report.finalThread.turns.length === 3
      && report.streams.filter(s => s.prompt).length === 3;
  } catch (error) { report.error = error.stack ?? String(error); } finally {
    report.observationCompletedAt = now();
    report.checks.fullAdapterProven = false;
    for (const { reject, timeout } of pendingRpc.values()) { clearTimeout(timeout); reject(new Error('probe cleanup')); }
    pendingRpc.clear();
    for (const socket of sockets) socket.terminate();
    if (terminal && !report.tuiExit) {
      terminal.write('\x03'); await delay(150); terminal.write('\x03');
      for (let i = 0; i < 30 && !report.tuiExit; i++) await delay(100);
      if (!report.tuiExit) terminal.kill();
      for (let i = 0; i < 30 && !report.tuiExit; i++) await delay(100);
    }
    if (native && !report.serverExit) {
      native.kill();
      for (let i = 0; i < 50 && !report.serverExit; i++) await delay(100);
    }
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (proxyHttp) await new Promise(resolve => proxyHttp.close(resolve));
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await Promise.allSettled([...pendingStreams]);
    report.terminalText = stripVTControlCharacters(report.terminal);
    if ((!native || report.serverExit) && (!terminal || report.tuiExit)) {
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      report.cleanup = { nativeExited: true, profileRemoved: true };
    } else { report.cleanup = { nativeExited: false, profileRemoved: false, retainedFixture: fixture }; }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await probe();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(report.error ? 1 : 0));
}
