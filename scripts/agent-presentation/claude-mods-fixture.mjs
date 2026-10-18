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
  const permissions = new Map();
  let submissions = Promise.resolve();
  let activeSubmission;
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
          // Only one Lex submission may await its native row at a time. This
          // associates UUIDs with command identity, never with prompt text.
          const before = command.kind === 'submit' ? submissions : Promise.resolve();
          let release;
          if (command.kind === 'submit') submissions = new Promise((resolve) => { release = resolve; });
          // A queued submission can stay pending until idle. Keep event delivery
          // and cancellation available while that promise is unresolved.
          void (async () => {
            await before;
            try {
              emit('command-start', { id: command.id, kind: command.kind });
              let result;
              if (command.kind === 'submit') {
                activeSubmission = { id: command.id, bound: false };
                result = await $.prompt.submit({ text: command.text });
              }
              else if (command.kind === 'abort') result = await $.turn.abort({ turnId: command.turnId });
              else if (command.kind === 'snapshot') result = {
                draft: await $.prompt.read(), messages: await $.session.messages(), usage: await $.session.usage(),
              };
              else if (command.kind === 'permission') {
                const resolve = permissions.get(command.requestId);
                if (!resolve) throw new Error('Permission request already settled');
                permissions.delete(command.requestId);
                resolve(command.allow === true ? { behavior: 'allow' }
                  : { behavior: 'deny', message: 'Synthetic GUI denied this write.' });
                result = { delivered: true };
              }
              else throw new Error('Unknown fixture command');
              emit('ack', { id: command.id, kind: command.kind, result });
            } catch (error) { emit('command-error', { id: command.id, message: String(error) }); }
            finally {
              if (command.kind === 'submit') { activeSubmission = undefined; release(); }
            }
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
  on('session.append', async ($, e, next) => {
    const submission = activeSubmission;
    const matches = submission && !submission.bound && !e.agentId
      && e.door === 'prompt' && e.message.type === 'user' && !e.message.isMeta
      && e.origin.kind === 'plugin' && e.origin.name === 'lex-mods-probe';
    if (matches) submission.bound = true;
    const result = await next(e);
    emit('session.append', { ...e, result,
      ...(matches && result.uuid === e.uuid ? { submissionId: submission.id } : {}) });
    return result;
  });
  on('turn.start', async ($, e, next) => {
    emit('turn.start', e);
    return await next(e);
  });
  on('turn.complete', async ($, e, next) => {
    emit('turn.complete', e);
    return await next(e);
  });
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    emit('tool.check', { ...e, result });
    return result;
  });
  on('tool.call', async ($, e, next) => {
    emit('tool.call', e);
    const result = await next(e);
    emit('tool.result', { tool_use_id: e.tool_use_id, result });
    return result;
  });
  on('classic.PermissionRequest', async ($, e, next) => {
    const requestId = sessionId + ':permission:' + (sequence + 1);
    emit('permission', { requestId, input: e });
    const decision = await new Promise((resolve) => {
      const cancel = () => { permissions.delete(requestId); emit('permission-cancelled', { requestId }); resolve(null); };
      if (next.signal.aborted) { cancel(); return; }
      next.signal.addEventListener('abort', cancel, { once: true });
      permissions.set(requestId, (value) => {
        next.signal.removeEventListener('abort', cancel);
        resolve(value);
      });
    });
    return decision ? { decision } : await next(e);
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
