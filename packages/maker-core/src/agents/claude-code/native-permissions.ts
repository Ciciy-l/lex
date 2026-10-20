import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

/** Map an authenticated native callback to the existing product approval policy. */
export async function resolveClaudeNativePermission(
  sessionId: string, raw: unknown, signal: AbortSignal, canUseTool: CanUseTool,
): Promise<PermissionResult> {
  const input = record(raw);
  const args = record(input?.tool_input);
  if (!input || input.session_id !== sessionId || input.hook_event_name !== 'PermissionRequest'
    || typeof input.tool_use_id !== 'string' || !input.tool_use_id
    || typeof input.tool_name !== 'string' || !input.tool_name || !args
    || (input.agent_id !== undefined && (typeof input.agent_id !== 'string' || !input.agent_id))
    || (input.permission_suggestions !== undefined && !Array.isArray(input.permission_suggestions))) {
    throw new Error('Native permission identity is invalid');
  }
  if (signal.aborted) throw new Error('Native permission request retired');
  // The callback must not mutate the native event retained for history/audit.
  const result = await canUseTool(input.tool_name, structuredClone(args), {
    signal, toolUseID: input.tool_use_id,
    ...(input.agent_id ? { agentID: input.agent_id as string } : {}),
    ...(input.permission_suggestions ? { suggestions: structuredClone(input.permission_suggestions) as PermissionUpdate[] } : {}),
  });
  if (signal.aborted) throw new Error('Native permission request retired');
  if (result.behavior !== 'allow' && result.behavior !== 'deny') throw new Error('Invalid host permission decision');
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
