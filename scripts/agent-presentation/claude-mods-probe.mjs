/** Isolated, opt-in native Mods gate. Never reads a real agent profile. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedEnvironment } from './claude-native-probe.mjs';
import { observeTerminal } from './terminal-observation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const model = 'claude-sonnet-4-6';
const prompts = ['LEX_MODS_FIRST', 'LEX_MODS_QUEUED', 'LEX_MODS_NATIVE', 'LEX_MODS_ABORT', 'LEX_MODS_AFTER'];

export function fixturePrompt(messages) {
  // Title generation may use the main model too. Only a synthetic input block
  // in the latest user message identifies one of this probe's five main turns.
  const user = messages?.findLast((m) => m.role === 'user');
  const blocks = typeof user?.content === 'string' ? [user.content]
    : (user?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text);
  return prompts.find((p) => blocks.some((text) => text === p
    || text.startsWith('The lex-mods-probe plugin sent a message:\n' + p + '\n\n')));
}

export async function probe({ binary, deadlineMs = 65_000, auth = 'api-key' } = {}) {
  if (!['api-key', 'auth-token'].includes(auth)) throw new Error('Unknown fixture auth kind');
  const fixture = await mkdtemp(path.join(tmpdir(), 'lex-claude-mods-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'work');
  const config = path.join(home, '.claude');
  const plugin = path.join(fixture, 'plugin');
  const nativeSessionId = randomUUID();
  const token = randomUUID();
  const start = Date.now();
  const now = () => Date.now() - start;
  const report = { auth, nativeSessionId, events: [], requests: [], streams: [], commands: [],
    terminal: '', terminalText: '', exit: null, checks: {}, error: null };
  const commands = [];
  const pending = new Set();
  const terminalState = { mode: 'text' };
  let terminal;
  const server = createServer((req, res) => {
    const task = (async () => {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2_000_000) throw new Error('Fixture request too large');
      }
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/bridge') {
        if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end(); return; }
        report.events.push(...body.events.map((e) => ({ at: now(), ...e })));
        report.droppedEvents = body.dropped;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ commands: commands.splice(0) }));
        return;
      }
      if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return; }
      if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }
      const prompt = fixturePrompt(body.messages);
      const isMain = prompt !== undefined;
      report.requests.push({ at: now(), model: body.model, isMain, prompt,
        messages: body.messages });
      const marker = isMain ? (prompt ?? 'UNKNOWN') + '_RESULT' : 'LEX_TITLE';
      const id = 'msg_mods_' + report.requests.length;
      const message = { id, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: marker }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 } };
      if (!body.stream) { res.end(JSON.stringify(message)); return; }
      const stream = { at: now(), isMain, prompt, firstDeltaAt: null, completedAt: null, closedAt: null };
      report.streams.push(stream);
      res.on('close', () => { stream.closedAt = now(); });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      send({ type: 'message_start', message: { ...message, content: [], stop_reason: null } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      stream.firstDeltaAt = now();
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: marker } });
      if (isMain && prompt === 'LEX_MODS_ABORT') return;
      if (isMain) {
        await delay(1500);
        if (res.destroyed) return;
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' CONTINUED' } });
        await delay(1500);
      }
      if (res.destroyed) return;
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      stream.completedAt = now();
      send({ type: 'message_stop' }); res.end();
    })().catch((error) => { report.error ??= String(error); res.destroy(); });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  try {
    await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd, { recursive: true }),
      mkdir(path.join(plugin, '.claude-plugin'), { recursive: true }), mkdir(path.join(plugin, 'hooks'), { recursive: true })]);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const env = { ...isolatedEnvironment(process.env, home, endpoint), LEX_MODS_ENDPOINT: endpoint, LEX_MODS_TOKEN: token };
    if (auth === 'auth-token') { env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_API_KEY; }
    await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: ['sk-ant-api03-lex-native-probe-not-a-real-key'.slice(-20)], rejected: [] },
      projects: { [cwd.split(path.sep).join('/')]: { hasTrustDialogAccepted: true } } }));
    const settings = path.join(config, 'settings.json');
    await writeFile(settings, JSON.stringify({ permissions: { defaultMode: 'default' } }));
    await writeFile(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'lex-mods-probe', version: '0.0.1', description: 'Synthetic presentation feasibility fixture', author: { name: 'Lex contributors' } }));
    await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
    await writeFile(path.join(plugin, 'hooks/register.ts'), await readFile(new URL('./claude-mods-fixture.mjs', import.meta.url)));
    await mkdir(path.join(plugin, 'tests'));
    await writeFile(path.join(plugin, 'tests/register.test.ts'), await readFile(new URL('./claude-mods-native.test.ts', import.meta.url)));
    const executable = binary ?? path.join(root, 'apps/claude-code-bin', process.platform + '-' + process.arch, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const cli = (args) => {
      try { return { exitCode: 0, output: execFileSync(executable, args, { env, cwd, encoding: 'utf8', timeout: 15_000 }) }; }
      catch (e) { return { exitCode: e.status, output: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), error: e.code }; }
    };
    report.version = cli(['--version']);
    report.validation = cli(['plugin', 'validate', plugin]);
    report.pluginTest = cli(['plugin', 'test', plugin]);
    if (report.validation.exitCode !== 0 || report.pluginTest.exitCode !== 0) throw new Error('Native plugin validation/test failed; interactive probe not started');
    terminal = require('node-pty').spawn(executable, ['--session-id', nativeSessionId, '--model', model,
      '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--plugin-dir', plugin, '--tools', '', '--', '/plugin-types'],
    { cwd, env, name: 'xterm-256color', cols: 120, rows: 36, useConpty: true });
    report.pid = terminal.pid;
    terminal.onData((data) => {
      if (report.terminal.length < 200_000) report.terminal += data;
      if (report.terminalText.length < 200_000) report.terminalText += observeTerminal(terminalState, data);
      if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    terminal.onExit((e) => { report.exit = { at: now(), ...e }; });
    let trusted = false;
    const issued = new Set();
    const send = (command) => {
      if (issued.has(command.id)) return;
      issued.add(command.id);
      report.commands.push({ at: now(), ...command });
      commands.push(command);
    };
    const eventFor = (kind, predicate) => report.events.find((e) => e.kind === kind && predicate(e.value));
    const complete = (prompt) => eventFor('turn.complete', (v) => !v.agentId && v.answer === prompt + '_RESULT CONTINUED' && v.reason === 'answer');
    let draftedAt;
    let nativeSubmitted = false;
    while (now() < deadlineMs && !report.exit) {
      if (!trusted && report.terminalText.replace(/\s/g, '').includes('Yes,Itrustthisfolder')) {
        terminal.write('\x1b[B'); await delay(100); terminal.write('\r'); trusted = true;
      }
      if (report.events.some((e) => e.kind === 'ready')) send({ id: 'first', kind: 'submit', text: prompts[0] });
      if (!draftedAt && eventFor('chunk', (v) => v.chunk.kind === 'text' && v.chunk.text === prompts[0] + '_RESULT')) {
        terminal.write('\x1b[200~' + prompts[2] + '\x1b[201~');
        draftedAt = now();
        report.nativeDraftWrittenAt = draftedAt;
      }
      if (draftedAt && now() - draftedAt >= 200) {
        send({ id: 'before-queue', kind: 'snapshot' });
        send({ id: 'queued', kind: 'submit', text: prompts[1] });
      }
      if (complete(prompts[1])) send({ id: 'after-queue', kind: 'snapshot' });
      const afterQueue = eventFor('ack', (v) => v.id === 'after-queue');
      if (afterQueue && !nativeSubmitted) {
        if (afterQueue.value.result.draft.text !== prompts[2]) throw new Error('Native draft was not preserved');
        terminal.write('\r'); nativeSubmitted = true;
        report.nativeSubmittedAt = now();
      }
      if (complete(prompts[2])) send({ id: 'abort-start', kind: 'submit', text: prompts[3] });
      const abortTurn = eventFor('turn.start', (v) => v.text.includes(prompts[3]));
      const abortStream = report.streams.find((s) => s.isMain && s.prompt === prompts[3]);
      if (abortTurn && abortStream?.firstDeltaAt) send({ id: 'abort', kind: 'abort', turnId: abortTurn.value.turnId });
      if (abortTurn && eventFor('turn.complete', (v) => v.turnId === abortTurn.value.turnId && v.reason === 'aborted')) {
        send({ id: 'stale-abort', kind: 'abort', turnId: abortTurn.value.turnId });
        send({ id: 'after-abort', kind: 'submit', text: prompts[4] });
      }
      if (complete(prompts[4])) send({ id: 'final', kind: 'snapshot' });
      if (eventFor('ack', (v) => v.id === 'final')) break;
      await delay(100);
    }
    report.aliveBeforeCleanup = !report.exit;
    const typesDirectory = path.join(cwd, '.claude/types');
    report.exportedTypes = [];
    for (const name of await readdir(typesDirectory).catch(() => [])) {
      if (!name.endsWith('.d.ts')) continue;
      const bytes = await readFile(path.join(typesDirectory, name));
      report.exportedTypes.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') });
    }
    report.checks.modLoaded = report.events.some((e) => e.kind === 'ready');
    report.checks.sameSession = report.events.length > 0 && report.events.every((e) => e.sessionId === nativeSessionId);
    report.checks.semanticInput = report.events.some((e) => e.kind === 'turn.start' && e.value.text.includes(prompts[0]));
    report.checks.liveStructuredOutput = report.events.some((e) => e.kind === 'chunk' && e.value.chunk.kind === 'text'
      && report.streams.some((s) => s.isMain && s.prompt === prompts[0] && s.completedAt > e.at && s.firstDeltaAt <= e.at));
    const firstComplete = complete(prompts[0]);
    const queuedStart = eventFor('turn.start', (v) => v.text.includes(prompts[1]));
    const queuedAck = eventFor('ack', (v) => v.id === 'queued');
    const queuedCall = eventFor('command-start', (v) => v.id === 'queued');
    report.checks.busySubmissionRunsAfterFirstTurn = Boolean(firstComplete && queuedStart && queuedAck && queuedCall && complete(prompts[1])
      && queuedCall.at < firstComplete.at && queuedStart.sequence > firstComplete.sequence);
    report.queuedAckBeforeFirstComplete = Boolean(queuedAck && firstComplete && queuedAck.sequence < firstComplete.sequence);
    const firstTurn = eventFor('turn.start', (v) => v.text.includes(prompts[0]));
    report.checks.streamingWhileInputPending = Boolean(firstTurn && queuedCall && queuedAck && report.events.some((e) =>
      e.kind === 'chunk' && e.value.turnId === firstTurn.value.turnId && e.value.chunk.text === ' CONTINUED'
      && e.at > queuedCall.at && e.at < queuedAck.at));
    report.checks.draftPreserved = ['before-queue', 'after-queue'].every((id) =>
      eventFor('ack', (v) => v.id === id)?.value.result.draft.text === prompts[2]);
    report.checks.nativeInputObserved = Boolean(eventFor('prompt.submit', (v) => v.text === prompts[2]) && complete(prompts[2]));
    const abortTurn = eventFor('turn.start', (v) => v.text.includes(prompts[3]));
    report.checks.semanticAbort = Boolean(abortTurn && eventFor('ack', (v) => v.id === 'abort')
      && eventFor('turn.complete', (v) => v.turnId === abortTurn.value.turnId && v.reason === 'aborted')
      && report.streams.some((s) => s.prompt === prompts[3] && s.closedAt && !s.completedAt));
    report.checks.staleAbortRejected = Boolean(eventFor('command-error', (v) => v.id === 'stale-abort'));
    report.checks.aliveAndAcceptsAfterAbort = Boolean(complete(prompts[4]) && !report.exit);
    report.checks.oneRequestPerMainTurn = prompts.every((p) => report.requests.filter((r) => r.isMain && r.prompt === p).length === 1);
    report.checks.nativeTuiRendered = [prompts[0], prompts[1], prompts[2], prompts[4]].every((p) => report.terminalText.includes(p + '_RESULT'));
    report.checks.completeBridgeDelivery = report.droppedEvents === 0 && !report.events.some((e) =>
      e.kind === 'bridge-error' || (e.kind === 'command-error' && e.value.id !== 'stale-abort'));
  } catch (e) { report.error ??= e.stack ?? String(e); }
  finally {
    if (terminal && !report.exit) {
      terminal.write('\x03'); await delay(200); terminal.write('\x03');
      for (let i = 0; i < 30 && !report.exit; i++) await delay(100);
      if (!report.exit) terminal.kill();
      for (let i = 0; i < 50 && !report.exit; i++) await delay(100);
    }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...pending]);
    // Only this mkdtemp-owned path; never remove a live profile or a caller path.
    const relative = path.relative(tmpdir(), fixture);
    if ((!terminal || report.exit) && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('lex-claude-mods-')) {
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      report.cleanup = { nativeExited: true, profileRemoved: true };
    } else report.cleanup = { nativeExited: !terminal || Boolean(report.exit), profileRemoved: false, retainedFixture: fixture };
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const auth = process.argv.find((a) => a.startsWith('--auth='))?.split('=')[1] ?? 'api-key';
  const report = await probe({ auth });
  const passed = Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean)
    && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(passed ? 0 : 1));
}
