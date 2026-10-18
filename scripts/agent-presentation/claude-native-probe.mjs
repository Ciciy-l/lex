/**
 * Opt-in native feasibility probe. Uses an isolated home, fake API key and
 * loopback provider/hooks only. Never imports or changes a developer profile.
 * This observes a candidate bridge; it does not enable a product capability.
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeKey = 'sk-ant-api03-lex-native-probe-not-a-real-key';
const firstPrompt = 'LEX_NATIVE_FIRST';
const secondPrompt = 'LEX_NATIVE_SECOND';
const mainModel = 'claude-sonnet-4-6';

export function isolatedEnvironment(parent, home, endpoint) {
  const env = {};
  // Deliberate allowlist: no inherited credentials, proxies, NODE_OPTIONS or
  // agent flags. OS executable lookup remains available to the native CLI.
  for (const [key, value] of Object.entries(parent)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)
      && typeof value === 'string') env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: fakeKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor',
  };
}

export function observedPartialTranscript(report) {
  const stream = report.streams.find((event) => event.marker === 'LEX_FIRST_RESULT' && event.isMain);
  if (!Number.isFinite(stream?.completedAt)) return false;
  return report.transcripts.some(({ at, record }) =>
    at >= stream.firstDeltaAt && at < stream.completedAt
    && record.type === 'assistant' && record.sessionId === report.nativeSessionId
    && record.message?.content?.some((block) =>
      block.type === 'text' && block.text?.includes('LEX_FIRST_RESULT')));
}

async function transcriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) return transcriptFiles(item);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [item] : [];
  }));
  return nested.flat();
}

export async function probe({ binary, deadlineMs = 45_000, scenario = 'messages', extraArgs = [] } = {}) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'lex-claude-presentation-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'work');
  const config = path.join(home, '.claude');
  const sessionId = randomUUID();
  const started = Date.now();
  const report = { scenario, extraArgs, nativeSessionId: sessionId, hooks: [], requests: [],
    streams: [], transcripts: [], terminal: '', exit: null, inputWrites: [],
    checks: {}, error: null };
  let terminal;
  let running = true;
  let poll;
  let acceptedFirst = false;
  const observed = new Set();
  const pending = new Set();
  const now = () => Date.now() - started;
  const server = createServer((req, res) => {
    const task = (async () => {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2_000_000) throw new Error('fixture request too large');
      }
      const body = raw ? JSON.parse(raw) : {};
      if (req.url?.startsWith('/hook/')) {
        report.hooks.push({ at: now(), ...body });
        if (body.hook_event_name === 'UserPromptSubmit' && body.prompt === firstPrompt) {
          acceptedFirst = true;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // Permission response is sent only for this synthetic file-write tool.
        // Hold it briefly to observe whether the native dialog is also visible.
        if (scenario === 'permission' && body.hook_event_name === 'PermissionRequest') {
          await delay(2_000);
          report.permissionDeniedAt = now();
          res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: 'Synthetic fixture denied this write.' } } }));
        } else res.end('{}');
        return;
      }
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(404); res.end(); return;
      }
      const request = { at: now(), path: req.url, model: body.model,
        stream: body.stream, messages: body.messages };
      report.requests.push(request);
      const text = JSON.stringify(body.messages ?? []);
      const isMain = body.model === mainModel;
      const marker = !isMain ? 'LEX_SYNTHETIC_TITLE'
        : text.includes(secondPrompt) ? 'LEX_SECOND_RESULT' : 'LEX_FIRST_RESULT';
      const id = `msg_probe_${report.requests.length}`;
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant',
          model: body.model, content: [{ type: 'text', text: marker }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 } }));
        return;
      }
      const useTool = isMain && scenario === 'permission' && text.includes(firstPrompt) && !text.includes('tool_result');
      const observation = { marker, isMain, model: body.model, firstDeltaAt: null, completedAt: null };
      report.streams.push(observation);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'message_start', message: { id, type: 'message', role: 'assistant',
        model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: useTool
        ? { type: 'tool_use', id: 'tool_native_probe_1', name: 'Write', input: {} }
        : { type: 'text', text: '' } });
      observation.firstDeltaAt = now();
      send({ type: 'content_block_delta', index: 0, delta: useTool
        ? { type: 'input_json_delta', partial_json: JSON.stringify({
          file_path: path.join(cwd, 'probe-write.txt'), content: 'synthetic fixture only' }) }
        : { type: 'text_delta', text: marker } });
      if (isMain && scenario === 'abort') {
        res.on('close', () => { report.providerClosedAt ??= now(); });
        return; // Keep the response open until native Escape aborts the request.
      }
      if (isMain) await delay(3_000);
      if (res.destroyed) return;
      if (!useTool) send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' COMPLETE' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 } });
      observation.completedAt = now();
      send({ type: 'message_stop' });
      res.end();
    })().catch((error) => { report.error ??= error.message; res.destroy(); });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  try {
    await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd, { recursive: true })]);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const hooks = Object.fromEntries(['SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'].map((name) =>
      [name, [{ hooks: [{ type: 'http', url: `${endpoint}/hook/${name}`, timeout: 10 }] }]]));
    const settings = path.join(config, 'settings.json');
    await writeFile(settings, JSON.stringify({ hooks, permissions: { defaultMode: 'default' } }));
    await writeFile(path.join(config, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
      // Claude's persisted project key is a normalized logical path even on
      // Windows. This fixture owns the entire empty workspace.
      projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
    }));
    const executable = binary ?? path.join(root, 'apps/claude-code-bin',
      `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const pty = require('node-pty');
    report.binaryVersion = execFileSync(executable, ['--version'], { cwd,
      env: isolatedEnvironment(process.env, home, endpoint), encoding: 'utf8', timeout: 10_000 }).trim();
    terminal = pty.spawn(executable, ['--session-id', sessionId, '--model', mainModel,
      '--settings', settings, '--setting-sources', '', '--strict-mcp-config',
      '--tools', scenario === 'permission' ? 'Write' : '', ...extraArgs, '--', firstPrompt],
    { cwd, env: isolatedEnvironment(process.env, home, endpoint),
      name: 'xterm-256color', cols: 120, rows: 36, useConpty: true });
    report.pid = terminal.pid;
    terminal.onData((data) => {
      if (report.terminal.length < 200_000) report.terminal += data;
      // Terminal device/status queries, not semantic input or approval replies.
      if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    terminal.onExit((event) => { report.exit = { at: now(), ...event }; });
    poll = (async () => {
      while (running) {
        for (const file of await transcriptFiles(path.join(config, 'projects'))) {
          const content = await readFile(file, 'utf8').catch(() => '');
          for (const line of content.split('\n')) {
            if (!line.trim() || observed.has(line)) continue;
            try { const value = JSON.parse(line); observed.add(line);
              report.transcripts.push({ at: now(), file: path.relative(fixture, file), record: value });
            } catch { /* a partial append is read again */ }
          }
        }
        await delay(75);
      }
    })();
    let secondWritten = false;
    let fixtureTrustAccepted = false;
    let abortWritten = false;
    while (now() < deadlineMs && !report.exit) {
      const screen = stripVTControlCharacters(report.terminal).replace(/\s/g, '');
      if (!fixtureTrustAccepted && screen.includes('Yes,Itrustthisfolder')) {
        // The probe owns this newly created, empty directory. This is fixture
        // setup, not an automatic answer to a real user's workspace prompt.
        terminal.write('\x1b[B'); await delay(100); terminal.write('\r');
        report.inputWrites.push({ at: now(), kind: 'accept-empty-fixture-directory' });
        fixtureTrustAccepted = true;
      }
      if (scenario === 'abort' && !abortWritten && report.streams.some((event) => event.isMain)) {
        await delay(500);
        terminal.write('\x1b');
        report.inputWrites.push({ at: now(), kind: 'diagnostic-native-escape' });
        abortWritten = true;
      }
      if (scenario === 'abort' && report.providerClosedAt && abortWritten) break;
      if (scenario === 'permission' && report.hooks.some((event) => event.hook_event_name === 'Stop')) break;
      if (scenario === 'messages' && !secondWritten && report.hooks.some((event) => event.hook_event_name === 'Stop')) {
        // Diagnostic only: this is deliberately NOT advertised as an adapter.
        // UserPromptSubmit must independently prove native acceptance.
        terminal.write(`\x1b[200~${secondPrompt}\x1b[201~`);
        await delay(100); terminal.write('\r');
        report.inputWrites.push({ at: now(), kind: 'diagnostic-pty-paste', prompt: secondPrompt });
        secondWritten = true;
      }
      if (report.hooks.filter((event) => event.hook_event_name === 'Stop').length >= 2) break;
      await delay(100);
    }
    await delay(200);
    report.checks.firstAccepted = acceptedFirst;
    report.checks.secondAccepted = report.hooks.some((event) =>
      event.hook_event_name === 'UserPromptSubmit' && event.prompt === secondPrompt);
    report.checks.sameSession = report.hooks.length > 0
      && report.hooks.every((event) => event.session_id === sessionId);
    report.checks.partialTranscriptBeforeStreamComplete = observedPartialTranscript(report);
    report.checks.nativeProcessSurvivedBothInputs = report.checks.secondAccepted && !report.exit;
    report.checks.fullAdapterProven = false;
    report.checks.permissionTested = scenario === 'permission'
      && report.hooks.some((event) => event.hook_event_name === 'PermissionRequest');
    report.checks.nativeEscapeClosedProvider = scenario === 'abort' && Boolean(report.providerClosedAt) && !report.exit;
    report.checks.fixtureWriteOccurred = await readFile(path.join(cwd, 'probe-write.txt'), 'utf8')
      .then(() => true, () => false);
    report.observationCompletedAt = now();
    report.elapsedMs = now();
  } catch (error) { report.error = error.stack ?? String(error); } finally {
    const hookCountBeforeCleanup = report.hooks.length;
    running = false; await poll;
    if (terminal && !report.exit) {
      terminal.write('\x03'); await delay(200); terminal.write('\x03');
      for (let i = 0; i < 30 && !report.exit; i++) await delay(100);
      if (!report.exit) terminal.kill();
      for (let i = 0; i < 50 && !report.exit; i++) await delay(100);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...pending]);
    report.cleanupHooks = report.hooks.splice(hookCountBeforeCleanup);
    report.terminalText = stripVTControlCharacters(report.terminal);
    // All profile and transcript files are synthetic and task-owned.
    // Never remove a profile still owned by a native process.
    if (!terminal || report.exit) {
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      report.cleanup = { nativeExited: !terminal || Boolean(report.exit), profileRemoved: true };
    } else {
      report.error ??= 'Native process exit could not be confirmed';
      report.cleanup = { nativeExited: false, profileRemoved: false, retainedFixture: fixture };
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scenario = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1] ?? 'messages';
  if (!['messages', 'permission', 'abort', 'stream-option'].includes(scenario)) throw new Error('Unknown probe scenario');
  const report = await probe({ scenario, extraArgs: scenario === 'stream-option'
    ? ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'] : [] });
  const exitCode = report.error || !report.checks.firstAccepted ? 1 : 0;
  // All owned resources were closed above. ConPTY's JS input pipe can remain
  // referenced after a confirmed native exit; flush the report before exiting
  // this opt-in probe, rather than leaving a diagnostic Node process behind.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(exitCode));
}
