import type { HookCallback, HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_NATIVE_HOST_HOOKS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'SessionEnd'] as const;
type SupportedEvent = typeof CLAUDE_NATIVE_HOST_HOOKS[number];
export type ClaudeNativeHookResult = {
  allow?: true; ask?: string; deny?: string; updatedInput?: Record<string, unknown>;
  additionalContext?: string[]; preventContinuation?: true; stopReason?: string;
  block?: string; updatedToolOutput?: unknown; updatedMCPToolOutput?: unknown; retry?: true;
};

/** Reuses the adapter's SDK callbacks; no second tool policy or renderer callback. */
export class ClaudeNativeHooks {
  private readonly hooks = new Map<string, Array<{ matches?: RegExp; callbacks: HookCallback[]; timeoutMs: number }>>();

  constructor(private readonly sessionId: string, hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>) {
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!matchers?.some(matcher => matcher.hooks.length)) continue;
      if (!(CLAUDE_NATIVE_HOST_HOOKS as readonly string[]).includes(event)) {
        throw new Error('Native Claude cannot preserve host hook: ' + event);
      }
      this.hooks.set(event, matchers.map(matcher => {
        const timeoutMs = (matcher.timeout ?? 60) * 1000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid native hook timeout');
        return { matches: matcher.matcher && matcher.matcher !== '*' ? new RegExp(matcher.matcher) : undefined,
          callbacks: [...matcher.hooks], timeoutMs };
      }));
    }
  }

  async run(raw: unknown, signal: AbortSignal): Promise<ClaudeNativeHookResult> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid native hook input');
    const input = raw as HookInput;
    if (input.session_id !== this.sessionId || typeof input.hook_event_name !== 'string'
      || !(CLAUDE_NATIVE_HOST_HOOKS as readonly string[]).includes(input.hook_event_name)) {
      throw new Error('Native hook identity mismatch');
    }
    const tool = input as { tool_name?: string; tool_use_id?: string };
    if (input.hook_event_name !== 'SessionEnd' && (typeof tool.tool_name !== 'string' || !tool.tool_name
      || typeof tool.tool_use_id !== 'string' || !tool.tool_use_id)) throw new Error('Native tool identity missing');
    const result: ClaudeNativeHookResult = {};
    for (const matcher of this.hooks.get(input.hook_event_name) ?? []) {
      if (matcher.matches && !matcher.matches.test(tool.tool_name ?? '')) continue;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('Native host hook cancelled'));
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
        timeout = setTimeout(abort, matcher.timeoutMs); timeout.unref();
      });
      void cancelled.catch(() => {});
      try {
        for (const callback of matcher.callbacks) {
          if (controller.signal.aborted) throw new Error('Native host hook cancelled');
          const output = await Promise.race([
            Promise.resolve().then(() => callback(input, tool.tool_use_id, { signal: controller.signal })), cancelled,
          ]);
          mergeOutput(result, output, input.hook_event_name as SupportedEvent);
        }
      } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancel); controller.abort();
      }
    }
    if (result.deny !== undefined) { delete result.ask; delete result.allow; }
    else if (result.ask !== undefined) delete result.allow;
    return result;
  }
}

function mergeOutput(result: ClaudeNativeHookResult, output: HookJSONOutput, event: SupportedEvent): void {
  if ('async' in output || output.systemMessage !== undefined || output.suppressOutput === true) {
    throw new Error('Unsupported native host hook output');
  }
  if (output.continue === false) {
    // Native PreToolUse only admits a tool decision. Converting a session stop
    // to a tool denial would let the model continue and weaken the callback.
    if (event === 'PreToolUse') throw new Error('Native pre-tool session stop unsupported');
    result.preventContinuation = true;
    result.stopReason = output.stopReason ?? 'Host stopped this operation';
  }
  if (output.decision === 'block') {
    result.block = output.reason ?? 'Host blocked this operation';
    if (event === 'PreToolUse') result.deny = result.block;
  }
  const specific = output.hookSpecificOutput;
  if (!specific) return;
  if (specific.hookEventName !== event) throw new Error('Native host hook result mismatch');
  if ('additionalContext' in specific && specific.additionalContext) {
    (result.additionalContext ??= []).push(specific.additionalContext);
  }
  if (specific.hookEventName === 'PreToolUse') {
    if (specific.permissionDecision === 'defer') throw new Error('Native host hook deferral unsupported');
    if (specific.permissionDecision === 'deny') result.deny = specific.permissionDecisionReason ?? 'Host denied this operation';
    else if (specific.permissionDecision === 'ask') result.ask = specific.permissionDecisionReason ?? 'Host confirmation required';
    else if (specific.permissionDecision === 'allow') result.allow = true;
    if (specific.updatedInput) result.updatedInput = specific.updatedInput;
  } else if (specific.hookEventName === 'PostToolUse') {
    if (specific.updatedMCPToolOutput !== undefined) result.updatedMCPToolOutput = specific.updatedMCPToolOutput;
    if ('updatedToolOutput' in specific) result.updatedToolOutput = specific.updatedToolOutput;
  } else if (specific.hookEventName === 'PermissionDenied' && specific.retry) result.retry = true;
  // PreToolUse's public native result is a union, with only one decision.
  if (result.deny !== undefined) { delete result.ask; delete result.allow; }
  else if (result.ask !== undefined) delete result.allow;
}
