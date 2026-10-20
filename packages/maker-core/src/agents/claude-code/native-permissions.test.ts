import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeNativePermission } from './native-permissions.js';

const request = { session_id: 'session', hook_event_name: 'PermissionRequest', tool_use_id: 'native-tool',
  tool_name: 'Write', tool_input: { file_path: '/fixture', content: 'original' }, agent_id: 'child',
  permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };

describe('Claude native product permission mapping', () => {
  it('reuses exact tool/subagent identity, decision and cancellation without mutating the source', async () => {
    const signal = new AbortController().signal;
    const decision: PermissionResult = { behavior: 'deny', message: 'existing product policy', interrupt: true };
    const policy = vi.fn<CanUseTool>(async (_tool, input, options) => {
      expect(options).toEqual({ signal, toolUseID: 'native-tool', agentID: 'child', suggestions: request.permission_suggestions });
      input.content = 'changed';
      return decision;
    });
    expect(await resolveClaudeNativePermission('session', request, signal, policy)).toBe(decision);
    expect(request.tool_input.content).toBe('original');
  });

  it.each([
    { session_id: 'other' }, { tool_use_id: undefined }, { tool_input: [] },
    { agent_id: '' }, { hook_event_name: 'PreToolUse' }, { permission_suggestions: {} },
  ])('refuses an invalid callback before asking the user: %j', async changed => {
    const policy = vi.fn<CanUseTool>();
    await expect(resolveClaudeNativePermission('session', { ...request, ...changed }, new AbortController().signal, policy)).rejects.toThrow('identity');
    expect(policy).not.toHaveBeenCalled();
  });

  it('cannot return a late permission result after the original tool has settled', async () => {
    const controller = new AbortController();
    let finish!: (decision: PermissionResult) => void;
    const policy = vi.fn<CanUseTool>(() => new Promise(resolve => { finish = resolve; }));
    const pending = resolveClaudeNativePermission('session', request, controller.signal, policy);
    controller.abort();
    finish({ behavior: 'allow', updatedInput: request.tool_input });
    await expect(pending).rejects.toThrow('retired');
    await expect(resolveClaudeNativePermission('session', request, controller.signal, policy)).rejects.toThrow('retired');
    expect(policy).toHaveBeenCalledOnce();
  });
});
