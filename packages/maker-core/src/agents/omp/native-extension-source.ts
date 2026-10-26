/** Runs inside the pinned original interactive OMP, never in a renderer. */
export const OMP_NATIVE_EXTENSION_SOURCE = String.raw`
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Text } from '@oh-my-pi/pi-tui';
export default function (pi) {
  const url = process.env.LEX_OMP_BRIDGE_URL;
  const token = process.env.LEX_OMP_BRIDGE_TOKEN;
  const generation = process.env.LEX_OMP_BRIDGE_GENERATION;
  const sessionId = process.env.LEX_OMP_BRIDGE_SESSION;
  if (!url || !token || !generation || !sessionId) throw new Error('OMP task transport is missing');
  pi.registerMessageRenderer('lex-gui-append', (message, _options, theme) => {
    const body = typeof message.content === 'string' ? message.content : message.content
      .filter(part => part.type === 'text').map(part => part.text).join('\n');
    return new Text(theme.fg('muted', 'GUI') + '\n' + body, 0, 0);
  });
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const lifetime = new AbortController();
  let context, stopped = false, retiring = false, sequence = 0, requestId = 0, pendingGui, pendingBatch, pendingNative = false, activeRow, polling = false;
  let expectedFile, nativeId;
  let hostContextGeneration = 0;
  const events = [], commands = new Set(), seenRows = new Set();
  const preparedUsers = new Map(), permissionRequests = new Set();
  const cancelPermissions = () => { for (const controller of permissionRequests) controller.abort(); };
  const emit = (kind, value) => {
    if (events.length >= 256) { fail(); return; }
    events.push({ sequence: ++sequence, kind, value });
  };
  const fail = (reason = 'transport') => {
    context?.abort();
    if (stopped) return;
    stopped = true; lifetime.abort();
    context?.ui.notify('Lex task connection interrupted. Reopen this task before sending again.', 'error');
    // PTY console output is not a reliable diagnostic channel. Report only a
    // fixed phase through the authenticated host before bounded shutdown.
    void post('/request', { request: { requestId: String(++requestId), kind: 'native-fault',
      input: { sessionFile: nativeId, phase: typeof reason === 'string' ? reason : 'transport' } } }, AbortSignal.timeout(500))
      .catch(() => {}).finally(() => context?.shutdown());
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
        if (payload.effort) {
          pi.setThinkingLevel(payload.effort);
          if (pi.getThinkingLevel() !== payload.effort) throw new Error('OMP effort was not applied');
        }
        result(command, true, { sessionFile: context.sessionManager.getSessionFile() });
      } else if (command.kind === 'prompt' || command.kind === 'steer') {
        const steering = command.kind === 'steer';
        if (retiring || pendingGui || pendingBatch || pendingNative || context.hasPendingMessages()
            || (steering ? !activeRow || context.isIdle() || command.payload.turnRowId !== activeRow : activeRow || !context.isIdle())) {
          result(command, true, { refusedBeforeSubmission: true }); return;
        }
        if (steering && (typeof command.payload.submissionId !== 'string' || !command.payload.submissionId)) {
          result(command, true, { refusedBeforeSubmission: true }); return;
        }
        pendingGui = { command, leaf: context.sessionManager.getLeafId() };
        if (steering) pi.sendMessage({ customType: 'lex-gui-append', content: command.payload.text, display: true,
          attribution: 'user', details: { submissionId: command.payload.submissionId } }, { deliverAs: 'steer' });
        else pi.sendUserMessage(command.payload.text);
      } else if (command.kind === 'read-tree') {
        result(command, true, { tree: context.sessionManager.getTree(), leafId: context.sessionManager.getLeafId(),
          sessionFile: nativeId, contextUsage: context.getContextUsage() });
      } else if (command.kind === 'editor-draft' || command.kind === 'restore-editor-draft') {
        if (retiring || activeRow || pendingGui || pendingBatch || pendingNative || !context.isIdle() || context.hasPendingMessages())
          throw new Error('OMP editor is not idle');
        if (command.kind === 'restore-editor-draft') {
          if (typeof command.payload.text !== 'string' || command.payload.text.length > 1_000_000) throw new Error('Invalid OMP draft');
          context.ui.setEditorText(command.payload.text);
          if (context.ui.getEditorText() !== command.payload.text) throw new Error('OMP draft readback changed');
        }
        result(command, true, { text: context.ui.getEditorText(), sessionFile: nativeId });
      } else if (command.kind === 'host-context') {
        const next = command.payload.generation;
        if (!Number.isSafeInteger(next) || next <= hostContextGeneration) throw new Error('OMP host context is stale');
        // Inspect the native registration, not merely the JSON manifest which
        // was offered at startup. Never enable a tool the user disabled.
        const all = pi.getAllTools(), active = new Set(pi.getActiveTools());
        const catalog = definitions.map(expected => {
          const actual = all.find(tool => tool.name === expected.name);
          if (!actual || !active.has(actual.name) || actual.description !== expected.description
            || JSON.stringify(actual.parameters) !== JSON.stringify(expected.parameters)) throw new Error('OMP host tool registration changed');
          return actual.name;
        });
        hostContextGeneration = next;
        result(command, true, { generation: next, catalog });
      } else if (command.kind === 'abort') {
        // Native abort may continue draining. Fence provider admission before
        // calling it; pending inputs are reconciled only after executor exit.
        if (pendingGui || pendingBatch || pendingNative) retiring = true;
        cancelPermissions(); context.abort(); result(command, true, {});
      } else if (command.kind === 'effort') {
        pi.setThinkingLevel(command.payload.level);
        result(command, true, { level: pi.getThinkingLevel() });
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
      const value = await request('host-tool', { sessionFile: nativeId, contextGeneration: hostContextGeneration,
        toolCallId, toolName: definition.name, arguments: args }, signal);
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
    }
    emit('ready', { sessionFile: nativeId, sessionId: ctx.sessionManager.getSessionId(), model: ctx.model?.id,
      contextWindow: ctx.model?.contextWindow });
    void poll();
  });
  // A task cannot silently change its history through the native session picker.
  for (const name of ['session_before_switch', 'session_before_branch', 'session_before_tree'])
    pi.on(name, () => ({ cancel: true }));
  pi.on('input', async (event, ctx) => {
    if ((retiring || pendingGui || pendingNative) && event.source === 'interactive') {
      // Preserve a native draft entered while the semantic GUI submission is preparing.
      ctx.ui.setEditorText(event.text); return { handled: true };
    }
    if (activeRow && event.source === 'interactive') pendingNative = true;
  });
  pi.on('context', async (event, ctx) => {
    if (stopped || retiring || ctx.sessionManager.getSessionFile() !== nativeId) { ctx.abort(); return; }
    // OMP 18.10.4 prepares provider context BEFORE emitting the input events
    // that allocate its journal row. Admit a distinct bridge submission now;
    // bind the real row only at the subsequent before_provider_request hook.
    // Consume known branch occurrences in order, using durable row IDs for
    // prepared content. Equal text/timestamps are not deduplication keys. OMP
    // allocates the new row only after this hook; unmatched occurrences each
    // need their own admission and later journal receipt.
    const known = ctx.sessionManager.getBranch().filter(row => seenRows.has(row.id) &&
      ((row.type === 'message' && row.message.role === 'user') || (row.type === 'custom_message' && row.customType === 'lex-gui-append')));
    const bindings = new Map(), fresh = [];
    let cursor = 0;
    for (let index = 0; index < event.messages.length; index++) {
      const message = event.messages[index], custom = message.role === 'custom' && message.customType === 'lex-gui-append';
      if (!custom && message.role !== 'user') continue;
      const match = known.findIndex((row, position) => position >= cursor && (custom
        ? row.type === 'custom_message' && row.details?.submissionId === message.details?.submissionId
        : row.type === 'message' && fingerprint(row.message) === fingerprint(message)));
      if (match < 0) fresh.push({ message, index });
      else { bindings.set(index, known[match]); cursor = match + 1; }
    }
    if (fresh.length) {
      // A current turn may drain several queued inputs in one provider context.
      // Keep their complete order and bounded admission batch, never collapse
      // equal text into a single pending GUI submission.
      if (fresh.length > 32 || pendingBatch || (!activeRow && fresh.length !== 1)) { ctx.abort(); fail('input-association'); return; }
      const batch = { inputs: [], leaf: ctx.sessionManager.getLeafId(), deadline: Date.now() + 8_000 };
      pendingBatch = batch;
      for (const item of fresh) {
        const { message, index } = item, custom = message.role === 'custom';
        const gui = custom
          ? (pendingGui?.command.kind === 'steer' && message.details?.submissionId === pendingGui.command.payload.submissionId ? pendingGui : undefined)
          : (pendingGui?.command.kind === 'prompt' ? pendingGui : undefined);
        if (gui && !custom && textContent(message.content) !== gui.command.payload.text) {
          ctx.abort(); fail('gui-input-association'); return;
        }
        const input = { submissionId: custom ? message.details?.submissionId : randomUUID(), fingerprint: fingerprint(message), message, gui, index, prepared: undefined };
        if (batch.inputs.some(prior => prior.submissionId === input.submissionId)) { ctx.abort(); fail('input-association'); return; }
        batch.inputs.push(input);
        const admission = new AbortController();
        const guard = setTimeout(() => { ctx.abort(); admission.abort(); }, Math.max(1, batch.deadline - Date.now()));
        try {
          const answer = await request('prepare-input', { sessionFile: nativeId, submissionId: input.submissionId, message,
            ...(activeRow ? { turnRowId: activeRow } : {}),
            ...(gui ? { commandId: gui.command.id } : {}) }, admission.signal);
          if (answer.accepted !== true || typeof answer.text !== 'string' || pendingBatch !== batch || stopped || retiring)
            throw new Error('OMP input was not admitted');
          input.prepared = [{ type: 'text', text: answer.text }];
        } catch { ctx.abort(); fail('input-admission-refused'); return; }
        finally { clearTimeout(guard); }
      }
    }
    const preparedBatch = new Map(pendingBatch?.inputs.map(input => [input.index, input.prepared]) ?? []);
    if (preparedUsers.size || preparedBatch.size) return { messages: event.messages.map((message, index) => {
      const prepared = preparedBatch.get(index) ?? preparedUsers.get(bindings.get(index)?.id);
      return prepared ? { ...message, content: prepared } : message;
    }) };
  });
  pi.on('before_provider_request', async (_event, ctx) => {
    if (stopped || retiring || ctx.sessionManager.getSessionFile() !== nativeId) { ctx.abort(); return; }
    const batch = pendingBatch;
    if (!batch) {
      if (!activeRow) { ctx.abort(); fail('provider-without-input'); return; }
      try {
        const answer = await request('provider-admission', { sessionFile: nativeId, turnRowId: activeRow });
        if (answer.accepted !== true) throw new Error('Owner revoked');
      } catch { ctx.abort(); fail('provider-without-input'); }
      return;
    }
    const admission = new AbortController();
    const guard = setTimeout(() => { ctx.abort(); admission.abort(); }, Math.max(1, batch.deadline - Date.now()));
    try {
      let branch, fresh;
      // Input events have now been emitted. Their independent persistence tail
      // may still be settling; this wait no longer blocks the event producer.
      do {
        if (stopped || retiring || pendingBatch !== batch || admission.signal.aborted || Date.now() >= batch.deadline
          || ctx.sessionManager.getSessionFile() !== nativeId) throw new Error('OMP receipt is no longer current');
        branch = ctx.sessionManager.getBranch();
        fresh = branch.filter(row => !seenRows.has(row.id) && ((row.type === 'message' && row.message.role === 'user')
          || (row.type === 'custom_message' && row.customType === 'lex-gui-append')));
        if (fresh.length < batch.inputs.length) await new Promise(resolve => setTimeout(resolve, 5));
      } while (fresh.length < batch.inputs.length);
      const oldLeaf = batch.leaf === null ? -1 : branch.findIndex(entry => entry.id === batch.leaf);
      // Validate the entire tail before issuing any receipt. Native occurrence
      // order is used only for native inputs; GUI always requires its own token.
      if (fresh.length !== batch.inputs.length || (batch.leaf !== null && oldLeaf < 0)
        || fresh.some((row, index) => {
          const input = batch.inputs[index];
          return branch.indexOf(row) <= oldLeaf || (input.message.role === 'custom'
            ? row.type !== 'custom_message' || row.attribution !== 'user' || row.details?.submissionId !== input.submissionId
            : row.type !== 'message' || fingerprint(row.message) !== input.fingerprint);
        })) throw new Error('OMP receipt is ambiguous');
      for (let index = 0; index < batch.inputs.length; index++) {
        const input = batch.inputs[index], row = fresh[index];
        const answer = await request('input-receipt', { sessionFile: nativeId, submissionId: input.submissionId, row }, admission.signal);
        if (answer.accepted !== true || stopped || retiring || pendingBatch !== batch) throw new Error('OMP receipt was refused');
        seenRows.add(row.id);
        preparedUsers.set(row.id, input.prepared);
        activeRow ??= row.id;
        if (input.gui) { pendingGui = undefined; result(input.gui.command, true, { messageId: row.id }); }
      }
      pendingBatch = undefined; pendingNative = false;
    } catch { ctx.abort(); fail('journal-receipt-unavailable'); }
    finally { clearTimeout(guard); }
    // Do not replace the payload: the original engine already converted the
    // host-prepared messages using its own provider/cache/metadata semantics.
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
      if (event.type === 'agent_end' && event.willContinue !== true) {
        if (pendingGui) {
          retiring = true;
          const command = pendingGui.command;
          const found = command.kind === 'steer' && context.sessionManager.getEntries().some(row =>
            row.type === 'custom_message' && row.customType === 'lex-gui-append' && row.details?.submissionId === command.payload.submissionId);
          result(command, true, found ? { cancelledOutcomeUnknown: true } : { cancelledBeforeConsumption: true });
        }
        else if (pendingNative) { retiring = true; emit('native-queue-retired', { sessionFile: nativeId }); }
        pendingGui = undefined; pendingNative = false;
        activeRow = undefined; pendingBatch = undefined; cancelPermissions();
      }
    });
  }
  pi.on('session_shutdown', () => { stopped = true; lifetime.abort(); });
}
`;
