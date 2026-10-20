/** Runs inside the pinned original interactive OMP, never in a renderer. */
export const OMP_NATIVE_EXTENSION_SOURCE = String.raw`
import { readFileSync } from 'node:fs';
export default function (pi) {
  const url = process.env.LEX_OMP_BRIDGE_URL;
  const token = process.env.LEX_OMP_BRIDGE_TOKEN;
  const generation = process.env.LEX_OMP_BRIDGE_GENERATION;
  const sessionId = process.env.LEX_OMP_BRIDGE_SESSION;
  if (!url || !token || !generation || !sessionId) throw new Error('OMP task transport is missing');
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const lifetime = new AbortController();
  let context, stopped = false, sequence = 0, requestId = 0, pendingGui, activeRow, polling = false;
  let expectedFile, nativeId;
  const events = [], commands = new Set(), seenRows = new Set(), seenUsers = new Set();
  const preparedUsers = new Map(), permissionRequests = new Set();
  const cancelPermissions = () => { for (const controller of permissionRequests) controller.abort(); };
  const emit = (kind, value) => {
    if (events.length >= 256) { fail(); return; }
    events.push({ sequence: ++sequence, kind, value });
  };
  const fail = () => {
    context?.abort();
    if (stopped) return;
    stopped = true; lifetime.abort();
    context?.ui.notify('Lex task connection interrupted. Reopen this task before sending again.', 'error');
    context?.shutdown();
  };
  const post = async (route, body, signal = lifetime.signal) => {
    const response = await fetch(url + route, { method: 'POST', headers,
      body: JSON.stringify({ ...body, generation, sessionId }), signal });
    if (!response.ok) throw new Error('OMP task transport refused');
    return response.json();
  };
  const request = async (kind, input, signal) => {
    const id = String(++requestId);
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    try {
      while (!combined.aborted) {
        const answer = await post('/request', { request: { requestId: id, kind, input } }, combined);
        if (answer.pending) continue;
        if (answer.retired || answer.error || !('result' in answer)) throw new Error('OMP task request refused');
        return answer.result;
      }
      throw new Error('OMP task request cancelled');
    } finally {
      emit('request-retired', { requestId: id });
    }
  };
  const fingerprint = message => JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content });
  const textContent = content => typeof content === 'string' ? content :
    content.every(part => part.type === 'text' && typeof part.text === 'string') ? content.map(part => part.text).join('') : undefined;
  const result = (command, ok, value) => emit('command-result', { id: command.id, ok, result: value });
  const runCommand = async command => {
    if (commands.has(command.id)) return;
    commands.add(command.id);
    if (commands.size > 512) commands.delete(commands.values().next().value);
    try {
      if (command.kind === 'initialize') {
        const payload = command.payload;
        expectedFile = payload.resumeSessionId;
        if (expectedFile && expectedFile !== context.sessionManager.getSessionFile()) throw new Error('OMP history identity changed');
        if (payload.effort) pi.setThinkingLevel(payload.effort);
        result(command, true, { sessionFile: context.sessionManager.getSessionFile() });
      } else if (command.kind === 'prompt') {
        if (pendingGui || activeRow || !context.isIdle() || context.hasPendingMessages()) {
          result(command, true, { refusedBeforeSubmission: true }); return;
        }
        pendingGui = { command, leaf: context.sessionManager.getLeafId(), submittedAt: Date.now() };
        pi.sendUserMessage(command.payload.text);
      } else if (command.kind === 'abort') {
        cancelPermissions(); context.abort(); result(command, true, {});
      } else if (command.kind === 'effort') {
        pi.setThinkingLevel(command.payload.level); result(command, true, {});
      } else if (command.kind === 'shutdown') {
        result(command, true, {}); context.shutdown();
      } else throw new Error('Unknown OMP task command');
    } catch { result(command, false, {}); }
  };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      while (!stopped) {
        const batch = events.slice(0, 32);
        const answer = await post('/exchange', { events: batch }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
        if (answer.faulted) throw new Error('OMP task transport faulted');
        while (events.length && events[0].sequence <= answer.acknowledged) events.shift();
        for (const command of answer.commands ?? []) void runCommand(command).catch(fail);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    } catch { if (!stopped) fail(); }
  };
  // Definitions come from the same fixed startup snapshot and executor as RPC.
  const definitions = JSON.parse(readFileSync(process.env.LEX_OMP_HOST_TOOLS_FILE, 'utf8'));
  for (const definition of definitions) pi.registerTool({ ...definition, label: definition.label ?? definition.name,
    async execute(toolCallId, args, signal) {
      const value = await request('host-tool', { sessionFile: nativeId, toolCallId, toolName: definition.name, arguments: args }, signal);
      if (value.isError) throw new Error(value.content?.map(part => part.text).join('\n') || 'Host tool failed');
      return value;
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (context) { fail(); return; }
    context = ctx; nativeId = ctx.sessionManager.getSessionFile();
    if (!nativeId || ctx.mode !== 'tui') { fail(); return; }
    for (const row of ctx.sessionManager.getEntries()) {
      seenRows.add(row.id);
      if (row.type === 'message' && row.message.role === 'user') seenUsers.add(fingerprint(row.message));
    }
    emit('ready', { sessionFile: nativeId, sessionId: ctx.sessionManager.getSessionId(), model: ctx.model?.id,
      contextWindow: ctx.model?.contextWindow });
    void poll();
  });
  // A task cannot silently change its history through the native session picker.
  for (const name of ['session_before_switch', 'session_before_branch', 'session_before_tree'])
    pi.on(name, () => ({ cancel: true }));
  pi.on('input', async (event, ctx) => {
    if (pendingGui && event.source === 'interactive') {
      // Preserve a native draft entered while the semantic GUI submission is preparing.
      ctx.ui.setEditorText(event.text); return { handled: true };
    }
  });
  pi.on('context', async (event, ctx) => {
    if (stopped || ctx.sessionManager.getSessionFile() !== nativeId) { ctx.abort(); return; }
    // OMP commits message_end independently of extension notification delivery.
    // Yield to that already-queued journal commit, never infer an entry id.
    await Promise.resolve();
    const branch = ctx.sessionManager.getBranch();
    const fresh = branch.filter(row => row.type === 'message' && row.message.role === 'user' && !seenRows.has(row.id));
    if (fresh.length === 0) {
      if (event.messages.some(message => message.role === 'user' && !seenUsers.has(fingerprint(message)))) { ctx.abort(); fail(); return; }
      // Preserve host-prepared bytes on subsequent model requests in this same turn.
      if (!preparedUsers.size) return;
      return { messages: event.messages.map(message => {
        const prepared = preparedUsers.get(fingerprint(message));
        return prepared ? { ...message, content: prepared } : message;
      }) };
    }
    // Native row IDs come only from the official session journal. A batch or
    // ambiguous clone is refused rather than guessed from repeated prompt text.
    const row = fresh[0];
    const matches = event.messages.filter(message => fingerprint(message) === fingerprint(row.message));
    const gui = pendingGui;
    const oldLeaf = gui?.leaf === null ? -1 : branch.findIndex(entry => entry.id === gui?.leaf);
    if (fresh.length !== 1 || matches.length !== 1 || (gui &&
      ((gui.leaf !== null && oldLeaf < 0) || branch.indexOf(row) <= oldLeaf || row.message.timestamp < gui.submittedAt ||
       textContent(row.message.content) !== gui.command.payload.text))) { ctx.abort(); fail(); return; }
    for (const entry of branch) seenRows.add(entry.id);
    const admission = new AbortController();
    const guard = setTimeout(() => { ctx.abort(); admission.abort(); }, 8_000);
    try {
      const answer = await request('admit-input', { sessionFile: nativeId, row,
        ...(gui ? { commandId: gui.command.id } : {}) }, admission.signal);
      if (answer.accepted !== true || typeof answer.text !== 'string') throw new Error('OMP input was not admitted');
      seenUsers.add(fingerprint(row.message));
      preparedUsers.set(fingerprint(row.message), [{ type: 'text', text: answer.text }]); activeRow = row.id;
      if (gui) { pendingGui = undefined; result(gui.command, true, { messageId: row.id }); }
      return { messages: event.messages.map(message => {
        const prepared = preparedUsers.get(fingerprint(message));
        return prepared ? { ...message, content: prepared } : message;
      }) };
    } catch { ctx.abort(); if (gui) { pendingGui = undefined; result(gui.command, false, {}); } }
    finally { clearTimeout(guard); }
  });
  pi.on('tool_call', async (event, ctx) => {
    // Match the existing OMP approval budget, and retire the exact host request
    // on cancel/timeout so a late allow cannot outlive this native callback.
    const controller = new AbortController();
    permissionRequests.add(controller);
    const guard = setTimeout(() => { controller.abort(); ctx.abort(); }, 30_000);
    try {
      const answer = await request('tool-policy', { sessionFile: nativeId, toolCallId: event.toolCallId,
        toolName: event.toolName, input: event.input }, controller.signal);
      if (controller.signal.aborted || answer.allowed !== true) return { block: true, reason: 'Not approved by the task owner' };
    } catch { ctx.abort(); return { block: true, reason: 'Task permission request interrupted' }; }
    finally { clearTimeout(guard); permissionRequests.delete(controller); }
  });
  for (const name of ['agent_start', 'message_start', 'message_update', 'message_end', 'tool_execution_start',
    'tool_execution_update', 'tool_execution_end', 'auto_compaction_start', 'auto_compaction_end',
    'auto_retry_start', 'auto_retry_end', 'agent_end']) {
    pi.on(name, async event => {
      emit('agent-event', { event, sessionFile: nativeId });
      if (event.type === 'agent_end' && event.willContinue !== true) { activeRow = undefined; cancelPermissions(); }
    });
  }
  pi.on('session_shutdown', () => { stopped = true; lifetime.abort(); });
}
`;
