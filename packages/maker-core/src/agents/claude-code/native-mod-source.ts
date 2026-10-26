import { CLAUDE_NATIVE_HOST_HOOK_SOURCE } from './native-hook-source.js';
import { CLAUDE_NATIVE_INPUT_PREPARATION_SOURCE } from './native-input-source.js';
import { CLAUDE_NATIVE_TURN_ADMISSION_SOURCE, CLAUDE_NATIVE_TURN_START_SOURCE } from './native-turn-source.js';

/** Packaged source, written only to a host-owned plugin directory at runtime. */
export const CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME = 'lex-native-bridge';
export const CLAUDE_NATIVE_MEDIA_COMMAND = 'send';
export const CLAUDE_NATIVE_MEDIA_PROMPT = [
  '---', 'description: Deliver attachments from the Lex task composer',
  'disable-model-invocation: true', '---', '$ARGUMENTS', '',
].join(String.fromCharCode(10));

// Keep literal event registrations and direct $ calls: the native Mod compiler
// deliberately rejects indirection through Node helpers or an aliased Engine.
export const CLAUDE_NATIVE_MOD_SOURCE = String.raw`
export function register(on) {
  let endpoint;
  let token;
  let generation;
  let sessionId;
  let hostHooksEnabled = false;
  let hostTurnAdmission = false;
  let hostInputPreparation = false;
  const rejectedInputIds = new Set();
  const rejectedTurnIds = new Set();
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
  const toolScopes = new Map();
  const permissionScopes = new Map();
  const stepScopes = new Map();
  const pendingUserRows = [];
  const emit = (kind, value) => {
    if (kind === 'session.append') {
      const step = stepScopes.get(value.agentId);
      if (step) value = { ...value, nativeTurnId: step.turnId, nativeStep: step.index };
    }
    if (hostTurnAdmission && kind === 'session.append' && !value.agentId
      && (value.door === 'prompt' || value.door === 'command')
      && value.result?.uuid === value.uuid && value.result?.message?.type === 'user'
      && !value.result.message.isMeta) {
      if (pendingUserRows.length >= 128) overflow = true;
      else pendingUserRows.push(value.uuid);
    }
    const event = { sequence: ++sequence, kind, value };
    let size;
    try { size = JSON.stringify(event).length; }
    catch { overflow = true; return; }
    if (overflow || pending.length >= 4096 || bytes + size > 4000000) { overflow = true; return; }
    bytes += size;
    pending.push({ event, size });
  };
  on('session.start', async ($, e, next) => {
    hostHooksEnabled = (await $.env.get('LEX_CLAUDE_BRIDGE_HOST_HOOKS')) === '1';
    hostTurnAdmission = (await $.env.get('LEX_CLAUDE_BRIDGE_TURN_ADMISSION')) === '1';
    hostInputPreparation = (await $.env.get('LEX_CLAUDE_BRIDGE_INPUT_PREPARATION')) === '1';
    const result = await next(e);
    endpoint = await $.env.get('LEX_CLAUDE_BRIDGE_URL');
    token = await $.env.get('LEX_CLAUDE_BRIDGE_TOKEN');
    generation = await $.env.get('LEX_CLAUDE_BRIDGE_GENERATION');
    sessionId = await $.session.id();
    const expectedSession = await $.env.get('LEX_CLAUDE_BRIDGE_SESSION');
    if (!endpoint?.startsWith('http://127.0.0.1:') || !/^[0-9]+$/.test(endpoint.slice('http://127.0.0.1:'.length))
      || !token || !generation || expectedSession !== sessionId) return result;
    emit('ready', { ...e, sessionId, hostHooksEnabled, hostTurnAdmission, hostInputPreparation, version: await $.session.version() });
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
                if (payload.imagePaths !== undefined) {
                  if (!Array.isArray(payload.imagePaths) || payload.imagePaths.length < 1 || payload.imagePaths.length > 20
                    || payload.imagePaths.some(path => typeof path !== 'string' || !path || path.length > 4096
                      || [...path].some(char => char.charCodeAt(0) < 32 || char === '"' || char.charCodeAt(0) === 96))) throw new Error('Invalid media paths');
                  const marker = 'LEX_SUBMISSION_' + generation + '_' + command.id;
                  const args = marker + ' ' + payload.imagePaths.map(path => '@' + JSON.stringify(path.split(String.fromCharCode(92)).join('/'))).join(' ');
                  activeSubmission = { id: command.id, bound: false, media: true, marker, text: payload.text, release };
                  // command.run acknowledges enqueueing before the native row exists.
                  // Keep this serialized submission until its authenticated meta row.
                  await $.command.run({ command: 'lex-native-bridge:send', args });
                  return;
                }
                activeSubmission = { id: command.id, bound: false, release };
                result = await $.prompt.submit({ text: payload.text });
              } else if (command.kind === 'abort') {
                result = await $.turn.abort({ turnId: payload.turnId });
              } else if (command.kind === 'snapshot') {
                result = { sessionId: await $.session.id(), cwd: await $.session.cwd(),
                  draft: await $.prompt.read(), usage: await $.session.usage(), model: await $.session.model() };
              } else if (command.kind === 'restore-draft') {
                if (typeof payload.text !== 'string' || payload.text.length > 1000000) throw new Error('Invalid draft');
                const filled = await $.prompt.fill({ text: payload.text, mode: 'replace' });
                const draft = await $.prompt.read();
                if (filled.isFilled !== true || draft.text !== payload.text) throw new Error('Native draft was not restored');
                result = { draft };
              } else if (command.kind === 'tool-list') {
                result = await $.tool.list();
              } else if (command.kind === 'context-usage') {
                result = await $.session.usage({ breakdown: 'full' });
              } else if (command.kind === 'compact') {
                result = await $.session.compact(payload);
                // Calls made through $ skip this plugin's own hook.
                if (Array.isArray(result.messages) && typeof result.skip !== 'string') emit('session.compacted', { trigger: 'plugin',
                  tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter });
              } else if (command.kind === 'config') {
                result = await $.config.set(payload);
              } else if (command.kind === 'config-list') {
                result = await $.config.list();
              } else if (command.kind === 'command') {
                result = await $.command.run(payload);
              } else throw new Error('Unsupported bridge command');
              emit('command-result', { id: command.id, ok: true, result });
            } catch {
              if (activeSubmission?.id === command.id) activeSubmission = undefined;
              release?.(); emit('command-result', { id: command.id, ok: false });
            }
            finally {
              if (command.kind === 'submit' && !activeSubmission?.media) {
                if (activeSubmission?.id === command.id) activeSubmission = undefined;
                release();
              }
            }
          })();
        }
      } catch { /* Retain unacknowledged events; a disconnected GUI must not stall the native stream. */ }
      finally { exchanging = false; }
    });
    return result;
  });
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    // Precompute prepares a candidate; only a committed root compaction changes
    // the product context. A veto/error must leave its prior snapshot intact.
    if (!e.agentId && e.trigger !== 'precompute' && Array.isArray(result.messages) && typeof result.skip !== 'string') {
      emit('session.compacted', { trigger: e.trigger,
        tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter });
    }
    return result;
  });
  on('prompt.submit', async ($, e, next) => {
    emit('prompt.submit', e);
    return await next(e);
  });
  on('session.append', async ($, e, next) => {
    const submission = activeSubmission;
    if (submission?.media && !e.agentId && e.origin.kind === 'plugin' && e.origin.name === 'lex-native-bridge'
      && e.message.type === 'user' && e.message.content?.some(block => block.type === 'text' && block.text.includes(submission.marker))) {
      if (e.door === 'command' && !e.message.isMeta && !submission.commandUuid) {
        const result = await next(e);
        if (result.uuid === e.uuid) submission.commandUuid = e.uuid;
        emit('session.append', { ...e, result, ...(submission.commandUuid ? { submissionId: submission.id, submissionKind: 'media' } : {}) });
        return result;
      }
      if (e.door === 'prompt' && e.message.isMeta && submission.commandUuid && !submission.bound) {
        submission.bound = true;
        // Expand only the owned attachment paths. User text bypasses slash-command
        // interpolation, preserving literal shell/mention syntax and exact bytes.
        const projected = { ...e, message: { ...e.message, content: [
          { type: 'text', text: submission.text }, ...e.message.content.filter(block => block.type !== 'text'),
        ] } };
        try {
          const result = await next(projected);
          emit('session.append', { ...projected, result, submissionId: submission.id, submissionKind: 'media', commandMessageId: submission.commandUuid });
          emit('command-result', { id: submission.id, ok: result.uuid === e.uuid, result: { uuid: submission.commandUuid } });
          return result;
        } catch (error) { emit('command-result', { id: submission.id, ok: false }); throw error; }
        finally { if (activeSubmission === submission) activeSubmission = undefined; submission.release(); }
      }
    }
    const matches = submission && !submission.bound && !e.agentId && e.door === 'prompt'
      && !submission.media
      && e.message.type === 'user' && !e.message.isMeta
      && e.origin.kind === 'plugin' && e.origin.name === 'lex-native-bridge';
    if (matches) submission.bound = true;
${CLAUDE_NATIVE_INPUT_PREPARATION_SOURCE}
    const result = await next(e);
    emit('session.append', { ...e, result, ...(matches && result.uuid === e.uuid ? { submissionId: submission.id } : {}) });
    return result;
  });
${CLAUDE_NATIVE_TURN_START_SOURCE}
  on('turn.complete', async ($, e, next) => {
    rejectedTurnIds.delete(e.turnId);
    for (const [id, request] of requests) {
      if (request.agentId !== e.agentId) continue;
      request.retired = true; requests.delete(id);
      emit('request-retired', { requestId: id });
    }
    // Plain usage reads the native status-line counters; it never calls the
    // provider's token-count API. Failure must not erase a real terminal event.
    let sessionUsage;
    if (e.agentId === undefined) {
      try { sessionUsage = await $.session.usage(); } catch { /* Optional native counters. */ }
    }
    emit('turn.complete', { ...e, ...(sessionUsage ? { sessionUsage } : {}) });
    return await next(e);
  });
  on('tool.call', async ($, e, next) => {
    emit('tool.call', e);
    const scope = { toolUseId: e.tool_use_id, agentId: e.agentId, tool: e.tool };
    toolScopes.set(e.tool_use_id, scope);
    try {
      const result = await next(e);
      emit('tool.result', { tool_use_id: e.tool_use_id, agentId: e.agentId, result });
      return result;
    } finally {
      if (permissionScopes.get(e.agentId) === scope) permissionScopes.delete(e.agentId);
      if (toolScopes.get(e.tool_use_id) === scope) toolScopes.delete(e.tool_use_id);
      // A terminal answer does not abort classic.PermissionRequest. Retire the
      // GUI callback at this exact tool boundary, not at a later turn.complete.
      for (const [id, request] of requests) {
        if (request.toolUseId !== e.tool_use_id || request.agentId !== e.agentId) continue;
        request.retired = true; requests.delete(id);
        emit('request-retired', { requestId: id });
      }
    }
  });
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    emit('tool.check', { ...e, result });
    const scope = toolScopes.get(e.tool_use_id);
    if (endpoint && token && !overflow && result.decision === 'ask' && scope) {
      // The classic hook lacks tool_use_id. Serialize only entry into that
      // hook so it consumes one causal native scope; names/arguments never
      // choose between concurrent calls. Queries have no native tool scope.
      while (permissionScopes.has(scope.agentId) && permissionScopes.get(scope.agentId) !== scope && !next.signal.aborted) {
        await $.clock.sleep(10, { signal: next.signal });
      }
      if (!next.signal.aborted && toolScopes.get(e.tool_use_id) === scope) {
        permissionScopes.set(scope.agentId, scope);
      }
    }
    return result;
  });
${CLAUDE_NATIVE_HOST_HOOK_SOURCE}
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!endpoint || !token || overflow) return await next(e);
    const scope = permissionScopes.get(e.agent_id);
    if (!scope || toolScopes.get(scope.toolUseId) !== scope || scope.tool !== e.tool_name) {
      // Never guess an identity for a hook not raised by an observed native
      // call. Preserve the original decision path without inventing a GUI card.
      return await next(e);
    }
    permissionScopes.delete(e.agent_id);
    const input = { ...e, tool_use_id: scope.toolUseId };
    const requestId = String(++requestSequence);
    const state = { agentId: e.agent_id, toolUseId: scope.toolUseId, retired: false };
    requests.set(requestId, state);
    const retire = () => {
      if (state.retired) return;
      state.retired = true; requests.delete(requestId); emit('request-retired', { requestId });
    };
    next.signal.addEventListener('abort', retire, { once: true });
    emit('permission', { requestId, input });
    try {
      while (!state.retired && !next.signal.aborted) {
        // Host API waits do not consume HookBudget. A raw human-wait Promise does.
        const response = await $.http.fetch(endpoint + '/request', {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, generation, request: { requestId, kind: 'permission', input } }),
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
${CLAUDE_NATIVE_TURN_ADMISSION_SOURCE}
    emit('step-start', e);
    stepScopes.set(e.agentId, e);
    const stream = next(e);
    let done = false;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) { done = true; emit('step-result', { ...item.value, agentId: e.agentId }); return item.value; }
        emit('chunk', { turnId: e.turnId, step: e.index, agentId: e.agentId, chunk: item.value });
        yield item.value;
      }
    } finally {
      if (stepScopes.get(e.agentId) === e) stepScopes.delete(e.agentId);
      if (!done) await stream.return();
    }
  });
}
`;
