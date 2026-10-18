/** Packaged source, written only to a host-owned plugin directory at runtime. */
export const CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME = 'lex-native-bridge';

// Keep literal event registrations and direct $ calls: the native Mod compiler
// deliberately rejects indirection through Node helpers or an aliased Engine.
export const CLAUDE_NATIVE_MOD_SOURCE = String.raw`
export function register(on) {
  let endpoint;
  let token;
  let generation;
  let sessionId;
  let timer;
  let exchanging = false;
  let sequence = 0;
  let requestSequence = 0;
  let lastCommand = 0;
  let overflow = false;
  let bytes = 0;
  let submissions = Promise.resolve();
  let activeSubmission;
  const pending = [];
  const requests = new Map();
  const emit = (kind, value) => {
    const event = { sequence: ++sequence, kind, value };
    let size;
    try { size = JSON.stringify(event).length; }
    catch { overflow = true; return; }
    if (overflow || pending.length >= 4096 || bytes + size > 4000000) { overflow = true; return; }
    bytes += size;
    pending.push({ event, size });
  };
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    endpoint = await $.env.get('LEX_CLAUDE_BRIDGE_URL');
    token = await $.env.get('LEX_CLAUDE_BRIDGE_TOKEN');
    generation = await $.env.get('LEX_CLAUDE_BRIDGE_GENERATION');
    sessionId = await $.session.id();
    const expectedSession = await $.env.get('LEX_CLAUDE_BRIDGE_SESSION');
    if (!endpoint?.startsWith('http://127.0.0.1:') || !/^[0-9]+$/.test(endpoint.slice('http://127.0.0.1:'.length))
      || !token || !generation || expectedSession !== sessionId) return result;
    emit('ready', { ...e, sessionId, version: await $.session.version() });
    timer?.cancel();
    timer = $.clock.every(50, async () => {
      if (exchanging) return;
      exchanging = true;
      try {
        const response = await $.http.fetch(endpoint + '/exchange', {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, generation, overflow, events: pending.slice(0, 128).map(x => x.event) }),
        });
        if (!response.ok) return;
        const data = JSON.parse(response.text);
        if (!Number.isSafeInteger(data.acknowledged) || data.acknowledged > sequence) return;
        while (pending.length && pending[0].event.sequence <= data.acknowledged) bytes -= pending.shift().size;
        if (data.faulted) return;
        for (const command of data.commands ?? []) {
          if (!Number.isSafeInteger(command.id) || command.id <= lastCommand) continue;
          // One monotonic command stream; retransmission can never execute twice.
          lastCommand = command.id;
          const before = command.kind === 'submit' ? submissions : Promise.resolve();
          let release;
          if (command.kind === 'submit') submissions = new Promise(resolve => { release = resolve; });
          void (async () => {
            await before;
            try {
              emit('command-start', { id: command.id, kind: command.kind });
              let result;
              const payload = command.payload;
              if (command.kind === 'submit') {
                if (typeof payload.text !== 'string') throw new Error('Invalid text');
                activeSubmission = { id: command.id, bound: false };
                result = await $.prompt.submit({ text: payload.text });
              } else if (command.kind === 'abort') {
                result = await $.turn.abort({ turnId: payload.turnId });
              } else if (command.kind === 'snapshot') {
                result = { draft: await $.prompt.read(), usage: await $.session.usage(), model: await $.session.model() };
              } else if (command.kind === 'compact') {
                result = await $.session.compact(payload);
              } else if (command.kind === 'config') {
                result = await $.config.set(payload);
              } else if (command.kind === 'command') {
                result = await $.command.run(payload);
              } else throw new Error('Unsupported bridge command');
              emit('command-result', { id: command.id, ok: true, result });
            } catch { emit('command-result', { id: command.id, ok: false }); }
            finally { if (command.kind === 'submit') { activeSubmission = undefined; release(); } }
          })();
        }
      } catch { /* Retain unacknowledged events; a disconnected GUI must not stall the native stream. */ }
      finally { exchanging = false; }
    });
    return result;
  });
  on('prompt.submit', async ($, e, next) => {
    emit('prompt.submit', e);
    return await next(e);
  });
  on('session.append', async ($, e, next) => {
    const submission = activeSubmission;
    const matches = submission && !submission.bound && !e.agentId && e.door === 'prompt'
      && e.message.type === 'user' && !e.message.isMeta
      && e.origin.kind === 'plugin' && e.origin.name === 'lex-native-bridge';
    if (matches) submission.bound = true;
    const result = await next(e);
    emit('session.append', { ...e, result, ...(matches && result.uuid === e.uuid ? { submissionId: submission.id } : {}) });
    return result;
  });
  on('turn.start', async ($, e, next) => { emit('turn.start', e); return await next(e); });
  on('turn.complete', async ($, e, next) => {
    for (const [id, request] of requests) {
      if (request.agentId !== e.agentId) continue;
      request.retired = true; requests.delete(id);
      emit('request-retired', { requestId: id });
    }
    emit('turn.complete', e);
    return await next(e);
  });
  on('tool.call', async ($, e, next) => {
    emit('tool.call', e);
    const result = await next(e);
    emit('tool.result', { tool_use_id: e.tool_use_id, agentId: e.agentId, result });
    return result;
  });
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    emit('tool.check', { ...e, result });
    return result;
  });
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!endpoint || !token || overflow) return await next(e);
    const requestId = String(++requestSequence);
    const state = { agentId: e.agent_id, retired: false };
    requests.set(requestId, state);
    const retire = () => {
      if (state.retired) return;
      state.retired = true; requests.delete(requestId); emit('request-retired', { requestId });
    };
    next.signal.addEventListener('abort', retire, { once: true });
    emit('permission', { requestId, input: e });
    try {
      while (!state.retired && !next.signal.aborted) {
        // Host API waits do not consume HookBudget. A raw human-wait Promise does.
        const response = await $.http.fetch(endpoint + '/request', {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, generation, request: { requestId, kind: 'permission', input: e } }),
        });
        if (!response.ok || state.retired || next.signal.aborted) break;
        const data = JSON.parse(response.text);
        if (data.pending === true) continue;
        if (data.retired || data.error) break;
        if (data.result?.behavior === 'allow' || data.result?.behavior === 'deny') return { decision: data.result };
        break;
      }
      return await next(e);
    } finally { next.signal.removeEventListener('abort', retire); retire(); }
  });
  on('turn.step', async function* ($, e, next) {
    emit('step-start', e);
    const stream = next(e);
    let done = false;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) { done = true; emit('step-result', { ...item.value, agentId: e.agentId }); return item.value; }
        emit('chunk', { turnId: e.turnId, step: e.index, agentId: e.agentId, chunk: item.value });
        yield item.value;
      }
    } finally { if (!done) await stream.return(); }
  });
}
`;
