/** Real Maker Session/handle/PTY, isolated native CLI and loopback provider only. */
import { AgentTerminalPtyDriver } from '../../apps/desktop/src/main/terminal/agentTerminalDriver.ts';
import { createClaudeNativeSession } from '../../packages/maker-core/src/agents/claude-code/native-session.ts';
import { CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, CLAUDE_NATIVE_MOD_SOURCE, CLAUDE_NATIVE_MEDIA_PROMPT } from '../../packages/maker-core/src/agents/claude-code/native-mod-source.ts';
import { Session } from '../../packages/maker-core/src/session.ts';
import { probe } from './claude-mods-probe.mjs';
import { prepareClaudeNativeLaunch } from '../../packages/maker-core/src/agents/claude-code/native-launch.ts';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

let handle, session, driver, view, lease, diagnostics, now;
let commandId = 0, inputSequence = 0, draining = false, stopped = false;
const commandNames = new Map(), pending = [], queued = [], receipts = [], history = [], productEvents = [], lifecycle = [];
const policyInputs = [];
const presentationSwitches = [];
const preparedLaunchScenario = process.argv.includes('--prepared-launch');
const launchPrefix = 'Lex isolated launch fixture.\nPreserve this prefix exactly.';
const launchRequests = [];
let preparedLaunch;
async function drain() {
  if (draining || stopped || !session || session.isTurnRunning() || !queued.length) return;
  draining = true;
  const command = queued.shift();
  commandNames.set(++commandId, command.id);
  try {
    const result = await session.send({ type: 'user', content: [{ type: 'text', text: command.text },
      ...(command.imagePaths ?? []).map(path => ({ type: 'image', path }))] }, { messageUuid: command.id,
      onAccepted() { history.push({ kind: 'gui', id: command.id }); },
      onNativeUserMessage(source) { receipts.push({ id: command.id, source }); },
    });
    if (!result.accepted) throw new Error('GUI fixture queue was not accepted');
  } catch (error) { diagnostics.commandFailure = String(error); }
  finally { draining = false; if (!session.isTurnRunning()) void drain(); }
}

const report = await probe({ scenario: 'identity', observeRequest(request) {
  if (!preparedLaunchScenario || !request.isMain) return;
  const text = typeof request.system === 'string' ? request.system
    : (request.system ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  launchRequests.push({ prefixPresent: text.includes(launchPrefix),
    systemHash: createHash('sha256').update(JSON.stringify(request.system)).digest('hex'), model: request.model });
}, bridgeFactory(context) {
  diagnostics = context.report; now = context.now; diagnostics.droppedEvents = 0;
  return { pluginName: CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, source: CLAUDE_NATIVE_MOD_SOURCE, mediaPrompt: CLAUDE_NATIVE_MEDIA_PROMPT,
    async start() { return {}; },
    send(command) {
      if (command.kind === 'submit') {
        if (command.id === 'queued') {
          const before = handle.presentation.state();
          view.detach();
          view = handle.presentation.attach('fixture-desktop-return', () => {});
          lease = view.acquireControl(); inputSequence = 0;
          presentationSwitches.push({ at: now(), before, after: handle.presentation.state(), pid: driver.pid });
        }
        queued.push(command); void drain(); return;
      }
      commandNames.set(++commandId, command.id);
      const result = command.kind === 'abort' && command.id !== 'stale-abort'
        ? session.abort() : handle.nativeRuntime.command(command.kind, command);
      pending.push(result.catch(error => { if (command.id !== 'stale-abort') diagnostics.commandFailure = String(error); }));
    },
    async close() { stopped = true; await session?.close(); await handle?.close(); await Promise.all(pending); },
  };
}, async terminalFactory(executable, args, options) {
  const nativeSessionId = args[args.indexOf('--session-id') + 1];
  const resolvedArgs = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break;
    if (args[index] === '--session-id' || args[index] === '--plugin-dir') { index++; continue; }
    resolvedArgs.push(args[index]);
  }
  const canUseTool = async () => ({ behavior: 'deny', message: 'Unexpected fixture tool' });
  if (preparedLaunchScenario) {
    preparedLaunch = await prepareClaudeNativeLaunch({
      abortController: new AbortController(), cwd: options.cwd, additionalDirectories: [], managedSkillPluginRoots: [],
      model: 'claude-sonnet-4-6', permissionMode: 'default', binaryPath: executable, sessionId: nativeSessionId,
      systemPromptAppend: launchPrefix, enableFileCheckpointing: true, env: options.env,
      canUseTool, settingSources: [], settings: JSON.parse(await readFile(resolvedArgs[resolvedArgs.indexOf('--settings') + 1], 'utf8')),
      allowDangerouslySkipPermissions: false, debug: false, hooks: {},
    });
  }
  handle = await createClaudeNativeSession({ model: 'claude-sonnet-4-6',
    policy: { setInteractionResolver() {}, beforeInput(message, sendOptions) {
      policyInputs.push({ id: sendOptions.messageUuid, content: message.content });
    }, close() {} },
    async prepareInput(message) {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      if (blocks.some(block => block.type !== 'text')) throw new Error('This fixture only accepts text');
      return { text: blocks.map(block => block.text).join('\n') };
    },
    onFault(reason) { diagnostics.droppedEvents++; diagnostics.runtimeFault = reason; },
    runtime: { nativeSessionId, executable,
      args: preparedLaunch ? [...preparedLaunch.args, '--tools', '', '--strict-mcp-config'] : resolvedArgs,
      cwd: options.cwd, env: preparedLaunch?.env ?? options.env,
      launch(spec) { driver = new AgentTerminalPtyDriver(spec); return driver; },
      onEvent(event) {
        const value = { ...event.value };
        if (value.id) value.id = commandNames.get(value.id) ?? value.id;
        if (value.submissionId) value.submissionId = commandNames.get(value.submissionId) ?? value.submissionId;
        diagnostics.events.push({ at: now(), ...event, value, sessionId: nativeSessionId,
          kind: event.kind === 'command-result' ? value.ok ? 'ack' : 'command-error' : event.kind });
      },
      canUseTool,
    },
  });
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  session = new Session({ id: 'isolated-native-session', agentKind: 'claude-code', workDir: options.cwd, logger, handle, capabilities: {}, turnStallMs: 0 });
  session.setTurnLifecycleObserver({ beforeProviderStart(generation) { lifecycle.push({ kind: 'prepare', generation }); },
    onUndispatched(generation) { lifecycle.push({ kind: 'undispatched', generation }); },
    onTerminal({ turnGeneration }) { lifecycle.push({ kind: 'terminal', generation: turnGeneration }); } });
  session.onEvent(event => { productEvents.push({ at: now(), ...event }); if (event.type === 'done') queueMicrotask(() => { void drain(); }); });
  session.onNativeInput(async input => {
    const result = await session.acceptNativeInput(input, { signal: input.signal, onAccepted() {
      history.push({ kind: 'native', id: input.nativeMessageId, source: input.source });
    } });
    if (!result.accepted) throw new Error('Native fixture input was not accepted');
  });
  view = handle.presentation.attach('fixture-desktop', () => {}); lease = view.acquireControl();
  return { pid: driver.pid,
    write(data) { view.write(lease, ++inputSequence, data); },
    onData(fn) { return { dispose: driver.onData(fn) }; },
    onExit(fn) { return { dispose: driver.onExit(exit => fn({ exitCode: exit.code, signal: exit.signal })) }; },
    kill() { void handle.close().catch(() => {}); },
  };
} });
if (preparedLaunchScenario) {
  let disposed = false;
  if (preparedLaunch && report.cleanup?.nativeExited) {
    const settingsPath = preparedLaunch.args[preparedLaunch.args.indexOf('--settings') + 1];
    await preparedLaunch.dispose();
    disposed = await stat(path.dirname(settingsPath)).then(() => false, error => error.code === 'ENOENT');
  }
  report.launch = { requests: launchRequests, disposed };
  report.checks.preparedPrefixReachedProvider = launchRequests.length === 5 && launchRequests.every(request => request.prefixPresent);
  report.checks.preparedPrefixStable = launchRequests.length === 5 && new Set(launchRequests.map(request => request.systemHash)).size === 1;
  report.checks.preparedLaunchCleaned = disposed;
}
report.productEvents = productEvents; report.productHistory = history; report.nativeReceipts = receipts; report.productLifecycle = lifecycle;
report.presentationSwitches = presentationSwitches;
// The baseline sends its second prompt into the native queue while busy. This
// handle deliberately uses Maker's product queue instead. Preserve those raw
// baseline outcomes and check the product's actual dispatch boundary separately.
report.nativeQueueBaseline = { busySubmissionRunsAfterFirstTurn: report.checks.busySubmissionRunsAfterFirstTurn,
  streamingWhileInputPending: report.checks.streamingWhileInputPending };
delete report.checks.busySubmissionRunsAfterFirstTurn;
delete report.checks.streamingWhileInputPending;
const queuedAt = report.commands.find(command => command.id === 'queued')?.at;
const firstTerminal = productEvents.find(event => event.type === 'done');
const queuedStart = report.events.find(event => event.kind === 'command-start' && event.value.id === 'queued');
report.checks.productQueueWaitsForTerminal = queuedAt !== undefined && firstTerminal !== undefined
  && queuedAt < firstTerminal.at && queuedStart !== undefined && queuedStart.at >= firstTerminal.at;
report.checks.guiStreamsWhileProductInputWaits = queuedAt !== undefined && firstTerminal !== undefined
  && productEvents.some(event => event.type === 'text' && event.data.isFinal === false && event.at > queuedAt && event.at < firstTerminal.at);
report.checks.viewSwitchKeepsNativeLifetime = presentationSwitches.length === 1 && presentationSwitches.every(change =>
  change.pid === report.pid && change.before.generation === change.after.generation
  && change.before.status === 'running' && change.after.status === 'running');
report.checks.realHandleGuiDispatch = receipts.length === 4 && receipts.every(receipt =>
  history.some(row => row.kind === 'gui' && row.id === receipt.id) && receipt.source.bridge?.submissionId === receipt.id);
report.checks.realHandleNativeAdmission = history.filter(row => row.kind === 'native').length === 1
  && history.find(row => row.kind === 'native')?.source?.origin.kind === 'composer';
report.checks.exactProductLifecycle = lifecycle.filter(event => event.kind === 'prepare').length === 5
  && lifecycle.filter(event => event.kind === 'terminal').length === 5
  && lifecycle.every(event => event.kind !== 'undispatched');
report.checks.sameProductPolicy = policyInputs.length === 5;
report.checks.structuredGuiStreaming = productEvents.some(event => event.type === 'text' && event.data.isFinal === false);
report.checks.noDispatchReplay = queued.length === 0 && !draining && !report.commandFailure && !report.runtimeFault;
report.checks.taskOwnedPresentationClosed = handle?.presentation.state().status === 'closed';
const passed = Object.values(report.checks).every(Boolean) && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
process.stdout.write(JSON.stringify(report, null, 2), () => process.exit(passed ? 0 : 1));
