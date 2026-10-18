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
import { projectClaudeNativeMessage } from '../../packages/maker-core/src/agents/claude-code/native-message-projection.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const model = 'claude-sonnet-4-6';
const prompts = ['LEX_MODS_FIRST', 'LEX_MODS_QUEUED', 'LEX_MODS_NATIVE', 'LEX_MODS_ABORT', 'LEX_MODS_AFTER'];

export function fixturePrompt(messages, pluginName = 'lex-mods-probe') {
  // Tool continuations have a newer user-role result, but no new human prompt.
  // Do not search past a different user input (including a title request).
  for (const user of [...(messages ?? [])].reverse()) {
    if (user.role !== 'user') continue;
    const content = typeof user.content === 'string' ? [{ type: 'text', text: user.content }] : user.content ?? [];
    const blocks = content.filter((b) => b.type === 'text').map((b) => b.text);
    const prompt = prompts.find((p) => blocks.some((text) => text === p
      || text.startsWith('The ' + pluginName + ' plugin sent a message:\n' + p + '\n\n')));
    if (prompt) return prompt;
    if (!content.some((b) => b.type === 'tool_result')
      || !content.every((b) => b.type === 'tool_result' || (b.type === 'text' && b.text.startsWith('<system-reminder>')))) return;
  }
}

export async function probe({ binary, deadlineMs = 65_000, auth = 'api-key', scenario = 'controls', bridgeFactory, terminalFactory } = {}) {
  if (!['api-key', 'auth-token'].includes(auth)) throw new Error('Unknown fixture auth kind');
  if (!['controls', 'identity', 'media', 'admission-deny', 'permission-gui', 'permission-tui', 'permission-deny-rule', 'permission-host-hook'].includes(scenario)) throw new Error('Unknown fixture scenario');
  const permissionScenario = scenario.startsWith('permission-');
  const mediaScenario = scenario === 'media';
  const fixture = await mkdtemp(path.join(tmpdir(), 'lex-claude-mods-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, mediaScenario ? 'work with spaces' : 'work');
  const imagePath = path.join(cwd, 'fixture image.png');
  const imageBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0D8AAAAASUVORK5CYII=';
  const literalText = prompts[0] + String.fromCharCode(10) + '!' + String.fromCharCode(96) + 'echo LEX_LITERAL_COMMAND' + String.fromCharCode(96) + ' $ARGUMENTS @missing-literal.md';
  const config = path.join(home, '.claude');
  const plugin = path.join(fixture, 'plugin');
  const nativeSessionId = randomUUID();
  const token = randomUUID();
  const start = Date.now();
  const now = () => Date.now() - start;
  const report = { auth, scenario, nativeSessionId, events: [], requests: [], streams: [], commands: [],
    terminal: '', terminalText: '', exit: null, checks: {}, error: null };
  const commands = [];
  const pending = new Set();
  const terminalState = { mode: 'text' };
  let terminal;
  // Optional real transport uses the same provider, native process and assertions.
  // The historical fixture remains a separate baseline, not production evidence.
  const bridge = bridgeFactory ? await bridgeFactory({ nativeSessionId, report, now }) : undefined;
  const pluginName = bridge?.pluginName ?? 'lex-mods-probe';
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
      const prompt = mediaScenario && body.messages?.at(-1)?.content?.some?.((b) => b.type === 'text' && b.text === literalText)
        ? prompts[0] : fixturePrompt(body.messages, pluginName);
      const afterTool = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
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
      const useTool = permissionScenario && isMain && !afterTool;
      send({ type: 'content_block_start', index: 0, content_block: useTool
        ? { type: 'tool_use', id: 'tool_mods_write', name: 'Write', input: {} } : { type: 'text', text: '' } });
      stream.firstDeltaAt = now();
      send({ type: 'content_block_delta', index: 0, delta: useTool
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: path.join(cwd, 'mods-proof.txt'), content: 'synthetic mods write' }) }
        : { type: 'text_delta', text: marker } });
      if (isMain && prompt === 'LEX_MODS_ABORT') return;
      if (isMain && !useTool) {
        await delay(1500);
        if (res.destroyed) return;
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' CONTINUED' } });
        await delay(1500);
      }
      if (res.destroyed) return;
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      stream.completedAt = now();
      send({ type: 'message_stop' }); res.end();
    })().catch((error) => { report.error ??= String(error); res.destroy(); });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  try {
    await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd, { recursive: true }),
      mkdir(path.join(plugin, '.claude-plugin'), { recursive: true }), mkdir(path.join(plugin, 'hooks'), { recursive: true })]);
    if (mediaScenario) await writeFile(imagePath, Buffer.from(imageBytes, 'base64'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const env = { ...isolatedEnvironment(process.env, home, endpoint), LEX_MODS_ENDPOINT: endpoint, LEX_MODS_TOKEN: token,
      ...(bridge ? await bridge.start() : {}) };
    if (auth === 'auth-token') { env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_API_KEY; }
    await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: ['sk-ant-api03-lex-native-probe-not-a-real-key'.slice(-20)], rejected: [] },
      projects: { [cwd.split(path.sep).join('/')]: { hasTrustDialogAccepted: true } } }));
    const settings = path.join(config, 'settings.json');
    await writeFile(settings, JSON.stringify({ permissions: { defaultMode: 'default',
      ...(scenario === 'permission-deny-rule' ? { deny: ['Write'] } : {}) } }));
    await writeFile(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: pluginName, version: '0.0.1', description: 'Synthetic presentation feasibility fixture', author: { name: 'Lex contributors' } }));
    await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
    const moduleSource = bridge?.source ?? await readFile(new URL('./claude-mods-fixture.mjs', import.meta.url), 'utf8');
    await writeFile(path.join(plugin, 'hooks/register.ts'), moduleSource);
    if (bridge?.mediaPrompt) {
      await mkdir(path.join(plugin, 'commands'));
      await writeFile(path.join(plugin, 'commands/send.md'), bridge.mediaPrompt);
    }
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
    const spawnTerminal = terminalFactory ?? require('node-pty').spawn;
    terminal = await spawnTerminal(executable, ['--session-id', nativeSessionId, '--model', model,
      '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--plugin-dir', plugin, '--tools', permissionScenario ? 'Write' : '', '--', '/plugin-types'],
    { cwd, env, name: 'xterm-256color', cols: 120, rows: 36, useConpty: true });
    report.pid = terminal.pid;
    terminal.onData((data) => {
      if (report.terminal.length < 200_000) report.terminal += data;
      if (report.terminalText.length < 200_000) report.terminalText += observeTerminal(terminalState, data);
      if (!terminalFactory && data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (!terminalFactory && data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    terminal.onExit((e) => { report.exit = { at: now(), ...e }; });
    let trusted = false;
    const issued = new Set();
    const send = (command) => {
      if (issued.has(command.id)) return;
      issued.add(command.id);
      report.commands.push({ at: now(), ...command });
      if (bridge) bridge.send(command);
      else commands.push(command);
    };
    const eventFor = (kind, predicate) => report.events.find((e) => e.kind === kind && predicate(e.value));
    const complete = (prompt) => eventFor('turn.complete', (v) => !v.agentId && v.answer === prompt + '_RESULT CONTINUED' && v.reason === 'answer');
    const submittedTurn = (id, text) => {
      // Media turn.start names the native command, not the expanded prompt. Its
      // unique bridge marker binds that command row; never deduplicate user text.
      const command = mediaScenario ? eventFor('session.append', value => value.submissionId === id && value.door === 'command') : undefined;
      const nativeText = command?.value.result.message.content.find(block => block.type === 'text')?.text;
      return eventFor('turn.start', value => !value.agentId && (nativeText ? value.text === nativeText : value.text.includes(text)));
    };
    let draftedAt;
    let nativeSubmitted = false;
    while (now() < deadlineMs && !report.exit) {
      if (!trusted && report.terminalText.replace(/\s/g, '').includes('Yes,Itrustthisfolder')) {
        terminal.write('\x1b[B'); await delay(100); terminal.write('\r'); trusted = true;
      }
      if (report.events.some((e) => e.kind === 'ready')) send({ id: 'first', kind: 'submit', text: mediaScenario ? literalText : prompts[0], ...(mediaScenario ? { imagePaths: [imagePath] } : {}) });
      if (scenario === 'admission-deny') {
        if (eventFor('turn-rejected', () => true) && eventFor('turn.complete', () => true)) break;
        await delay(100); continue;
      }
      if (permissionScenario) {
        const request = eventFor('permission', () => true);
        if (request && now() - request.at >= 1000) {
          if (scenario === 'permission-gui') send({ id: 'gui-permission', kind: 'permission', requestId: request.value.requestId, allow: false });
          if (scenario === 'permission-tui' && !nativeSubmitted && report.terminalText.includes('Yes')) {
            terminal.write('\r'); nativeSubmitted = true; report.nativePermissionAt = now();
          }
        }
        if (eventFor('turn.complete', (v) => !v.agentId)) break;
        await delay(100);
        continue;
      }
      if (!draftedAt && eventFor('chunk', (v) => v.chunk.kind === 'text' && v.chunk.text === prompts[0] + '_RESULT')) {
        terminal.write('\x1b[200~' + prompts[2] + '\x1b[201~');
        draftedAt = now();
        report.nativeDraftWrittenAt = draftedAt;
      }
      if (draftedAt && now() - draftedAt >= 200) {
        send({ id: 'before-queue', kind: 'snapshot' });
        send({ id: 'queued', kind: 'submit', text: prompts[1], ...(mediaScenario ? { imagePaths: [imagePath] } : {}) });
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
    report.checks.semanticInput = Boolean(submittedTurn('first', prompts[0]));
    report.checks.liveStructuredOutput = report.events.some((e) => e.kind === 'chunk' && e.value.chunk.kind === 'text'
      && report.streams.some((s) => s.isMain && s.prompt === prompts[0] && s.completedAt > e.at && s.firstDeltaAt <= e.at));
    const firstComplete = complete(prompts[0]);
    const queuedStart = submittedTurn('queued', prompts[1]);
    const queuedAck = eventFor('ack', (v) => v.id === 'queued');
    const queuedCall = eventFor('command-start', (v) => v.id === 'queued');
    report.checks.busySubmissionRunsAfterFirstTurn = Boolean(firstComplete && queuedStart && queuedAck && queuedCall && complete(prompts[1])
      && queuedCall.at < firstComplete.at && queuedStart.sequence > firstComplete.sequence);
    report.queuedAckBeforeFirstComplete = Boolean(queuedAck && firstComplete && queuedAck.sequence < firstComplete.sequence);
    const firstTurn = submittedTurn('first', prompts[0]);
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
    if (mediaScenario) {
      report.checks.mediaBytesDelivered = [prompts[0], prompts[1]].every(prompt => report.requests.some(request => request.prompt === prompt
        && request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).some(block =>
          block.type === 'image' && block.source?.type === 'base64' && block.source.data === imageBytes)));
      report.checks.literalBodyPreservedOnce = report.requests.filter(request => request.prompt === prompts[0]).length === 1
        && report.requests.find(request => request.prompt === prompts[0])?.messages.flatMap(message =>
          Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'text' && block.text === literalText).length === 1;
      report.checks.mediaCommandIdentity = ['first', 'queued'].every(id => report.events.filter(event =>
        event.kind === 'session.append' && event.value.door === 'command' && event.value.submissionId === id).length === 1);
    }
    if (permissionScenario) {
      report.fixtureWrite = await readFile(path.join(cwd, 'mods-proof.txt'), 'utf8').catch(() => null);
      const toolResults = report.requests.flatMap((r) => r.messages ?? []).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result' && b.tool_use_id === 'tool_mods_write') : []);
      const disabledResult = toolResults.some((b) => b.is_error === true
        && typeof b.content === 'string' && b.content.includes('Write is disabled for this session'));
      report.checks = {
        modLoaded: report.checks.modLoaded,
        sameSession: report.checks.sameSession,
        nativeToolObserved: scenario === 'permission-deny-rule' ? disabledResult
          : Boolean(eventFor('tool.call', (v) => v.tool === 'Write' && v.tool_use_id === 'tool_mods_write')),
        completed: Boolean(complete(prompts[0])),
        permissionObserved: ['permission-deny-rule', 'permission-host-hook'].includes(scenario) ? !eventFor('permission', () => true) : Boolean(eventFor('permission', () => true)),
        fileOutcome: scenario === 'permission-tui' ? report.fixtureWrite === 'synthetic mods write' : report.fixtureWrite === null,
        ruleRespected: scenario !== 'permission-deny-rule' || (disabledResult
          && !eventFor('tool.call', () => true) && !eventFor('permission', () => true)),
        nativeResultReturned: toolResults.some((b) => scenario === 'permission-tui' ? !b.is_error : b.is_error === true),
        completeBridgeDelivery: report.checks.completeBridgeDelivery,
      };
    }
    if (scenario === 'admission-deny') {
      report.checks = { modLoaded: report.checks.modLoaded, sameSession: report.checks.sameSession,
        semanticInput: report.checks.semanticInput, refusedBeforeModel: report.requests.every(request => !request.isMain),
        nativeRejected: Boolean(eventFor('turn-rejected', () => true)),
        nativeAborted: Boolean(eventFor('turn.complete', value => value.reason === 'aborted')),
        aliveBeforeCleanup: report.aliveBeforeCleanup };
    }
  } catch (e) { report.error ??= e.stack ?? String(e); }
  finally {
    if (terminal && !report.exit) {
      terminal.write('\x03'); await delay(200); terminal.write('\x03');
      for (let i = 0; i < 30 && !report.exit; i++) await delay(100);
      if (!report.exit) terminal.kill();
      for (let i = 0; i < 50 && !report.exit; i++) await delay(100);
    }
    await bridge?.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...pending]);
    // Read only this run's isolated transcript, after native shutdown flushed it.
    try {
      if (terminal && report.exit) {
        const projects = path.join(config, 'projects');
        report.transcriptRows = [];
        for (const name of await readdir(projects, { recursive: true }).catch(() => [])) {
          if (path.basename(name) !== nativeSessionId + '.jsonl') continue;
          const rows = (await readFile(path.join(projects, name), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
          report.transcriptRows.push(...rows);
        }
        if (scenario === 'identity') {
          const rows = report.events.filter((e) => e.kind === 'session.append'
            && ['user', 'assistant'].includes(e.value.result.message?.type));
          report.checks.nativeMessageIds = ['user', 'assistant'].every((type) => rows.some((e) => e.value.result.message.type === type))
            && rows.every((e) => e.value.uuid === e.value.result.uuid && report.transcriptRows.some((row) =>
              row.uuid === e.value.uuid && row.type === e.value.result.message.type
              && JSON.stringify(typeof row.message?.content === 'string'
                ? [{ type: 'text', text: row.message.content }] : row.message?.content)
                === JSON.stringify(e.value.result.message.content)));
          const submits = report.commands.filter((c) => c.kind === 'submit');
          report.checks.submissionIdentity = submits.length === 4 && submits.every((command) => {
            const matches = rows.filter((e) => e.value.submissionId === command.id);
            return matches.length === 1 && matches[0].value.origin.kind === 'plugin'
              && matches[0].value.origin.name === pluginName;
          });
          report.checks.nativeInputHasNoBridgeSubmission = rows.some((e) => e.value.door === 'prompt'
            && e.value.origin.kind === 'composer' && !e.value.submissionId);
          report.guiMessages = rows.map((event) => {
            const row = { sessionId: event.sessionId, ...event.value, message: event.value.result.message };
            const command = submits.find((c) => c.id === event.value.submissionId);
            const binding = command ? { sessionId: event.sessionId, nativeMessageId: row.uuid,
              submissionId: command.id, pluginName,
              originalContent: [{ type: 'text', text: command.text }] } : undefined;
            return { uuid: row.uuid, submissionId: command?.id,
              projection: projectClaudeNativeMessage(row, pluginName, binding) };
          });
          report.checks.builtInGuiProjection = submits.every((command) => {
            const display = report.guiMessages.find((m) => m.submissionId === command.id)?.projection;
            return display && !display.pluginSource
              && JSON.stringify(display.content) === JSON.stringify([{ type: 'text', text: command.text }]);
          });
        }
      }
    } catch (error) {
      report.error ??= 'Isolated transcript audit failed: ' + String(error);
    }
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
  const scenario = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1] ?? 'controls';
  const report = await probe({ auth, scenario });
  const passed = Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean)
    && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(passed ? 0 : 1));
}
