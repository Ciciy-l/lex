/** Actual production lifetime, message association and PTY; fake provider/owned profiles only. */
import { AgentTerminalPtyDriver } from '../../apps/desktop/src/main/terminal/agentTerminalDriver.ts';
import { createClaudeNativeRuntime } from '../../packages/maker-core/src/agents/claude-code/native-runtime.ts';
import { CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, CLAUDE_NATIVE_MOD_SOURCE, CLAUDE_NATIVE_MEDIA_PROMPT } from '../../packages/maker-core/src/agents/claude-code/native-mod-source.ts';
import { probe } from './claude-mods-probe.mjs';
import { Session } from '../../packages/maker-core/src/session.ts';
import { createAsyncQueue } from '../../packages/maker-core/src/agents/shared/async-queue.ts';

let runtime, driver, view, control, inputSequence = 0, recovered = false, diagnostics, now;
const commandNames = new Map(), pending = [], accepted = [], messages = [];
const admissions = [], lifecycle = [], history = [], productEvents = createAsyncQueue();
const translatedEvents = [];
let productSession, productRunning = false;
let nativeInputResolver;
const denyAdmission = process.argv.includes('--deny-admission');
const denyNativeInput = process.argv.includes('--deny-native-input');
const prepareNativeInput = process.argv.includes('--prepare-native-input') || denyNativeInput;
let refusedNativeInputs = 0;
const preparedRows = new Set();
let commandId = 0;
const report = await probe({ scenario: denyNativeInput ? 'native-input-deny' : denyAdmission ? 'admission-deny' : 'media',
  bridgeFactory(context) {
    diagnostics = context.report; now = context.now; diagnostics.droppedEvents = 0;
    return { pluginName: CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, source: CLAUDE_NATIVE_MOD_SOURCE, mediaPrompt: CLAUDE_NATIVE_MEDIA_PROMPT,
      async start() { return {}; },
      send(command) {
        // Diagnostic aliases only: production commands retain numeric identities.
        commandNames.set(++commandId, command.id);
        const result = command.kind === 'submit'
          ? runtime.submit({ messageId: command.id, text: command.text, imagePaths: command.imagePaths, originalContent: [
            { type: 'text', text: command.text }, ...(command.imagePaths ?? []).map(path => ({ type: 'image', path })),
          ] }).then(receipt => accepted.push({ id: command.id, ...receipt }))
          : runtime.command(command.kind, command);
        pending.push(result.catch(error => {
          if (command.id !== 'stale-abort') diagnostics.commandFailure = String(error);
        }));
      },
      async close() { productEvents.end(); await productSession?.close(); await runtime?.close(); await Promise.all(pending); },
    };
  },
  async terminalFactory(executable, args, options) {
    const nativeSessionId = args[args.indexOf('--session-id') + 1];
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    productSession = new Session({ id: 'isolated-native-task', agentKind: 'claude-code', workDir: options.cwd,
      logger, capabilities: {}, turnStallMs: 0, handle: { id: nativeSessionId, agentKind: 'claude-code', model: 'fixture',
        async send() { throw new Error('A native input must not be submitted twice'); },
        async steer() { throw new Error('No fixture steer'); },
        async abort() { productRunning = false; }, async close() { productEvents.end(); },
        events: () => productEvents, isTurnRunning: () => productRunning, setInteractionResolver() {},
        setNativeInputResolver(resolve) { nativeInputResolver = resolve; },
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      } });
    if (prepareNativeInput) productSession.onNativeInput(async input => {
      if (denyNativeInput) { refusedNativeInputs++; throw new Error('Fixture host refused native input'); }
      const content = typeof input.message.content === 'string' ? [{ type: 'text', text: input.message.content }] : input.message.content;
      const result = await productSession.acceptNativeInput({ ...input, message: { type: 'user',
        content: [...content, { type: 'text', text: 'LEX_HOST_PREPARED_BEFORE_APPEND' }] },
      }, { signal: input.signal, onAccepted() { history.push({ messageId: input.nativeMessageId, preAppend: true }); } });
      if (!result.accepted) throw new Error('Fixture pre-append admission cancelled');
      productRunning = true; preparedRows.add(input.nativeMessageId);
    });
    productSession.setTurnLifecycleObserver({
      beforeProviderStart(generation) { lifecycle.push({ kind: 'prepare', generation }); },
      onUndispatched(generation) { lifecycle.push({ kind: 'undispatched', generation }); },
      onTerminal({ turnGeneration }) { lifecycle.push({ kind: 'terminal', generation: turnGeneration }); },
    });
    const resolvedArgs = [];
    for (let index = 0; index < args.length; index++) {
      // The older probe's /plugin-types startup diagnostic is not task input.
      if (args[index] === '--') break;
      if (args[index] === '--session-id' || args[index] === '--plugin-dir') { index++; continue; }
      resolvedArgs.push(args[index]);
    }
    runtime = await createClaudeNativeRuntime({ nativeSessionId, executable, args: resolvedArgs,
      cwd: options.cwd, env: options.env,
      launch(spec) { driver = new AgentTerminalPtyDriver(spec); return driver; },
      onEvent(event) {
        const value = { ...event.value };
        if (value.id) value.id = commandNames.get(value.id) ?? value.id;
        if (value.submissionId) value.submissionId = commandNames.get(value.submissionId) ?? value.submissionId;
        diagnostics.events.push({ at: now(), ...event, value, sessionId: nativeSessionId,
          kind: event.kind === 'command-result' ? value.ok ? 'ack' : 'command-error' : event.kind });
      },
      onAgentEvent(event) {
        translatedEvents.push({ at: now(), ...event });
        if (event.type === 'done') productRunning = false;
        productEvents.push(event);
      },
      onUserMessage(message) { messages.push(message); },
      ...(prepareNativeInput ? { onNativeInput: input => nativeInputResolver(input) } : {}),
      async onTurnAdmission(turn, signal) {
        admissions.push({ at: now(), turnId: turn.turnId, messageIds: turn.messages.map(message => message.row.uuid) });
        if (denyAdmission) throw new Error('Fixture host refusal');
        if (turn.messages.length !== 1) throw new Error('Unexpected fixture input grouping');
        if (preparedRows.has(turn.messages[0].row.uuid)) return;
        const result = await productSession.acceptNativeInput({ nativeSessionId,
          message: { type: 'user', content: turn.messages[0].display.content },
          async accept() { productRunning = true; },
        }, { signal, onAccepted() { history.push({ turnId: turn.turnId, messageId: turn.messages[0].row.uuid }); } });
        if (!result.accepted) throw new Error('Fixture host admission cancelled');
      },
      async onRequest() { return { behavior: 'deny', message: 'Unexpected fixture permission request' }; },
      onExit() {}, onFault(reason) { diagnostics.droppedEvents++; diagnostics.runtimeFault = reason; },
    });
    view = runtime.presentation.attach('probe-desktop', () => {
      if (runtime.presentation.state().status === 'running') {
        const replay = view.read(); recovered ||= Boolean(replay.snapshot?.data && !replay.gap);
      }
    });
    control = view.acquireControl();
    return { pid: driver.pid,
      write(data) { view.write(control, ++inputSequence, data); },
      onData(fn) { return { dispose: driver.onData(fn) }; },
      onExit(fn) { return { dispose: driver.onExit(exit => fn({ exitCode: exit.code, signal: exit.signal })) }; },
      kill() { void runtime.close().catch(() => {}); },
    };
  },
});
report.nativeUserMessages = messages; report.acceptedSubmissions = accepted;
report.productAdmissions = admissions; report.productLifecycle = lifecycle; report.productHistory = history;
report.productEvents = translatedEvents;
const submissions = report.commands.filter(command => command.kind === 'submit');
report.checks.productionInputReceipts = submissions.length === 4 && submissions.length === accepted.length && submissions.every(command =>
  accepted.some(receipt => receipt.id === command.id && messages.some(message =>
    message.row.uuid === receipt.nativeMessageId && message.submission?.submissionId === command.id)));
report.checks.productionGuiProjection = submissions.length === 4 && submissions.every(command => {
  const message = messages.find(message => message.submission?.submissionId === command.id);
  return message && !message.display.pluginSource && message.display.content[0]?.text === command.text
    && message.display.content.filter(block => block.type === 'image').length === (command.imagePaths?.length ?? 0);
});
report.checks.productionNativeHistory = messages.some(message => message.row.origin.kind === 'composer'
  && !message.submission && JSON.stringify(message.display.content) === JSON.stringify(message.row.message.content));
report.checks.noRuntimeFault = !report.runtimeFault && !report.commandFailure;
report.checks.oneNativeLifetime = runtime?.presentation.state().status === 'closed';
report.checks.productNativeFinality = translatedEvents.filter(event => event.type === 'done').length
  === report.events.filter(event => event.kind === 'turn.complete' && !event.value.agentId
    && admissions.some(admission => admission.turnId === event.value.turnId) && !denyAdmission).length;
report.checks.productNativeAssistantIdentity = translatedEvents.filter(event => event.type === 'text' && event.data.isFinal).every(event =>
  report.events.some(raw => raw.kind === 'session.append' && raw.value.result?.uuid === event.agentMeta?.uuid
    && raw.value.result.message.type === 'assistant'))
  && translatedEvents.every(event => event.agentMeta?.requestId === undefined);
if (denyAdmission) {
  report.checks = { ...report.checks,
    productionInputReceipts: accepted.length === 1,
    productionGuiProjection: messages.length === 1 && !messages[0].display.pluginSource,
    productionNativeHistory: history.length === 0,
    hostRefusalBeforeProvider: admissions.length === 1 && report.requests.filter(request => request.isMain).length === 0
      && report.events.some(event => event.kind === 'turn-rejected'),
  };
} else {
  report.checks.productSessionAdmission = admissions.length === 5 && history.length === 5
    && lifecycle.filter(event => event.kind === 'prepare').length === 5
    && lifecycle.filter(event => event.kind === 'terminal').length === 5;
  report.checks.admittedBeforeProvider = admissions.length === 5 && admissions.every(admission => {
    const step = report.events.find(event => event.kind === 'step-start' && event.value.turnId === admission.turnId);
    return step && step.at >= admission.at;
  });
}
// The driver recovery is separately forced in claude-terminal-probe. A normal
// production replay may remain below its buffer bound throughout this run.
report.observedSnapshotRecovery = recovered;
if (prepareNativeInput) {
  report.checks.nativePreparation = preparedRows.size === 1
    && history.filter(row => row.preAppend).length === 1
    && report.requests.some(request => request.prompt === 'LEX_MODS_NATIVE'
      && request.messages.some(message => message.role === 'user' && Array.isArray(message.content)
        && message.content.some(block => block.type === 'text' && block.text === 'LEX_HOST_PREPARED_BEFORE_APPEND')));
}
if (denyNativeInput) {
  // Exactly the two GUI turns before refusal and one after it entered Session.
  // Native history keeps a neutral refusal, never the refused original content.
  report.checks.productionInputReceipts = accepted.length === 3;
  report.checks.productionGuiProjection = messages.filter(message => message.submission).every(message => !message.display.pluginSource);
  report.checks.productSessionAdmission = history.length === 3 && admissions.length === 3;
  report.checks.admittedBeforeProvider = admissions.length === 3 && admissions.every(admission =>
    report.events.some(event => event.kind === 'step-start' && event.value.turnId === admission.turnId && event.at >= admission.at));
  report.checks.nativePreparation = refusedNativeInputs === 1 && preparedRows.size === 0;
  report.checks.refusedInputAbsentFromLaterRequests = report.requests.filter(request => request.isMain).length === 3
    && report.requests.filter(request => request.isMain).every(request => !JSON.stringify(request.messages).includes('LEX_MODS_NATIVE'));
}
const passed = Object.values(report.checks).every(Boolean) && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
process.stdout.write(JSON.stringify(report, null, 2), () => process.exit(passed ? 0 : 1));
