import { GUI_NATIVE_APPEND } from '../../base-agent.js';
/** Opt-in original OMP frontend, production bridge, synthetic provider, private profile. */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { createOmpNativeSession } from '../native-session.js';
import { OMP_NATIVE_EXTENSION_SOURCE } from '../native-extension-source.js';
import { Session } from '../../../session.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { AgentEvent } from '../../../types/events.js';
import { startOmpProcess, type OmpProcessHost } from '../process-host.js';
import { manageOmpNativeHistory } from '../native-history-reopen.js';

const binary = process.env.CINDY_TEST_OMP_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn(message, data) { process.stdout.write(JSON.stringify({ nativeWarning: message, data }) + String.fromCharCode(10)); }, error() {}, fatal() {}, child() { return logger; } };
const newline = String.fromCharCode(10), escape = String.fromCharCode(27);
function reply(res: ServerResponse, text: string) {
  const frames = [
    { type: 'message_start', message: { id: 'fixture', role: 'assistant', type: 'message', model: 'omp-test-model', content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frames.map(frame => 'event: ' + frame.type + newline + 'data: ' + JSON.stringify(frame) + newline + newline).join(''));
}

it.skipIf(!binary).each([false, true, 'collision' as const, 'rpc-history' as const, 'production-history' as const, 'roles' as const, 'roles-self' as const, 'initial-handled' as const])('OMP TUI binds GUI and native additions to consumed journal rows (batch=%s)', async batch => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-omp-native-steer-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), agentHome = path.join(home, '.omp', 'agent');
  const batchTrace = path.join(root, 'context-batches.jsonl');
  await Promise.all([mkdir(agentHome, { recursive: true }), mkdir(cwd)]);
  const bodies: Array<Record<string, any>> = [], responses: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); responses.push(res);
    if (bodies.length === 3) reply(res, 'native steer consumed');
  });
  let session: Session | undefined, terminal: any, nativeFile: string | undefined;
  let rpc: OmpProcessHost | undefined;
  let nativeEnvironment: Record<string, string> | undefined;
  const vendorOptions: Record<string, unknown> = {};
  const roleCalls: unknown[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
    const endpoint = 'http://127.0.0.1:' + address.port;
    const config = path.join(agentHome, 'config.yml'), extension = path.join(root, 'bridge.ts'), definitions = path.join(root, 'tools.json');
    let extensionSource = !batch ? OMP_NATIVE_EXTENSION_SOURCE : OMP_NATIVE_EXTENSION_SOURCE
      .replace("import { readFileSync }", "import { appendFileSync, readFileSync }")
      .replace('export default function (pi) {', 'export default function (pi) {' + newline +
        "pi.on('context', event => appendFileSync(" + JSON.stringify(batchTrace) + ", JSON.stringify(event.messages.map(message => ({role:message.role,customType:message.customType,details:message.details}))) + String.fromCharCode(10)));" )
      .replace('else pi.sendUserMessage(command.payload.text);', 'else pi.sendUserMessage(command.payload.text);' + newline +
        "if (steering && command.payload.text === 'GUI_STEER') { pi.sendUserMessage('GUI_STEER', {deliverAs:'steer'}); " +
        (batch === 'collision' ? "pi.sendUserMessage('GUI_STEER', {deliverAs:'steer'});" : "setTimeout(() => pi.sendUserMessage('GUI_STEER', {deliverAs:'steer'}), 20);") + ' }');
    if (batch === 'initial-handled') extensionSource = extensionSource.replace('export default function (pi) {',
      'export default function (pi) {' + newline + "let interceptedInitial = false; pi.on('input', event => {" +
      "appendFileSync(" + JSON.stringify(batchTrace) + ", JSON.stringify({inputSource:event.source,text:event.text}) + String.fromCharCode(10));" +
      "if (!interceptedInitial && event.text === 'FIRST') { interceptedInitial = true;" +
      "appendFileSync(" + JSON.stringify(batchTrace) + ", JSON.stringify({originalHandled:true,source:event.source}) + String.fromCharCode(10));" +
      "setTimeout(() => pi.sendUserMessage('FIRST'), 20); return {handled:true}; } });");
    await Promise.all([
      writeFile(config, JSON.stringify({ steeringMode: batch ? 'all' : 'one-at-a-time',
        startup: { setupWizard: false, checkUpdate: false, showSplash: false }, recap: { enabled: false } })),
      writeFile(path.join(agentHome, 'models.yml'), JSON.stringify({ providers: { cindy: { baseUrl: endpoint, api: 'anthropic-messages', apiKey: 'invalid-fixture-key',
        models: [{ id: 'omp-test-model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } })),
      writeFile(extension, extensionSource), writeFile(definitions, '[]'),
    ]);
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const openNative = (resumeSessionId?: string) => createOmpNativeSession({ sessionId: 'fixture-task', model: 'omp-test-model', providerId: 'cindy', permissionMode: 'ask', resumeSessionId,
      executable: binary!, plan: {} as never, vendorOptions,
      hostTools: batch === 'roles' || batch === 'roles-self' ? [{ name: 'lex_role_fixture', description: 'Read the synthetic task role', parameters: { type: 'object', properties: {} },
        async execute(_args, { signal }) {
          roleCalls.push(vendorOptions.orcaRole ?? null);
          if (batch === 'roles-self') {
            await session!.setVendorOptions({ orcaRole: 'lead', orcaWorkflowId: 'synthetic-team' });
            expect(signal.aborted).toBe(false);
          }
          return { content: [{ type: 'text', text: String(vendorOptions.orcaRole ?? 'ordinary') }] };
        },
      }] : [], logger, releaseResources: async () => {},
      async launch(environment, tools) {
        await writeFile(definitions, JSON.stringify(tools));
        const env: Record<string, string> = {};
        for (const key of Object.keys(process.env)) if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)) env[key] = process.env[key]!;
        Object.assign(env, environment, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
          XDG_CONFIG_HOME: path.join(home, '.config'), PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: '1', PI_BUILD_URL: endpoint,
          NO_PROXY: '127.0.0.1,localhost', LEX_OMP_HOST_TOOLS_FILE: definitions });
        nativeEnvironment = { ...env };
        terminal = pty.spawn(binary!, ['--provider', 'cindy', '--model', 'omp-test-model', '--config', config, '--extension', extension,
          '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--session-dir', path.join(root, 'sessions'),
          ...(resumeSessionId ? ['--resume', resumeSessionId] : [])],
          { cwd, env, name: 'xterm-256color', cols: 100, rows: 30 });
        let exited = false;
        const exit = new Promise<void>(resolve => terminal.onExit(() => { exited = true; resolve(); }));
        terminal.onData((data: string) => {
          if (data.includes(escape + '[6n')) terminal.write(escape + '[1;1R');
          if (data.includes(escape + '[c')) terminal.write(escape + '[?1;2c');
        });
        return { write: (data: string) => terminal.write(data), resize: (cols: number, rows: number) => terminal.resize(cols, rows),
          onData: (listener: (data: string) => void) => { const sub = terminal.onData(listener); return () => sub.dispose(); },
          onExit: (listener: (event: { code: number }) => void) => { const sub = terminal.onExit((event: { exitCode: number }) => listener({ code: event.exitCode })); return () => sub.dispose(); },
          async close() {
            if (!exited) { terminal.write(String.fromCharCode(3)); await new Promise(resolve => setTimeout(resolve, 100)); terminal.write(String.fromCharCode(3)); }
            for (let i = 0; i < 20 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
            if (!exited) terminal.kill(); await exit;
          },
        };
      },
    });
    const initial = await openNative();
    let forkCount = 0;
    const handle = batch !== 'production-history' ? initial : manageOmpNativeHistory({ initial, model: 'omp-test-model', openNative,
      async openRpc(originalFile) {
        const environment = { ...nativeEnvironment! };
        for (const key of Object.keys(environment)) if (key.startsWith('LEX_OMP_BRIDGE_')) delete environment[key];
        const owned = startOmpProcess({ executablePath: binary!, workingDirectory: cwd,
          arguments: ['--mode', 'rpc', '--provider', 'cindy', '--model', 'omp-test-model', '--config', config,
            '--no-extensions', '--no-skills', '--no-rules', '--session', originalFile], environment,
          terminateProcessTree(child) { child.kill(); }, onEvent() {}, onState() {},
        }); rpc = owned;
        await vi.waitFor(() => expect(owned.getState()).toBe('ready'), { timeout: 15000 });
        const request = owned.client.request.bind(owned.client);
        vi.spyOn(owned.client, 'request').mockImplementation((command, timeout) => {
          if (command.type === 'fork') forkCount++;
          return request(command, timeout);
        });
        return { host: owned, stopAndDispose: async () => { const stopped = await owned.stopAndWait(); if (stopped) rpc = undefined; return stopped; } } as never;
      },
    });
    const events: AgentEvent[] = [];
    nativeFile = handle.id;
    session = new Session({ id: 'fixture-task', agentKind: 'omp', workDir: cwd, handle, logger, turnStallMs: 0,
      capabilities: { sameTurnSteer: { supported: true } } as never });
    session.onEvent(event => events.push(event));
    const native: import('../../native-input.js').AgentNativeInputRequest[] = [];
    const nativeReceipt = vi.fn();
    session.onNativeInput(async input => {
      native.push(input);
      if (input.nativeTurnId) await session!.acceptNativeSteer(input);
      else await session!.acceptNativeInput(input, { onNativeUserMessage: nativeReceipt });
    });
    const initialReceipt = vi.fn();
    const initialOutcome = await session.send('FIRST', { messageUuid: 'gui-first', onNativeUserMessage: initialReceipt }).then(() => null, error => error as Error);
    if (batch === 'initial-handled') {
      const before = await readFile(batchTrace, 'utf8');
      // OMP's sendUserMessage does not necessarily traverse the same input
      // hooks as Pi. Prove the actual event contract using native TUI input.
      if (!before.includes('originalHandled')) {
        expect(initialOutcome).toBeNull(); expect(initialReceipt).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
        reply(responses[0]!, 'initial response');
        await vi.waitFor(() => expect(session!.isTurnRunning()).toBe(false), { timeout: 15000 });
        terminal.write(escape + '[200~FIRST' + escape + '[201~');
        await new Promise(resolve => setTimeout(resolve, 100)); terminal.write(String.fromCharCode(13));
        await vi.waitFor(async () => expect(await readFile(batchTrace, 'utf8')).toContain('originalHandled'), { timeout: 15000 });
        await vi.waitFor(() => expect(bodies).toHaveLength(2), { timeout: 15000 });
        expect(initialReceipt).toHaveBeenCalledOnce();
        expect(native).toHaveLength(1);
        expect(nativeReceipt).toHaveBeenCalledOnce();
        const consumed = nativeReceipt.mock.calls[0]![0];
        expect(consumed.messageId).not.toBe(initialReceipt.mock.calls[0]![0].messageId);
        reply(responses[1]!, 'independent extension response');
        await vi.waitFor(() => expect(session!.isTurnRunning()).toBe(false), { timeout: 15000 });
        process.stdout.write(JSON.stringify({ initialOmpHookControl: { guiInputHook: false,
          trace: await readFile(batchTrace, 'utf8'), receipts: initialReceipt.mock.calls, independent: consumed, requests: bodies.length } }) + newline);
        return;
      }
      const trace = before;
      process.stdout.write(JSON.stringify({ initialOmpHandled: { trace, receipt: initialReceipt.mock.calls,
        outcome: initialOutcome?.message ?? 'accepted', requests: bodies.length } }) + newline);
      // An independent same-text extension input cannot consume the handled
      // GUI intent. Keep this real red until a causal route is approved.
      expect(initialReceipt).not.toHaveBeenCalled();
      expect(initialOutcome).not.toBeNull();
      return;
    }
    if (initialOutcome) throw initialOutcome;
    await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
    const firstTurn = handle.getCurrentTurnId!(), receipt = vi.fn();
    const steering = session.steer('GUI_STEER', { [GUI_NATIVE_APPEND]: true, messageUuid: 'gui-steer', onNativeUserMessage: receipt }); void steering.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 250)); expect(receipt).not.toHaveBeenCalled();
    reply(responses[0]!, 'first response');
    if (batch === 'collision') {
      // OMP itself coalesces two same-text, same-timestamp native rows in its
      // journal. Synchronous calls can straddle a clock tick: assert actual
      // persistence instead of assuming the native timestamp resolution.
      const outcome = await steering.then(() => null, error => error as Error);
      const journal = (await readFile(handle.id, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      const independent = journal.filter(row => row.type === 'message' && row.message?.role === 'user'
        && JSON.stringify(row.message.content).includes('GUI_STEER'));
      expect([1, 2]).toContain(independent.length);
      if (independent.length === 1) {
        expect(outcome?.message).toContain('unknown');
        expect(receipt).not.toHaveBeenCalled(); expect(bodies).toHaveLength(1);
        process.stdout.write(JSON.stringify({ nativeJournalCollision: { requests: bodies.length, guiReceipts: receipt.mock.calls.length,
          consumptions: native.map(input => input.consumption!.read()) } }) + newline);
        return;
      }
      expect(outcome).toBeNull();
      process.stdout.write(JSON.stringify({ nativeJournalCollision: { observed: false, independentRows: independent.length } }) + newline);
    }
    await steering;
    await vi.waitFor(() => expect(bodies).toHaveLength(2), { timeout: 15000 });
    expect(receipt).toHaveBeenCalledOnce(); expect(handle.getCurrentTurnId!()).toBe(firstTurn);
    terminal.write(escape + '[200~NATIVE_STEER' + escape + '[201~');
    await new Promise(resolve => setTimeout(resolve, 100)); terminal.write(String.fromCharCode(13));
    await new Promise(resolve => setTimeout(resolve, 250));
    reply(responses[1]!, 'second response');
    await vi.waitFor(() => expect(bodies).toHaveLength(3), { timeout: 15000 });
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true), { timeout: 15000 });
    expect(native).toHaveLength(batch ? 3 : 1);
    for (const input of native) expect(await input.consumption!.settled).toMatchObject({ engine: 'omp', status: 'consumed', turnId: firstTurn });
    expect(JSON.stringify(bodies[1]!.messages)).toContain('GUI_STEER');
    expect(JSON.stringify(bodies[2]!.messages)).toContain('NATIVE_STEER');
    // OMP's native Anthropic adapter generates a per-request billing header.
    // Record it separately; never claim the full request prefix is identical.
    for (const body of bodies) expect(body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(bodies[0]!.system.slice(1)).toEqual(bodies[1]!.system.slice(1));
    expect(bodies[1]!.system.slice(1)).toEqual(bodies[2]!.system.slice(1));
    expect(bodies[1]!.tools).toEqual(bodies[2]!.tools);
    const rows = (await readFile(handle.id, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const appended = rows.filter(row => row.type === 'custom_message' && row.customType === 'lex-gui-append');
    expect(appended).toHaveLength(1); expect(appended[0].attribution).toBe('user');
    expect(appended[0].details.submissionId).toBe('gui-steer');
    expect(receipt.mock.calls[0]![0].messageId).toBe(appended[0].id);
    if (batch) {
      const independent = rows.filter(row => row.type === 'message' && row.message?.role === 'user'
        && JSON.stringify(row.message.content).includes('GUI_STEER'));
      expect(independent).toHaveLength(2);
      expect(native.slice(0, 2).map(input => input.consumption!.read().itemId)).toEqual(independent.map(row => row.id));
      expect(independent.every(row => row.id !== appended[0].id)).toBe(true);
      const contexts = (await readFile(batchTrace, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      // One actual context contains the initial row, GUI custom and two native
      // rows; these are not separate turn probes.
      expect(contexts[1].filter((message: any) => message.role === 'user' || message.role === 'custom')).toHaveLength(4);
    }
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain('submissionId');
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain('gui-steer');
    const restored = await handle.readSessionTree!();
    expect(restored.messages).toContainEqual(expect.objectContaining({ role: 'user',
      agentMeta: expect.objectContaining({ uuid: appended[0].id, nativeEntryType: 'custom_message',
        nativeSource: expect.objectContaining({ engine: 'omp', bridge: expect.objectContaining({ submissionId: 'gui-steer' }) }) }) }));
    if (batch === 'roles' || batch === 'roles-self') {
      for (const role of batch === 'roles' ? ['lead', null, 'lead'] : []) {
        await handle.setVendorOptions!({ orcaRole: role, orcaWorkflowId: role ? 'synthetic-team' : null });
        expect(vendorOptions.orcaRole).toBe(role);
      }
      session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }));
      await session.send('TOOL_ROLE');
      await vi.waitFor(() => expect(bodies).toHaveLength(4), { timeout: 15000 });
      const res = responses[3]!;
      const frames = [
        { type: 'message_start', message: { id: 'fixture-tool', role: 'assistant', type: 'message', model: 'omp-test-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'role-call', name: 'lex_role_fixture', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frames.map(frame => 'event: ' + frame.type + newline + 'data: ' + JSON.stringify(frame) + newline + newline).join(''));
      await vi.waitFor(() => expect(bodies).toHaveLength(5), { timeout: 15000 });
      expect(roleCalls).toEqual([batch === 'roles' ? 'lead' : null]);
      expect(vendorOptions.orcaRole).toBe('lead');
      const toolResponse = bodies[4]!.messages.flatMap((message: any) => message.content ?? [])
        .find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'role-call');
      expect(toolResponse).toBeDefined();
      expect(toolResponse.is_error).not.toBe(true);
      expect(JSON.stringify(toolResponse.content)).toContain('lead');
      reply(responses[4]!, 'role checked');
      await vi.waitFor(() => expect(session!.isTurnRunning()).toBe(false), { timeout: 15000 });
      await handle.setVendorOptions!({ orcaRole: null, orcaWorkflowId: null });
      expect(vendorOptions.orcaRole).toBeNull();
      expect(bodies[0]!.tools).toEqual(bodies[4]!.tools);
      process.stdout.write(JSON.stringify({ nativeOmpRoles: { selfTransition: batch === 'roles-self', transitions: batch === 'roles' ? 4 : 2, catalogReadback: true, actualHandlerRoles: roleCalls,
        finalRole: vendorOptions.orcaRole, stableToolSchema: true, requests: bodies.length } }) + newline);
      return;
    }
    if (batch === 'production-history') {
      const source = handle.id, previousGeneration = handle.presentation!.state().generation;
      const forkEntry = rows.findLast(row => row.type === 'message' && row.message?.role === 'assistant').id;
      const draft = '保留未发送 native draft /not-a-command';
      await handle.restoreNativeEditorDraft!(draft);
      const beforeUsage = handle.getUsageSnapshot();
      let target: string | undefined;
      const checkpoint = { async beforeNavigate() {}, async afterNavigate() {}, async beforeReplacement() {},
        async target(value: string) { target = value; await writeFile(path.join(root, 'history-target.json'), JSON.stringify({ source, target, draft })); } };
      await expect(session.navigateSessionTreeAndPersist(forkEntry, {}, async () => { throw new Error('synthetic projection failure'); }, checkpoint)).rejects.toThrow('synthetic projection failure');
      expect(target).toBeDefined(); expect(handle.id).toBe(target); expect(forkCount).toBe(1);
      const view = handle.presentation!.attach('new-window', () => {}); expect(view.acquireControl()).toBeNull();
      const recovered = await session.navigateSessionTreeAndPersist(forkEntry, {}, async result => result, checkpoint);
      expect(recovered.result.nativeIdentity).toEqual({ source, target });
      expect(recovered.result.tree.leafId).toBe(forkEntry);
      expect(handle.presentation!.state().generation).not.toBe(previousGeneration);
      expect(await handle.readNativeEditorDraft!()).toBe(draft);
      expect(handle.getUsageSnapshot().tokenUsage).toBe(beforeUsage.tokenUsage);
      expect(handle.getUsageSnapshot().costUsd).toBe(beforeUsage.costUsd);
      expect(view.acquireControl()).not.toBeNull(); expect(forkCount).toBe(1); expect(bodies).toHaveLength(3);
      process.stdout.write(JSON.stringify({ nativeOmpProductionHistory: { forkCount, source, target, durableTarget: true,
        projectionFailureRecoveredWithoutReplay: true, sameTask: session.id, draftPreserved: true, spendPreserved: true, requests: bodies.length } }) + newline);
      return;
    }
    if (batch === 'rpc-history') {
      const originalFile = handle.id;
      const forkEntry = rows.findLast(row => row.type === 'message' && row.message?.role === 'assistant').id;
      const draft = '保留未发送 native draft /not-a-command';
      await handle.restoreNativeEditorDraft!(draft);
      expect(await handle.readNativeEditorDraft!()).toBe(draft);
      await session.close();
      // OMP appends its official session_exit metadata when closing. Freeze
      // after confirmed exit, then distinguish it from conversation rows.
      const originalBytes = await readFile(originalFile);
      const closedRows = originalBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(closedRows.at(-1)).toMatchObject({ type: 'custom', customType: 'session_exit', parentId: restored.tree.leafId });
      const environment = { ...nativeEnvironment! };
      for (const key of Object.keys(environment)) if (key.startsWith('LEX_OMP_BRIDGE_')) delete environment[key];
      rpc = startOmpProcess({ executablePath: binary!, workingDirectory: cwd,
        arguments: ['--mode', 'rpc', '--provider', 'cindy', '--model', 'omp-test-model', '--config', config,
          '--no-extensions', '--no-skills', '--no-rules', '--session', originalFile], environment,
        terminateProcessTree(child) { child.kill(); }, onEvent() {}, onState() {},
      });
      await vi.waitFor(() => expect(rpc!.getState()).toBe('ready'), { timeout: 15000 });
      const before = await rpc.client.request({ type: 'get_state' }).response;
      expect(before.data).toMatchObject({ sessionFile: originalFile, model: { id: 'omp-test-model', provider: 'cindy' } });
      const beforeTree = await rpc.client.request({ type: 'get_tree' }).response;
      expect(beforeTree.data).toMatchObject({ leafId: closedRows.at(-1).id });
      const fork = await rpc.client.request({ type: 'fork', entryId: forkEntry }).response;
      expect(fork.data).toMatchObject({ cancelled: false });
      const after = await rpc.client.request({ type: 'get_state' }).response;
      const nextFile = (after.data as { sessionFile: string }).sessionFile;
      expect(path.isAbsolute(nextFile)).toBe(true); expect(nextFile).not.toBe(originalFile);
      expect(after.data).toMatchObject({ model: { id: 'omp-test-model', provider: 'cindy' } });
      expect(await readFile(originalFile)).toEqual(originalBytes);
      const afterTree = await rpc.client.request({ type: 'get_tree' }).response;
      expect((afterTree.data as { leafId: string }).leafId).toBe(forkEntry);
      expect(await rpc.stopAndWait()).toBe(true); rpc = undefined;
      const reopened = await openNative(nextFile);
      session = new Session({ id: 'fixture-task', agentKind: 'omp', workDir: cwd, handle: reopened, logger, turnStallMs: 0, capabilities: {} as never });
      expect(reopened.id).toBe(nextFile);
      expect(reopened.presentation!.state().generation).not.toBe(handle.presentation!.state().generation);
      await reopened.restoreNativeEditorDraft!(draft);
      expect(await reopened.readNativeEditorDraft!()).toBe(draft);
      const recovered = await reopened.readSessionTree!();
      expect(recovered.messages).toEqual(restored.messages.map(message => {
        const source = message.agentMeta?.nativeSource as import('@cindy/maker-shared/message-presentation').NativeMessageSource | undefined;
        return source ? { ...message, agentMeta: { ...message.agentMeta, nativeSource: { ...source, sessionId: nextFile,
          ...(source.bridge ? { bridge: { ...source.bridge, sessionId: nextFile } } : {}) } } } : message;
      }));
      expect(recovered.contextWindow).toBe(restored.contextWindow);
      expect(bodies).toHaveLength(3);
      process.stdout.write(JSON.stringify({ nativeOmpRpcHistory: { forkCount: 1, originalHistoryUnchanged: true,
        modelAndProviderReadback: true, nativeExitConfirmed: true, nativeReopened: true, draftRestored: true,
        actualHistoryProjectionPreserved: true, requests: bodies.length } }) + newline);
      return;
    }
    await session.send('CANCEL_ROOT');
    await vi.waitFor(() => expect(bodies).toHaveLength(4), { timeout: 15000 });
    const cancelled = session.steer('MUST_NOT_REPLAY', { [GUI_NATIVE_APPEND]: true, messageUuid: 'stop-pending' });
    void cancelled.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 250));
    await session.abort();
    await expect(cancelled).rejects.toThrow();
    // Check an actual later time window: native ctx.abort alone was proven to
    // drain queued custom messages. No new provider request may escape here.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(bodies).toHaveLength(4);
    process.stdout.write(JSON.stringify({ nativeOmpSteer: { batch, requests: bodies.length, receipts: receipt.mock.calls.length,
      consumption: native.map(input => input.consumption!.read()), usage: handle.getUsageSnapshot!(),
      nativeBillingHeaders: bodies.map(body => body.system[0].text) } }) + newline);
  } catch (error) {
    if (batch) process.stdout.write(JSON.stringify({ nativeBatchContexts: await readFile(batchTrace, 'utf8').catch(() => 'unavailable') }) + newline);
    if (nativeFile) process.stdout.write(JSON.stringify({ nativeBatchJournal: await readFile(nativeFile, 'utf8').catch(() => 'unavailable') }) + newline);
    throw error;
  } finally {
    await rpc?.stopAndWait(); await session?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
