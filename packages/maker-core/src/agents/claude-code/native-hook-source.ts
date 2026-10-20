/** Literal registration generator; the native compiler receives direct $ calls. */
const PRE_INPUT = String.raw`const scope = toolScopes.get(e.tool_use_id);
      if (!scope) return unavailable;
      const { tool, tool_use_id, agentId, consent, ...arguments_ } = e;
      const input = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd: await $.session.cwd(),
        tool_name: tool, tool_use_id, tool_input: native.updatedInput ?? arguments_,
        ...(scope.agentId ? { agent_id: scope.agentId } : {}) };`;
const COMBINE_PRE = "// A refusal at either boundary cannot be weakened by the other.\n        if (native.deny !== undefined || hosted.deny !== undefined) {\n          merged.deny = native.deny ?? hosted.deny; delete merged.allow; delete merged.ask;\n        } else if (native.ask !== undefined || hosted.ask !== undefined) {\n          merged.ask = native.ask ?? hosted.ask; delete merged.allow;\n        }\n        delete merged.preventContinuation; delete merged.stopReason; delete merged.block;";
const TEMPLATE = String.raw`
  on('classic.EVENT', async ($, e, next) => {
    try {
    const native = await next(e);
    if (!hostHooksEnabled) return native;
    EARLY_DENIAL
    const unavailable = UNAVAILABLE;
    if (!endpoint || !token || overflow) return unavailable;
    INPUT
    const requestId = String(++requestSequence);
    const state = { agentId: input.agent_id, retired: false };
    requests.set(requestId, state);
    const retire = () => {
      if (state.retired) return;
      state.retired = true; requests.delete(requestId); emit('request-retired', { requestId });
    };
    next.signal.addEventListener('abort', retire, { once: true });
    try {
      while (!state.retired && !next.signal.aborted) {
        const response = await $.http.fetch(endpoint + '/request', {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, generation, request: { requestId, kind: 'hook', input } }),
        });
        if (!response.ok || state.retired || next.signal.aborted) return unavailable;
        const data = JSON.parse(response.text);
        if (data.pending === true) continue;
        if (data.retired || data.error || !data.result || typeof data.result !== 'object') return unavailable;
        const hosted = data.result;
        const merged = { ...native, ...hosted };
        if (native.additionalContext || hosted.additionalContext) merged.additionalContext = [...(native.additionalContext ?? []), ...(hosted.additionalContext ?? [])];
        COMBINE
        return merged;
      }
      return unavailable;
    } catch { return unavailable; }
    finally { next.signal.removeEventListener('abort', retire); retire(); }
    } catch { return OUTER_FAILURE; }
  });`;

export const CLAUDE_NATIVE_HOST_HOOK_SOURCE = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'SessionEnd'].map(event => {
  const pre = event === 'PreToolUse';
  return TEMPLATE.replace('EVENT', event)
    .replace('EARLY_DENIAL', pre ? 'if (native.deny !== undefined) return native;' : '')
    .replace('UNAVAILABLE', pre ? "{ deny: 'Lex host tool policy is unavailable' }" : "{ ...native, preventContinuation: true, stopReason: 'Lex host tool policy is unavailable' }")
    .replace('OUTER_FAILURE', pre ? "{ deny: 'Lex host tool policy failed' }" : "{ preventContinuation: true, stopReason: 'Lex host tool policy failed' }")
    .replace('INPUT', pre ? PRE_INPUT : 'const input = e;')
    .replace('COMBINE', pre ? COMBINE_PRE : '');
}).join('\n');
