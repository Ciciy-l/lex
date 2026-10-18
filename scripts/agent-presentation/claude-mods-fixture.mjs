/** Opt-in synthetic Mod. No Node APIs; runs inside Claude's hook environment. */
export function register(on) {
  let sessionId;
  let endpoint;
  let token;
  let timer;
  let busy = false;
  let sequence = 0;
  let dropped = 0;
  const pending = [];
  const handled = new Set();
  const emit = (kind, value) => {
    if (pending.length >= 256) { dropped++; return; }
    pending.push({ sequence: ++sequence, sessionId, kind, value });
  };
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    sessionId = await $.session.id();
    endpoint = await $.env.get('LEX_MODS_ENDPOINT');
    token = await $.env.get('LEX_MODS_TOKEN');
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? '') || !token) return result;
    emit('ready', { ...e, sessionId });
    timer?.cancel();
    timer = $.clock.every(50, async () => {
      if (busy) return;
      busy = true;
      const batch = pending.splice(0, 128);
      try {
        const response = await $.http.fetch(endpoint + '/bridge', {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, dropped, events: batch }),
        });
        if (!response.ok) throw new Error('Bridge HTTP ' + response.status);
        const { commands = [] } = JSON.parse(response.text);
        for (const command of commands) {
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          // A queued submission can stay pending until idle. Keep event delivery
          // and cancellation available while that promise is unresolved.
          void (async () => {
            try {
              emit('command-start', { id: command.id, kind: command.kind });
              let result;
              if (command.kind === 'submit') result = await $.prompt.submit({ text: command.text });
              else if (command.kind === 'abort') result = await $.turn.abort({ turnId: command.turnId });
              else if (command.kind === 'snapshot') result = {
                draft: await $.prompt.read(), messages: await $.session.messages(), usage: await $.session.usage(),
              };
              else throw new Error('Unknown fixture command');
              emit('ack', { id: command.id, kind: command.kind, result });
            } catch (error) { emit('command-error', { id: command.id, message: String(error) }); }
          })();
        }
      } catch (error) {
        // Never block generation or replay a possibly delivered command.
        emit('bridge-error', { message: String(error), lostEvents: batch.length });
      } finally { busy = false; }
    });
    return result;
  });
  on('prompt.submit', async ($, e, next) => {
    emit('prompt.submit', e);
    return await next(e);
  });
  on('turn.start', async ($, e, next) => {
    emit('turn.start', e);
    return await next(e);
  });
  on('turn.complete', async ($, e, next) => {
    emit('turn.complete', e);
    return await next(e);
  });
  on('turn.step', async function* ($, e, next) {
    emit('step-start', e);
    const stream = next(e); // Exactly one native model request.
    let done = false;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) {
          done = true;
          emit('step-result', item.value);
          return item.value;
        }
        emit('chunk', { turnId: e.turnId, step: e.index, agentId: e.agentId, chunk: item.value });
        yield item.value; // Including opaque engine chunks, unchanged and in order.
      }
    } finally {
      if (!done) await stream.return();
    }
  });
}
