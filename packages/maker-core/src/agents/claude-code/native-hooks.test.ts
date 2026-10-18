import { describe, expect, it, vi } from 'vitest';
import { ClaudeNativeHooks } from './native-hooks.js';
import { buildClaudeAskUserQuestionCallerProvenanceHooks, buildClaudeOrcaCallerProvenanceHooks, mergeClaudeHookSets } from './capability-routing.js';
import { buildClaudeSubagentModelGuardHooks } from './subagent-model-access.js';

const input = { hook_event_name: 'PreToolUse', session_id: 'session', cwd: '/work', transcript_path: '', tool_name: 'Write', tool_input: {}, tool_use_id: 'call' } as const;
const signal = () => new AbortController().signal;
describe('existing host hooks on the native runtime', () => {
  it('runs matching callbacks in order with the original call identity and retains rewrites and denial', async () => {
    const seen: unknown[] = [];
    const hooks = new ClaudeNativeHooks('session', { PreToolUse: [
      { matcher: 'Read', hooks: [vi.fn(async () => { throw new Error('wrong matcher'); })] },
      { hooks: [async (event, id) => { seen.push([event, id]); return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { file_path: '/owned/processed.webp' } } }; },
        async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'route denied' } }),
        async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })] },
    ] });
    expect(await hooks.run(input, signal())).toEqual({ updatedInput: { file_path: '/owned/processed.webp' }, deny: 'route denied' });
    expect(seen).toEqual([[input, 'call']]);
  });

  it('uses the real root-only and model-access hooks rather than recreating their policies', async () => {
    const hooks = new ClaudeNativeHooks('session', mergeClaudeHookSets(
      buildClaudeAskUserQuestionCallerProvenanceHooks(), buildClaudeOrcaCallerProvenanceHooks(),
      buildClaudeSubagentModelGuardHooks(async () => ({ status: 'denied', reason: 'model unavailable' })),
    ));
    expect(await hooks.run({ ...input, tool_name: 'AskUserQuestion', agent_id: 'child' }, signal())).toMatchObject({ deny: expect.stringContaining('NATIVE_SUBAGENT_USER_INPUT_NOT_ALLOWED') });
    expect(await hooks.run({ ...input, tool_name: 'AskUserQuestion' }, signal())).toEqual({});
    expect(await hooks.run({ ...input, tool_name: 'mcp__orca_worker_bridge__send_to_lead', agent_id: 'child' }, signal())).toMatchObject({ deny: expect.any(String) });
    expect(await hooks.run({ ...input, tool_name: 'Agent', tool_input: { model: 'fixture' } }, signal())).toEqual({ deny: 'model unavailable' });
  });

  it('propagates cancellation to a pending callback and never accepts its late allow', async () => {
    const controller = new AbortController();
    let received!: AbortSignal, finish!: (value: any) => void;
    const hooks = new ClaudeNativeHooks('session', { PreToolUse: [{ hooks: [async (_event, _id, options) => {
      received = options.signal; return new Promise(resolve => { finish = resolve; });
    }] }] });
    const pending = hooks.run(input, controller.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(received).toBeDefined()); controller.abort(); await rejected;
    expect(received.aborted).toBe(true);
    finish({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });

  it('keeps cleanup hooks and rejects unsupported callbacks or foreign session requests', async () => {
    const cleanup = vi.fn(async () => ({ continue: true }));
    const hooks = new ClaudeNativeHooks('session', { SessionEnd: [{ hooks: [cleanup] }] });
    await hooks.run({ hook_event_name: 'SessionEnd', session_id: 'session', reason: 'exit' }, signal());
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(hooks.run({ ...input, session_id: 'other' }, signal())).rejects.toThrow('identity');
    expect(() => new ClaudeNativeHooks('session', { WorktreeCreate: [{ hooks: [cleanup] }] })).toThrow('cannot preserve');
  });

  it('does not invoke an already-cancelled hook or silently convert a whole-session stop into tool denial', async () => {
    const callback = vi.fn(async () => ({ continue: false, stopReason: 'stop here' }));
    const hooks = new ClaudeNativeHooks('session', { PreToolUse: [{ matcher: '*', hooks: [
      async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }), callback,
    ] }] });
    const controller = new AbortController(); controller.abort();
    await expect(hooks.run(input, controller.signal)).rejects.toThrow('cancelled');
    expect(callback).not.toHaveBeenCalled();
    await expect(hooks.run(input, signal())).rejects.toThrow('session stop unsupported');
    const post = new ClaudeNativeHooks('session', { PostToolUse: [{ hooks: [callback] }] });
    expect(await post.run({ ...input, hook_event_name: 'PostToolUse' }, signal())).toEqual({ preventContinuation: true, stopReason: 'stop here' });
  });
});
