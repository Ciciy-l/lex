/** Run with node --import tsx: actual host PTY/screen + packaged Mod, fake provider only. */
import { AgentTerminalPtyDriver } from '../../apps/desktop/src/main/terminal/agentTerminalDriver.ts';
import { AgentPresentationRuntime } from '../../packages/maker-core/src/agents/presentation.ts';
import { bridgeFactory } from './claude-bridge-probe.mjs';
import { probe } from './claude-mods-probe.mjs';

let runtime, driver, view, control, inputSequence = 0, recovered = false;
const report = await probe({ scenario: 'media', bridgeFactory,
  terminalFactory(executable, args, options) {
    driver = new AgentTerminalPtyDriver({ executable, args, ...options });
    const nativeId = args[args.indexOf('--session-id') + 1];
    runtime = new AgentPresentationRuntime(nativeId, driver, { maxReplayBytes: 256 });
    view = runtime.attach('probe-desktop', () => {
      if (runtime.state().status !== 'running') return;
      const replay = view.read();
      recovered ||= Boolean(replay.snapshot?.data && !replay.gap);
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
try {
  report.checks.hostScreenRecovery = recovered;
  report.checks.sameTaskPresentation = runtime?.state().nativeSessionId === report.nativeSessionId;
  const state = runtime?.state(); view?.detach();
  report.checks.viewDetachKeepsGeneration = state?.generation === runtime?.state().generation;
} finally { await runtime?.close(); }
const passed = Object.values(report.checks).every(Boolean) && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
process.stdout.write(JSON.stringify(report, null, 2), () => process.exit(passed ? 0 : 1));
