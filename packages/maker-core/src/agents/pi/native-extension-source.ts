/** Only Cindy's private UI envelopes use the same task's Host policy in TUI mode.
 * User/package dialogs continue through Pi's original UI unchanged. */
export const PI_NATIVE_HOST_UI_SOURCE = String.raw`
function cindyHostUi(ctx) {
  const host = globalThis[Symbol.for('lex.pi.native.host-ui')];
  const privateRequest = title => ctx.mode === 'tui' && typeof host === 'function' && String(title).startsWith('cindy:');
  return {
    input: (title, placeholder, options) => privateRequest(title)
      ? host({ method: 'input', title, placeholder }, ctx.signal).then(value => value.cancelled ? undefined : value.value)
      : ctx.ui.input(title, placeholder, options),
    confirm: (title, message, options) => privateRequest(title)
      ? host({ method: 'confirm', title, message }, ctx.signal).then(value => value.cancelled ? false : value.confirmed === true)
      : ctx.ui.confirm(title, message, options),
  };
}
`;

/** Loaded by the original interactive Pi 1.2.0; no RPC frontend or terminal parsing. */
export const PI_NATIVE_EXTENSION_SOURCE = String.raw`
export default function (pi) {
  const url = process.env.LEX_PI_BRIDGE_URL, token = process.env.LEX_PI_BRIDGE_TOKEN;
  const generation = process.env.LEX_PI_BRIDGE_GENERATION, sessionId = process.env.LEX_PI_BRIDGE_SESSION;
  if (!url || !token || !generation || !sessionId) throw new Error('Pi task transport is missing');
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const lifetime = new AbortController(), events = [], commands = new Set(), seenRows = new Set();
  const prepared = new Map(), uiRequests = new Set();
  let context, nativeId, modelId, providerId, sequence = 0, requestId = 0, stopped = false, pendingGui, activeRow, compacting = false, awaitingRow = false;
  const emit = (kind, value) => {
    if (events.length >= 256) { fail(); return; }
    events.push({ sequence: ++sequence, kind, value });
  };
  const post = async (route, body, signal = lifetime.signal) => {
    const response = await fetch(url + route, { method: 'POST', headers,
      body: JSON.stringify({ ...body, generation, sessionId }), signal });
    if (!response.ok) throw new Error('Pi task transport refused');
    return response.json();
  };
  const request = async (kind, input, signal) => {
    const id = String(++requestId), combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    try {
      while (!combined.aborted) {
        const answer = await post('/request', { request: { requestId: id, kind, input } }, combined);
        if (answer.pending) continue;
        if (answer.retired || answer.error || !('result' in answer)) throw new Error('Pi task request refused');
        return answer.result;
      }
      throw new Error('Pi task request cancelled');
    } finally { emit('request-retired', { requestId: id }); }
  };
  const fail = (phase = 'transport') => {
    context?.abort();
    if (stopped) return;
    stopped = true; lifetime.abort();
    context?.ui.notify('Lex task connection interrupted. Reopen this task before sending again.', 'error');
    void post('/request', { request: { requestId: String(++requestId), kind: 'native-fault',
      input: { sessionFile: nativeId, phase } } }, AbortSignal.timeout(500)).catch(() => {}).finally(() => context?.shutdown());
  };
  const hostUi = async (event, signal) => {
    const controller = new AbortController(); uiRequests.add(controller);
    try { return await request('host-ui', { sessionFile: nativeId, event },
      AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])); }
    finally { uiRequests.delete(controller); }
  };
  const uiKey = Symbol.for('lex.pi.native.host-ui');
  globalThis[uiKey] = hostUi;
  const result = (command, value) => emit('command-result', { id: command.id, ok: true, result: value });
  const state = () => ({ sessionFile: nativeId, sessionId: context.sessionManager.getSessionId(), model: context.model,
    isStreaming: !context.isIdle(), isCompacting: compacting, pendingMessageCount: context.hasPendingMessages() ? 1 : 0 });
  const runCommand = async command => {
    if (commands.has(command.id)) return;
    commands.add(command.id); if (commands.size > 512) commands.delete(commands.values().next().value);
    try {
      if (stopped || context.sessionManager.getSessionFile() !== nativeId) throw new Error('Pi task changed');
      if (command.kind === 'prompt') {
        if (pendingGui || activeRow || !context.isIdle() || context.hasPendingMessages()) { result(command, { refusedBeforeSubmission: true }); return; }
        const text = command.payload.text;
        // Extension commands do not produce a native user row. Keep their
        // original terminal entry rather than fabricate a GUI input receipt.
        if (text.startsWith('/') && pi.getCommands().some(item => item.source === 'extension' && item.name === text.slice(1).split(/\s/, 1)[0])) {
          result(command, { refusedBeforeSubmission: true }); return;
        }
        pendingGui = { command };
        const images = Array.isArray(command.payload.images) ? command.payload.images : [];
        pi.sendUserMessage(images.length ? [{ type: 'text', text }, ...images] : text, { expandPromptTemplates: true });
      } else if (command.kind === 'control') {
        const payload = command.payload;
        let data;
        switch (payload.type) {
          case 'get_state': data = state(); break;
          case 'get_entries': data = { entries: context.sessionManager.getEntries() }; break;
          case 'get_commands': data = { commands: pi.getCommands() }; break;
          case 'get_available_models': data = { models: context.modelRegistry.getAvailable() }; break;
          case 'set_thinking_level': pi.setThinkingLevel(payload.level); data = { level: pi.getThinkingLevel() }; break;
          case 'set_auto_compaction':
            if (payload.enabled !== true || pi.getSettings().compaction?.enabled === false) throw new Error('Native auto-compaction unavailable');
            data = { enabled: true }; break;
          case 'abort':
            for (const controller of uiRequests) controller.abort();
            context.abort(); data = {}; break;
          case 'set_session_name': pi.setSessionName(payload.name); data = {}; break;
          case 'native_plan': {
            if (activeRow || pendingGui || !context.isIdle() || typeof payload.enabled !== 'boolean'
                || !pi.getCommands().some(item => item.source === 'extension' && item.name === 'plan')) throw new Error('Pi plan mode unavailable');
            const enabled = () => {
              const entries = context.sessionManager.getEntries();
              const entry = entries.findLast(row => row.customType === 'plan-mode');
              return entry ? entry.data?.enabled : false;
            };
            if (enabled() !== payload.enabled) {
              // Execute the original extension command once, then verify its
              // actual persisted state. Never retry a toggle after an unknown result.
              pi.sendUserMessage('/plan', { expandPromptTemplates: true });
              const deadline = Date.now() + 8_000;
              while (!stopped && enabled() !== payload.enabled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
            }
            if (enabled() !== payload.enabled) throw new Error('Pi plan mode outcome unconfirmed');
            data = { enabled: payload.enabled }; break;
          }
          default: result(command, { ok: false }); return;
        }
        result(command, { ok: true, data });
      } else throw new Error('Unknown Pi task command');
    } catch { result(command, { ok: false }); }
  };
  const poll = async () => {
    try {
      while (!stopped) {
        const answer = await post('/exchange', { events: events.slice(0, 32) }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
        if (answer.faulted) throw new Error('Pi task transport faulted');
        while (events.length && events[0].sequence <= answer.acknowledged) events.shift();
        for (const command of answer.commands ?? []) void runCommand(command).catch(() => fail());
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    } catch { if (!stopped) fail(); }
  };
  const fingerprint = message => JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content });
  pi.on('session_start', (_event, ctx) => {
    if (context) { fail(); return; }
    context = ctx; nativeId = ctx.sessionManager.getSessionFile();
    modelId = ctx.model?.id; providerId = ctx.model?.provider;
    if (!nativeId || ctx.mode !== 'tui') { fail(); return; }
    for (const row of ctx.sessionManager.getEntries()) {
      seenRows.add(row.id);
    }
    emit('ready', { sessionFile: nativeId, model: ctx.model?.id, provider: ctx.model?.provider }); void poll();
  });
  for (const name of ['session_before_switch', 'session_before_fork']) pi.on(name, () => ({ cancel: true }));
  pi.on('input', (event, ctx) => {
    if ((pendingGui || activeRow) && event.source === 'interactive') { ctx.ui.setEditorText(event.text); return { action: 'handled' }; }
  });
  pi.on('before_agent_start', () => { awaitingRow = true; });
  pi.on('context', async (event, ctx) => {
    if (stopped || ctx.sessionManager.getSessionFile() !== nativeId) { ctx.abort(); return; }
    // A menu must not silently send under a different product route. Host
    // selections reload this same history with its prepared model/credentials.
    if (ctx.model?.id !== modelId || ctx.model?.provider !== providerId) { fail('runtime-selection'); return; }
    // Match context occurrences to original branch rows in order. Equal text
    // and timestamps are not an identity and never deduplicate two real rows.
    const rows = ctx.sessionManager.getBranch().filter(row => row.type === 'message' && row.message.role === 'user');
    const remaining = rows.slice(), bindings = new Map();
    for (let index = event.messages.length - 1; index >= 0; index--) {
      const message = event.messages[index]; if (message.role !== 'user') continue;
      const match = remaining.findLastIndex(row => fingerprint(row.message) === fingerprint(message));
      if (match >= 0) { bindings.set(index, remaining[match]); remaining.splice(match, 1); }
    }
    const fresh = [...bindings].filter(([, row]) => !seenRows.has(row.id));
    if (awaitingRow && fresh.length !== 1) { fail('journal-unavailable'); return; }
    if (fresh.length) {
      if (fresh.length !== 1 || activeRow) { fail('input-association'); return; }
      // Pi 1.2.0 appends user message_end before provider context. Unlike OMP's
      // context, this hook can bind the actual row without inventing a native ID.
      const [, row] = fresh[0], gui = pendingGui; awaitingRow = false;
      const controller = new AbortController(), timer = setTimeout(() => { ctx.abort(); controller.abort(); }, 8_000);
      try {
        const answer = await request('native-input', { sessionFile: nativeId, row,
          ...(gui ? { commandId: gui.command.id, submittedText: gui.command.payload.text } : {}) },
          AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]));
        if (answer.accepted !== true || stopped) {
          ctx.abort(); seenRows.add(row.id);
          if (gui) { result(gui.command, { refusedBeforeSubmission: true }); pendingGui = undefined; }
          return;
        }
        activeRow = row.id; seenRows.add(row.id);
        if (typeof answer.text === 'string') prepared.set(row.id, [{ type: 'text', text: answer.text }, ...(answer.images ?? [])]);
        if (gui) { result(gui.command, { accepted: true }); pendingGui = undefined; }
      } catch {
        const cancelled = ctx.signal?.aborted === true && !controller.signal.aborted;
        ctx.abort();
        if (cancelled) {
          seenRows.add(row.id);
          if (gui) { result(gui.command, { refusedBeforeSubmission: true }); pendingGui = undefined; }
        } else fail('input-admission');
        return;
      }
      finally { clearTimeout(timer); }
    }
    if (prepared.size) return { messages: event.messages.map((message, index) => {
      const row = bindings.get(index);
      return row && prepared.has(row.id) ? { ...message, content: prepared.get(row.id) } : message;
    }) };
  });
  for (const name of ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end',
      'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'turn_start', 'turn_end',
      'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end']) {
    pi.on(name, (event, ctx) => {
      if (name === 'compaction_start') compacting = true;
      if (name === 'compaction_end') compacting = false;
      if (!stopped) emit('agent-event', { sessionFile: nativeId, event });
      if (name === 'agent_settled') { activeRow = undefined; pendingGui = undefined; }
    });
  }
  pi.on('session_shutdown', () => { stopped = true; lifetime.abort(); if (globalThis[uiKey] === hostUi) delete globalThis[uiKey]; });
}
`;
