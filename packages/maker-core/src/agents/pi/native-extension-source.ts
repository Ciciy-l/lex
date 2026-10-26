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
import { Text } from '@earendil-works/pi-tui';
export default function (pi) {
  const url = process.env.LEX_PI_BRIDGE_URL, token = process.env.LEX_PI_BRIDGE_TOKEN;
  const generation = process.env.LEX_PI_BRIDGE_GENERATION, sessionId = process.env.LEX_PI_BRIDGE_SESSION;
  if (!url || !token || !generation || !sessionId) throw new Error('Pi task transport is missing');
  for (const [kind, label] of [['lex-gui-append', 'GUI'], ['lex-orca-body', 'Orca']]) {
    pi.registerMessageRenderer(kind, (message, _options, theme) => {
      // Keep the native image renderer for non-text content; a label must not
      // turn an attached image into an empty message in the original TUI.
      if (Array.isArray(message.content) && message.content.some(part => part.type !== 'text')) return undefined;
      const body = typeof message.content === 'string' ? message.content : message.content
        .filter(part => part.type === 'text').map(part => part.text).join('\n');
      return new Text(theme.fg('muted', label) + '\n' + body, 0, 0);
    });
  }
  const replacementKey = Symbol.for('lex.pi.native.history-replacement');
  const replacing = globalThis[replacementKey];
  if (replacing?.generation === generation && replacing?.sessionId === sessionId) {
    // withSession supplies the fresh context to the old host transaction. This
    // temporary replacement remains frozen until its exact process is retired;
    // the next original frontend opens the durably checkpointed target file.
    pi.on('input', (event, ctx) => { ctx.ui.setEditorText(event.text); return { action: 'handled' }; });
    pi.on('context', (_event, ctx) => { ctx.abort(); });
    pi.on('before_provider_request', (_event, ctx) => { ctx.abort(); return { headers: {} }; });
    for (const name of ['session_before_switch', 'session_before_fork', 'session_before_tree']) pi.on(name, () => ({ cancel: true }));
    return;
  }
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const lifetime = new AbortController(), events = [], commands = new Set(), seenRows = new Set();
  const prepared = new Map(), uiRequests = new Set();
  let treeCommand;
  let context, nativeId, modelId, providerId, sequence = 0, requestId = 0, stopped = false, retiring = false, pendingGui, pendingNative = false, activeRow, compacting = false, awaitingRow = false;
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
  pi.registerCommand('lex-native-tree-handoff', { description: 'Managed task history handoff', handler: async (args, ctx) => {
    const command = treeCommand;
    if (!command || String(command.id) !== args || command.started) return;
    command.started = true;
    const editor = ctx.ui.getEditorText();
    try {
      if (stopped || retiring || activeRow || pendingGui || pendingNative || !ctx.isIdle() || ctx.hasPendingMessages()
        || ctx.sessionManager.getSessionFile() !== nativeId || command.payload.summarize === true) throw new Error('Native tree is not idle');
      if (command.payload.type === 'fork_history') {
        const cwd = ctx.cwd;
        globalThis[replacementKey] = { generation, sessionId };
        let replacement;
        try {
          const answer = await ctx.fork(command.payload.entryId, { position: 'at', withSession: async next => {
            // Pi invalidates every getter on the old command context at fork.
            // Only the replacement context and pre-mutation values remain valid.
            context = next;
            if (!next.isIdle() || next.hasPendingMessages() || next.model?.id !== modelId || next.model?.provider !== providerId
              || next.cwd !== cwd) throw new Error('Pi replacement route changed');
            next.ui.setEditorText(editor);
            replacement = { sessionFile: next.sessionManager.getSessionFile(), model: next.model, cwd: next.cwd,
              tree: next.sessionManager.getTree(), leafId: next.sessionManager.getLeafId(), draft: next.ui.getEditorText() };
          } });
          if (answer.cancelled) {
            delete globalThis[replacementKey];
            result(command, { ok: true, data: { cancelled: true, sessionFile: nativeId } });
          } else {
            if (!replacement || replacement.draft !== editor) throw new Error('Pi withSession readback missing');
            retiring = true; result(command, { ok: true, data: replacement });
          }
        } catch { retiring = true; result(command, { ok: false }); }
        return;
      }
      const answer = await ctx.navigateTree(command.payload.entryId, { summarize: false });
      if (ctx.sessionManager.getSessionFile() !== nativeId) throw new Error('Native tree identity changed');
      for (const row of ctx.sessionManager.getEntries()) seenRows.add(row.id);
      prepared.clear();
      result(command, { ok: true, data: { cancelled: answer.cancelled === true } });
    } catch { result(command, { ok: false }); }
    finally { if (!globalThis[replacementKey]) ctx.ui.setEditorText(editor); if (treeCommand === command) treeCommand = undefined; }
  } });
  const runCommand = async command => {
    if (commands.has(command.id)) return;
    commands.add(command.id); if (commands.size > 512) commands.delete(commands.values().next().value);
    try {
      if (stopped || retiring || context.sessionManager.getSessionFile() !== nativeId) throw new Error('Pi task changed');
      if (command.kind === 'prompt' || command.kind === 'steer') {
        const steering = command.kind === 'steer';
        if (treeCommand || pendingGui || pendingNative || context.hasPendingMessages()
            || (steering ? !activeRow || context.isIdle() || command.payload.turnRowId !== activeRow : activeRow || !context.isIdle())) {
          result(command, { refusedBeforeSubmission: true }); return;
        }
        const text = command.payload.text;
        // Extension commands do not produce a native user row. Keep their
        // original terminal entry rather than fabricate a GUI input receipt.
        const guiBody = typeof command.payload.submissionId === 'string' && command.payload.submissionId.length > 0;
        if (!guiBody) {
          result(command, { refusedBeforeSubmission: true }); return;
        }
        if (steering && command.payload.delegated === true) {
          result(command, { refusedBeforeSubmission: true }); return;
        }
        pendingGui = { command };
        const images = Array.isArray(command.payload.images) ? command.payload.images : [];
        const content = images.length ? [{ type: 'text', text }, ...images] : text;
        if (guiBody) pi.sendMessage({ customType: command.payload.delegated === true ? 'lex-orca-body' : 'lex-gui-append', content, display: true,
          details: { submissionId: command.payload.submissionId } }, steering ? { deliverAs: 'steer' } : { triggerTurn: true });
      } else if (command.kind === 'control') {
        const payload = command.payload;
        let data;
        switch (payload.type) {
          case 'get_state': data = state(); break;
          case 'get_session_stats': data = { contextUsage: context.getContextUsage() }; break;
          case 'editor_draft': data = { text: context.ui.getEditorText() }; break;
          case 'restore_editor_draft':
            if (activeRow || pendingGui || pendingNative || treeCommand || !context.isIdle() || context.hasPendingMessages()
              || typeof payload.text !== 'string' || payload.text.length > 1_000_000) throw new Error('Native draft is not idle');
            context.ui.setEditorText(payload.text); data = { text: context.ui.getEditorText() };
            if (data.text !== payload.text) throw new Error('Native draft readback changed');
            break;
          case 'fork_history':
          case 'navigate_tree':
            if (treeCommand || activeRow || pendingGui || pendingNative || !context.isIdle() || context.hasPendingMessages()
              || typeof payload.entryId !== 'string' || payload.summarize === true) throw new Error('Native tree is not idle');
            treeCommand = { ...command, started: false };
            pi.sendUserMessage('/lex-native-tree-handoff ' + command.id, { expandPromptTemplates: true });
            return;
          case 'get_entries': data = { entries: context.sessionManager.getEntries() }; break;
          case 'get_tree': data = { tree: context.sessionManager.getTree(), leafId: context.sessionManager.getLeafId(),
            sessionId: context.sessionManager.getSessionId(), sessionFile: context.sessionManager.getSessionFile() }; break;
          case 'get_commands': data = { commands: pi.getCommands() }; break;
          case 'get_host_tools': {
            const all = pi.getAllTools(), active = new Set(pi.getActiveTools());
            data = { tools: ['cindy_mcp_list_tools', 'cindy_mcp_call_tool'].filter(name =>
              active.has(name) && all.some(tool => tool.name === name)) };
            break;
          }
          case 'get_available_models': data = { models: context.modelRegistry.getAvailable() }; break;
          case 'set_thinking_level': pi.setThinkingLevel(payload.level); data = { level: pi.getThinkingLevel() }; break;
          case 'set_auto_compaction':
            if (payload.enabled !== true || pi.getSettings().compaction?.enabled === false) throw new Error('Native auto-compaction unavailable');
            data = { enabled: true }; break;
          case 'abort':
            // Abort alone retains Pi's queued inputs. Fence this executor's
            // context first; Host must confirm exit before allowing a retry.
            if (pendingGui || pendingNative) retiring = true;
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
  pi.on('session_before_switch', () => ({ cancel: true }));
  pi.on('session_before_fork', () => ({ cancel: treeCommand?.payload.type !== 'fork_history' || !treeCommand.started }));
  pi.on('session_before_tree', () => ({ cancel: !treeCommand?.started }));
  pi.on('input', (event, ctx) => {
    if (event.source !== 'interactive') return;
    if (retiring || treeCommand || pendingGui || pendingNative) { ctx.ui.setEditorText(event.text); return { action: 'handled' }; }
    // One native edit may wait for a real row. Do not let another editor submit
    // become indistinguishable from it while Host admission is in progress.
    if (activeRow) pendingNative = true;
  });
  pi.on('before_agent_start', () => { awaitingRow = true; });
  pi.on('context', async (event, ctx) => {
    if (stopped || retiring || ctx.sessionManager.getSessionFile() !== nativeId) { ctx.abort(); return; }
    // A menu must not silently send under a different product route. Host
    // selections reload this same history with its prepared model/credentials.
    if (ctx.model?.id !== modelId || ctx.model?.provider !== providerId) { fail('runtime-selection'); return; }
    // Match context occurrences to original branch rows in order. Equal text
    // and timestamps are not an identity and never deduplicate two real rows.
    const rows = ctx.sessionManager.getBranch().filter(row => (row.type === 'message' && row.message.role === 'user')
      || (row.type === 'custom_message' && ['lex-gui-append', 'lex-orca-body'].includes(row.customType)));
    const remaining = rows.slice(), bindings = new Map();
    for (let index = event.messages.length - 1; index >= 0; index--) {
      const message = event.messages[index];
      const custom = message.role === 'custom' && ['lex-gui-append', 'lex-orca-body'].includes(message.customType);
      if (!custom && message.role !== 'user') continue;
      const match = remaining.findLastIndex(row => custom
        ? row.type === 'custom_message' && row.customType === message.customType && row.details?.submissionId === message.details?.submissionId
        : row.type === 'message' && fingerprint(row.message) === fingerprint(message));
      if (match >= 0) { bindings.set(index, remaining[match]); remaining.splice(match, 1); }
    }
    const fresh = [...bindings].filter(([, row]) => !seenRows.has(row.id));
    if (awaitingRow && !fresh.length) { fail('journal-unavailable'); return; }
    // A native/extension input may be interleaved with the custom GUI row.
    // Admit each actual row independently, in journal/context order.
    for (const [, row] of fresh.reverse()) {
      // Pi 1.2.0 appends user message_end before provider context. Unlike OMP's
      // context, this hook can bind the actual row without inventing a native ID.
      const gui = row.type === 'custom_message' && pendingGui
        && row.customType === (pendingGui.command.payload.delegated === true ? 'lex-orca-body' : 'lex-gui-append')
        && row.details?.submissionId === pendingGui.command.payload.submissionId ? pendingGui : undefined;
      const turnRowId = activeRow; awaitingRow = false;
      const controller = new AbortController(), timer = setTimeout(() => { ctx.abort(); controller.abort(); }, 8_000);
      try {
        const answer = await request('native-input', { sessionFile: nativeId, row,
          ...(turnRowId ? { turnRowId } : {}),
          ...(gui ? { commandId: gui.command.id } : {}) },
          AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]));
        if (answer.accepted !== true || stopped) {
          ctx.abort(); seenRows.add(row.id);
          // This callback already carries a durable row. Admission refusal
          // cannot retroactively prove the native submission never happened.
          if (gui) { retiring = true; result(gui.command, { cancelledOutcomeUnknown: true }); pendingGui = undefined; }
          return;
        }
        activeRow ??= row.id; seenRows.add(row.id); pendingNative = false;
        if (typeof answer.text === 'string') prepared.set(row.id, [{ type: 'text', text: answer.text }, ...(answer.images ?? [])]);
        if (gui) { result(gui.command, { accepted: true }); pendingGui = undefined; }
      } catch {
        const cancelled = ctx.signal?.aborted === true && !controller.signal.aborted;
        ctx.abort();
        if (cancelled) {
          seenRows.add(row.id);
          if (gui) { retiring = true; result(gui.command, { cancelledOutcomeUnknown: true }); pendingGui = undefined; }
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
  pi.on('before_provider_request', async (_event, ctx) => {
    if (stopped || retiring || !activeRow || ctx.sessionManager.getSessionFile() !== nativeId) { ctx.abort(); return; }
    try {
      const answer = await request('provider-admission', { sessionFile: nativeId, turnRowId: activeRow }, ctx.signal);
      if (answer.accepted !== true) throw new Error('Owner revoked');
    } catch { ctx.abort(); fail('input-admission'); }
  });
  for (const name of ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end',
      'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'turn_start', 'turn_end',
      'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end']) {
    pi.on(name, (event, ctx) => {
      if (name === 'compaction_start') compacting = true;
      if (name === 'compaction_end') compacting = false;
      if (!stopped) emit('agent-event', { sessionFile: nativeId, event });
      if (name === 'agent_settled') {
        // Pi abort leaves its native queues intact. Fence subsequent context
        // until Host closes this executor; no cancelled queued input may enter
        // a later explicit turn. Keep polling only to deliver this final receipt.
        if (pendingGui) {
          retiring = true;
          const command = pendingGui.command;
          const found = typeof command.payload.submissionId === 'string' && ctx.sessionManager.getEntries().some(row =>
            row.type === 'custom_message' && row.customType === (command.payload.delegated === true ? 'lex-orca-body' : 'lex-gui-append') && row.details?.submissionId === command.payload.submissionId);
          result(command, found ? { cancelledOutcomeUnknown: true } : { cancelledBeforeConsumption: true });
        }
        else if (pendingNative) { retiring = true; emit('native-queue-retired', { sessionFile: nativeId }); }
        activeRow = undefined; pendingGui = undefined; pendingNative = false;
      }
    });
  }
  pi.on('session_shutdown', async event => {
    if (treeCommand?.payload.type === 'fork_history' && treeCommand.started && event.reason === 'fork') {
      if (typeof event.targetSessionFile !== 'string') throw new Error('Pi replacement target missing');
      await request('history-target', { sessionFile: nativeId, targetSessionFile: event.targetSessionFile });
      return;
    }
    stopped = true; lifetime.abort(); if (globalThis[uiKey] === hostUi) delete globalThis[uiKey];
  });
}
`;
