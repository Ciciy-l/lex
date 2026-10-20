/** Opt-in actual packaged Mod + host transport gate; isolated native CLI/fake provider. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeNativeBridge } from '../../packages/maker-core/src/agents/claude-code/native-bridge.ts';
import { CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, CLAUDE_NATIVE_MOD_SOURCE, CLAUDE_NATIVE_MEDIA_PROMPT } from '../../packages/maker-core/src/agents/claude-code/native-mod-source.ts';
import { probe } from './claude-mods-probe.mjs';
import { ClaudeNativeHooks } from '../../packages/maker-core/src/agents/claude-code/native-hooks.ts';

export function bridgeFactory({ nativeSessionId, report, now, hostHooks }) {
  const identities = new Map();
  const decisions = new Map();
  let nextIdentity = 0;
  const hooks = hostHooks ? new ClaudeNativeHooks(nativeSessionId, hostHooks) : undefined;
  report.droppedEvents = 0;
  const bridge = new ClaudeNativeBridge({
    sessionId: nativeSessionId,
    onEvent(event) {
      // Aliases only in this diagnostic report keep both transports subject to
      // the exact same native assertions. The wire retains its numeric IDs.
      const value = { ...event.value };
      if (value.id) value.id = identities.get(value.id) ?? value.id;
      if (value.submissionId) value.submissionId = identities.get(value.submissionId) ?? value.submissionId;
      const kind = event.kind === 'command-result' ? (value.ok ? 'ack' : 'command-error') : event.kind;
      report.events.push({ at: now(), ...event, kind, value, sessionId: nativeSessionId });
    },
    onRequest(request, signal) {
      if (request.kind === 'hook' && hooks) {
        (report.hostHooks ??= []).push({ kind: request.kind, input: request.input });
        return hooks.run(request.input, signal);
      }
      return new Promise((resolve) => {
        const finish = (result) => {
          signal.removeEventListener('abort', retire); decisions.delete(request.requestId); resolve(result);
        };
        const retire = () => finish({ behavior: 'deny', message: 'fixture callback retired' });
        signal.addEventListener('abort', retire, { once: true });
        decisions.set(request.requestId, finish);
        if (signal.aborted) retire();
      });
    },
    onFault(reason) { report.droppedEvents++; report.bridgeFault = reason; },
  });
  return {
    pluginName: CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME,
    source: CLAUDE_NATIVE_MOD_SOURCE,
    mediaPrompt: CLAUDE_NATIVE_MEDIA_PROMPT,
    async start() { await bridge.start(); return { ...bridge.environment(), LEX_CLAUDE_BRIDGE_HOST_HOOKS: hooks ? '1' : '0' }; },
    send(command) {
      if (command.kind === 'permission') {
        const answer = decisions.get(command.requestId);
        if (!answer) throw new Error('No matching native permission callback');
        answer(command.allow ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: 'Synthetic GUI denial' });
        return;
      }
      identities.set(++nextIdentity, command.id);
      // Native acknowledgments/errors are checked through the event stream, not
      // by treating a submitted command as successful. close rejects leftovers.
      void bridge.command(command.kind, command).catch(() => {});
    },
    close() { return bridge.close(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const auth = process.argv.find((arg) => arg.startsWith('--auth='))?.split('=')[1] ?? 'api-key';
  const scenario = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1] ?? 'identity';
  const report = await probe({ auth, scenario, bridgeFactory: scenario === 'permission-host-hook'
    ? options => bridgeFactory({ ...options, hostHooks: { PreToolUse: [{ hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Synthetic host policy refusal' },
    })] }] } }) : bridgeFactory });
  if (scenario === 'permission-host-hook') report.checks.hostCallbackIdentity = report.hostHooks?.some(({ input }) =>
    input.hook_event_name === 'PreToolUse' && input.tool_use_id === 'tool_mods_write' && input.session_id === report.nativeSessionId) === true;
  const passed = Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean)
    && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
  process.stdout.write(JSON.stringify(report, null, 2), () => process.exit(passed ? 0 : 1));
}
