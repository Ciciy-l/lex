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
let productSession, productRunning = false;
const denyAdmission = process.argv.includes('--deny-admission');
let commandId = 0;
const report = await probe({ scenario: denyAdmission ? 'admission-deny' : 'media',
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
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      } });
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
        if (event.kind === 'turn.complete' && !value.agentId) {
          productRunning = false; productEvents.push({ type: 'done', source: 'claude-code', data: {} });
        }
      },
      onUserMessage(message) { messages.push(message); },
      async onTurnAdmission(turn, signal) {
        admissions.push({ at: now(), turnId: turn.turnId, messageIds: turn.messages.map(message => message.row.uuid) });
        if (denyAdmission) throw new Error('Fixture host refusal');
        if (turn.messages.length !== 1) throw new Error('Unexpected fixture input grouping');
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
const passed = Object.values(report.checks).every(Boolean) && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
process.stdout.write(JSON.stringify(report, null, 2), () => process.exit(passed ? 0 : 1));
