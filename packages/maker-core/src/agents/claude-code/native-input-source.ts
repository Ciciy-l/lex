/** Runs before native append, while the official hook can still rewrite content. */
export const CLAUDE_NATIVE_INPUT_PREPARATION_SOURCE = String.raw`
    if (hostInputPreparation && !matches && !e.agentId && e.door === 'prompt'
      && e.message.type === 'user' && !e.message.isMeta) {
      const requestId = String(++requestSequence);
      const state = { retired: false, agentId: e.agentId };
      requests.set(requestId, state);
      const retire = () => {
        if (state.retired) return;
        state.retired = true; requests.delete(requestId); emit('request-retired', { requestId });
      };
      next.signal.addEventListener('abort', retire, { once: true });
      let prepared;
      try {
        while (!state.retired && !next.signal.aborted && !overflow) {
          const response = await $.http.fetch(endpoint + '/request', {
            method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, generation, request: { requestId, kind: 'input-preparation', input: e } }),
          });
          if (!response.ok || state.retired || next.signal.aborted) break;
          const data = JSON.parse(response.text);
          if (data.pending === true) continue;
          if (!data.retired && !data.error && data.result?.allow === true && Array.isArray(data.result.content)) prepared = data.result.content;
          break;
        }
      } catch { /* Never retain refused input in a later provider request. */ }
      try {
        if (!prepared) {
          rejectedInputIds.add(e.uuid);
          // Native cannot deny a composer row, but it can rewrite text and
          // remove images/documents. Keep only a neutral receipt. Otherwise
          // the next permitted GUI turn would send the refused input anyway.
          if (e.message.content.some(block => !['text', 'image', 'document'].includes(block.type))) overflow = true;
        }
        const content = prepared ?? [{ type: 'text', text: '[Input was not submitted by Lex.]' }];
        const input = { ...e, message: { ...e.message, content } };
        const result = await next(input);
        if (!prepared && JSON.stringify(result.message?.content) !== JSON.stringify(content)) overflow = true;
        emit('session.append', { ...input, result });
        return result;
      } finally { next.signal.removeEventListener('abort', retire); retire(); }
    }
`;
