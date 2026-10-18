/** Opt-in actual packaged permission identity/lifetime gate, with isolated native CLI. */
import { probe } from './claude-mods-probe.mjs';
import { bridgeFactory } from './claude-bridge-probe.mjs';

const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1] ?? 'permission-parallel';
if (!['permission-parallel', 'permission-tui'].includes(scenario)) throw new Error('Unknown permission identity scenario');
const report = await probe({ scenario, permissionTool: scenario === 'permission-parallel' ? 'Read' : 'Write',
  permissionLateAnswer: scenario === 'permission-tui', bridgeFactory });
const permissions = report.events.filter(event => event.kind === 'permission');
const expectedIds = scenario === 'permission-parallel' ? ['tool_mods_write', 'tool_mods_write_2'] : ['tool_mods_write'];
report.checks.causalIdentity = permissions.length === expectedIds.length
  && expectedIds.every(id => permissions.filter(event => event.value.input.tool_use_id === id).length === 1);
report.checks.retiredBeforeTurnCompletion = permissions.every(permission => {
  const retired = report.events.find(event => event.kind === 'request-retired' && event.value.requestId === permission.value.requestId);
  const completed = report.events.find(event => event.kind === 'turn.complete' && !event.value.agentId);
  return retired && completed && retired.sequence < completed.sequence;
});
const calls = report.events.filter(event => event.kind === 'tool.call');
const results = report.events.filter(event => event.kind === 'tool.result');
report.overlappingNativeCalls = calls.length === 2 && results.length === 2 && calls[1].sequence < results[0].sequence;
if (scenario === 'permission-parallel') report.checks.actualConcurrentCalls = report.overlappingNativeCalls;
else report.checks.lateGuiAnswerRejected = report.latePermissionAnswer?.rejected === true;
// Overlap is separately reported, not inferred from the model emitting two tools.
const passed = Object.values(report.checks).every(Boolean) && report.cleanup?.nativeExited && report.cleanup?.profileRemoved && !report.error;
process.stdout.write(JSON.stringify(report, null, 2), () => process.exit(passed ? 0 : 1));
