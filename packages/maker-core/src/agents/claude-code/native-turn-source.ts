/** Included literally in the packaged Mod; $ calls must stay in native hooks. */
export const CLAUDE_NATIVE_TURN_START_SOURCE = String.raw`
  on('turn.start', async ($, e, next) => {
    const messageIds = e.agentId === undefined ? pendingUserRows.splice(0) : [];
    if (messageIds.some(id => rejectedInputIds.has(id))) rejectedTurnIds.add(e.turnId);
    for (const id of messageIds) rejectedInputIds.delete(id);
    emit('turn.start', { ...e, messageIds });
    return await next(e);
  });
`;

export const CLAUDE_NATIVE_TURN_ADMISSION_SOURCE = String.raw`
    if (hostTurnAdmission && !e.agentId && e.index === 0) {
      const requestId = String(++requestSequence);
      const state = { retired: false, agentId: e.agentId };
      requests.set(requestId, state);
      const retire = () => {
        if (state.retired) return;
        state.retired = true; requests.delete(requestId); emit('request-retired', { requestId });
      };
      next.signal.addEventListener('abort', retire, { once: true });
      let allowed = false;
      try {
        while (!state.retired && !next.signal.aborted && !overflow && !rejectedTurnIds.has(e.turnId)) {
          const response = await $.http.fetch(endpoint + '/request', {
            method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, generation, request: { requestId, kind: 'turn-admission', input: { turnId: e.turnId } } }),
          });
          if (!response.ok || state.retired || next.signal.aborted) break;
          const data = JSON.parse(response.text);
          if (data.pending === true) continue;
          allowed = !data.retired && !data.error && data.result?.allow === true;
          break;
        }
      } catch { /* Never call the model after a missing host admission. */ }
      finally { next.signal.removeEventListener('abort', retire); retire(); }
      if (!allowed) {
        emit('turn-rejected', { turnId: e.turnId, reason: 'host-admission' });
        try { await $.turn.abort({ turnId: e.turnId }); } catch {}
        // No next(e), therefore no model request or usage. This is an aborted
        // step, not a synthetic successful model response.
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null };
      }
    }
`;
