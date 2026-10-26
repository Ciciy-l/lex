import { GUI_NATIVE_APPEND, GUI_NATIVE_BODY } from '../../base-agent.js';
/** Opt-in: actual pinned Pi TUI + product adapter + isolated loopback provider. */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PiAgent } from '../index.js';
import { PiNativeSessionControl } from '../native-session.js';
import { PI_NATIVE_EXTENSION_SOURCE } from '../native-extension-source.js';
import { Session } from '../../../session.js';
import type { AgentDeps } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const binary = process.env.CINDY_TEST_PI_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn(message, data) { process.stdout.write(JSON.stringify({ nativeWarning: message, data }) + String.fromCharCode(10)); }, error() {}, fatal() {}, child() { return logger; } };
const newline = String.fromCharCode(10), escape = String.fromCharCode(27);
function reply(res: ServerResponse, text: string) {
  const frames = [
    { type: 'message_start', message: { id: 'fixture', role: 'assistant', type: 'message', model: 'pi-test-model', content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frames.map(frame => 'event: ' + frame.type + newline + 'data: ' + JSON.stringify(frame) + newline + newline).join(''));
}

it.skipIf(!binary).each([false, true, 'initial' as const, 'restart' as const, 'crossfile' as const, 'mixed' as const, 'delegated-boundary' as const])('Pi TUI consumes one GUI steer without confusing handled extension input (%s)', async handled => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-pi-native-steer-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  const cancelTreeMarker = path.join(root, 'cancel-tree');
  const treeTrace = path.join(root, 'tree-operations.jsonl');
  const lifecycleTrace = path.join(root, 'native-lifecycle.jsonl');
  const checkpointFile = path.join(root, 'host-handoff.json');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, home);
  const bodies: Array<Record<string, any>> = [], responses: ServerResponse[] = [];
  const requestTimes: number[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    responses.push(res); requestTimes.push(performance.now());
    if (bodies.length === 3 && handled !== 'mixed') reply(res, 'second steer consumed');
  });
  let session: Session | undefined;
  let nativeExit: Promise<void> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port');
    const endpoint = 'http://127.0.0.1:' + address.port;
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const deps: AgentDeps = { binaryPath: binary!, logger, runtimeConfig: { endpoint },
      auth: { getState: async () => ({ authenticated: true, authSource: 'api-key' as const }), triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {}, getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'invalid-loopback-fixture' }) },
      resolvePiAgentHome: () => home, resolvePiGlobalContextHome: () => home, resolvePiGatewayModelApi: () => 'anthropic-messages',
      capabilityAdditions: { availableModels: [{ id: 'pi-test-model', displayName: 'Fixture', contextWindow: 200000, efforts: [], defaultEffort: null }] },
      async createLocalPiNativeSession(options) {
        const interception = handled === true || handled === 'initial' ? [
          'let replaced = false;',
          "pi.on('input', event => {",
          "  if (!replaced && event.source === 'extension' && event.text === '" + (handled === 'initial' ? 'FIRST' : 'STEER') + "') {",
          '    replaced = true;',
          "    setTimeout(() => pi.sendUserMessage('INDEPENDENT_EXTENSION_INPUT', { deliverAs: 'steer' }), 20);",
          "    return { action: 'handled' };",
          '  }',
          '});',
        ].join(newline) : '';
        let source = PI_NATIVE_EXTENSION_SOURCE;
        if (handled === 'crossfile') {
          const trace = (value: string) => 'appendFileSync(' + JSON.stringify(lifecycleTrace) + ', JSON.stringify(' + value + ') + String.fromCharCode(10));';
          source = source.replace('export default function (pi) {', 'export default function (pi) {' + trace("{phase:'factory'}"))
            .replace("const fail = (phase = 'transport') => {", "const fail = (phase = 'transport') => {" + trace("{phase:'fail', reason:phase}"))
            .replace("pi.on('session_start', (_event, ctx) => {", "pi.on('session_start', (_event, ctx) => {" + trace("{phase:'start', event:_event, previousContext:!!context}"))
            .replace("pi.on('session_shutdown', async event => {", "pi.on('session_shutdown', async event => {" + trace("{phase:'shutdown', event, command:treeCommand?.payload.type}"))
            .replace('withSession: async next => {', 'withSession: async next => {' + trace("{phase:'withSession', file:next.sessionManager.getSessionFile()}"))
            .replace('} catch { retiring = true; result(command, { ok: false }); }', '} catch (error) {' + trace("{phase:'forkError', error:String(error)}") + 'retiring = true; result(command, { ok: false }); }');
        }
        if (handled === 'mixed') source = source.replace("steering ? { deliverAs: 'steer' } : { triggerTurn: true });",
          "steering ? { deliverAs: 'steer' } : { triggerTurn: true });" + newline +
          "if (!steering) pi.sendUserMessage(command.payload.text, {deliverAs:'steer'});");
        await writeFile(options.extensionPath, "import { existsSync, appendFileSync } from 'node:fs';" + newline + source.replace('export default function (pi) {',
          'export default function (pi) {' + newline + interception + newline +
          "pi.on('session_before_tree', event => { appendFileSync(" + JSON.stringify(treeTrace) + ", JSON.stringify(event) + String.fromCharCode(10)); return existsSync(" + JSON.stringify(cancelTreeMarker) + ") ? {cancel:true} : undefined; });"));
        return new PiNativeSessionControl({ ...options, async launch(environment) {
          const env: Record<string, string> = {};
          for (const key of Object.keys(options.env)) {
            if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)
                || /^(CINDY_PI_|PI_)/.test(key)) env[key] = options.env[key]!;
          }
          Object.assign(env, environment, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'),
            LOCALAPPDATA: path.join(home, 'local'), XDG_CONFIG_HOME: path.join(home, '.config'), NO_PROXY: '127.0.0.1,localhost' });
          const child = pty.spawn(options.executable, [...options.args.slice(2), '--extension', options.extensionPath,
            ...(options.resumeSessionId ? ['--session', options.resumeSessionId] : [])],
            { cwd, env, name: 'xterm-256color', cols: 100, rows: 30 });
          let exited = false;
          let terminalTail = '';
          nativeExit = new Promise<void>(resolve => child.onExit((exit: unknown) => {
            if (handled === 'crossfile') process.stdout.write(JSON.stringify({ piNativeExit: exit, terminalTail }) + newline);
            exited = true; resolve();
          }));
          child.onData((data: string) => {
            terminalTail = (terminalTail + data).slice(-6000);
            if (data.includes(escape + '[6n')) child.write(escape + '[1;1R');
            if (data.includes(escape + '[c')) child.write(escape + '[?1;2c');
          });
          return { pid: child.pid, write: (data: string) => child.write(data), resize: (cols: number, rows: number) => child.resize(cols, rows),
            onData: (listener: (data: string) => void) => { const sub = child.onData(listener); return () => sub.dispose(); },
            onExit: (listener: (exit: { code: number }) => void) => { const sub = child.onExit((exit: { exitCode: number }) => listener({ code: exit.exitCode })); return () => sub.dispose(); },
            async close() {
              if (!exited) { child.write(String.fromCharCode(3)); await new Promise(resolve => setTimeout(resolve, 100)); child.write(String.fromCharCode(3)); }
              for (let i = 0; i < 20 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
              if (!exited) child.kill(); await nativeExit;
            },
          };
        } });
      },
    };
    const agent = new PiAgent(deps);
    const handle = await agent.startSession({ sessionId: 'native-steer-fixture', nativePresentation: true, workingDir: cwd, model: 'pi-test-model' });
    const events: AgentEvent[] = [];
    session = new Session({ id: 'native-steer-fixture', agentKind: 'pi', workDir: cwd, handle, logger, turnStallMs: 0,
      capabilities: { sameTurnSteer: { supported: true } } as never });
    session.onEvent(event => events.push(event));
    const nativeInputs: import('../../native-input.js').AgentNativeInputRequest[] = [];
    const independentReceipt = vi.fn();
    session.onNativeInput(async input => {
      nativeInputs.push(input);
      try {
        if (input.nativeTurnId) await session!.acceptNativeSteer(input, { onNativeUserMessage: independentReceipt });
        else await session!.acceptNativeInput(input, { onNativeUserMessage: independentReceipt });
      } catch (error) {
        process.stdout.write(JSON.stringify({ nativeInputFailure: { turn: input.nativeTurnId, message: String(error), events } }) + newline);
        throw error;
      }
    });
    const receipt = vi.fn();
    const initialReceipt = vi.fn();
    if (handled === 'delegated-boundary') {
      await expect(session.send('SYNTHETIC_ORCA_ASSIGNMENT', { messageUuid: 'delegated-message',
        onNativeUserMessage: initialReceipt, throwOnStartFailure: true })).resolves.toMatchObject({ accepted: false, reason: 'provider-rejected-before-dispatch' });
      expect(initialReceipt).not.toHaveBeenCalled(); expect(bodies).toHaveLength(0);
      expect(session.isTurnRunning()).toBe(false);
      process.stdout.write(JSON.stringify({ piDelegatedBoundary: { sent: false, requests: bodies.length,
        reason: 'Current authorized custom route is GUI only; Orca idle assignment needs a separate explicit host route' } }) + newline);
      return;
    }
    await session.send('FIRST', { [GUI_NATIVE_BODY]: true, messageUuid: 'initial-message', onNativeUserMessage: initialReceipt });
    if (handled === 'mixed') {
      await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
      const turnId = handle.getCurrentTurnId!();
      expect(initialReceipt).toHaveBeenCalledOnce(); expect(independentReceipt).not.toHaveBeenCalled();
      // Pi drains the immediately queued native message into the FIRST
      // provider context. Both distinct journal rows must be admitted before
      // this one request, even when agent_start delivery is still pending.
      expect(nativeInputs).toHaveLength(1);
      expect(handle.getCurrentTurnId!()).toBe(turnId);
      expect(nativeInputs[0]!.nativeTurnId).toBe(turnId);
      expect(nativeInputs[0]!.nativeMessageId).not.toBe(initialReceipt.mock.calls[0]![0].messageId);
      const texts = bodies[0]!.messages.flatMap((message: any) => typeof message.content === 'string'
        ? [message.content] : message.content.map((part: any) => part.text));
      expect(texts.filter((text: string) => text === 'FIRST')).toHaveLength(2);
      reply(responses[0]!, 'both independent rows consumed');
      await vi.waitFor(() => expect(session!.isTurnRunning()).toBe(false), { timeout: 15000 });
      const rows = (await readFile(handle.id, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(rows.find(row => row.id === initialReceipt.mock.calls[0]![0].messageId)).toMatchObject({ type: 'custom_message', details: { submissionId: 'initial-message' } });
      expect(rows.find(row => row.id === nativeInputs[0]!.nativeMessageId)).toMatchObject({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'FIRST' }] } });
      expect(initialReceipt).toHaveBeenCalledOnce();
      expect(JSON.stringify(bodies[0]!.messages)).not.toContain('submissionId');
      expect(bodies).toHaveLength(1);
      process.stdout.write(JSON.stringify({ nativePiMixed: { gui: initialReceipt.mock.calls, independent: nativeInputs[0]!.source, requests: bodies.length, sameTurn: true } }) + newline);
      return;
    }
    if (handled === 'initial') {
      process.stdout.write(JSON.stringify({ initialHandledInput: { receipt: initialReceipt.mock.calls, requests: bodies.length } }) + newline);
      expect(initialReceipt).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
      reply(responses[0]!, 'initial custom consumed');
      await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true), { timeout: 15000 });
      // A fresh Pi journal flushes to disk after its first assistant output.
      const journal = (await readFile(handle.id, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      const actual = journal.find(row => row.id === initialReceipt.mock.calls[0]![0].messageId);
      expect(actual).toMatchObject({ type: 'custom_message', customType: 'lex-gui-append', content: 'FIRST', details: { submissionId: 'initial-message' } });
      await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
      expect(JSON.stringify(bodies[0]!.messages)).toContain('FIRST');
      expect(JSON.stringify(bodies[0]!.messages)).not.toContain('INDEPENDENT_EXTENSION_INPUT');
      expect(JSON.stringify(bodies[0]!.messages)).not.toContain('submissionId');
      return;
    }
    await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
    const started = performance.now();
    const steering = session.steer('STEER', { [GUI_NATIVE_APPEND]: true, messageUuid: 'steer-message', onNativeUserMessage: receipt });
    void steering.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(receipt).not.toHaveBeenCalled();
    reply(responses[0]!, 'first response');
    await steering;
    await vi.waitFor(() => expect(bodies).toHaveLength(2), { timeout: 15000 });
    const secondReceipt = vi.fn();
    const repeat = session.steer('STEER', { [GUI_NATIVE_APPEND]: true, messageUuid: 'second-steer-message', onNativeUserMessage: secondReceipt });
    void repeat.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150)); expect(secondReceipt).not.toHaveBeenCalled();
    reply(responses[1]!, 'first steer consumed'); await repeat;
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true), { timeout: 15000 });
    if (handled === true) {
      process.stdout.write(JSON.stringify({ handledExtension: { requests: bodies.length, receipts: receipt.mock.calls,
        providerMessages: bodies[1]!.messages } }) + newline);
      // The approved GUI channel bypasses input hooks. Its receipt must come
      // from its own custom row, never the hook's independent user message.
      expect(JSON.stringify(bodies[1]!.messages)).not.toContain('INDEPENDENT_EXTENSION_INPUT');
    }
    expect(bodies).toHaveLength(3); expect(receipt).toHaveBeenCalledOnce(); expect(secondReceipt).toHaveBeenCalledOnce();
    expect(JSON.stringify(bodies[1]!.messages)).toContain('STEER');
    const rows = (await readFile(handle.id, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const appended = rows.filter(row => row.type === 'custom_message' && row.customType === 'lex-gui-append' && row.details.submissionId !== 'initial-message');
    expect(appended).toHaveLength(2);
    expect(appended[0].details.submissionId).toBe('steer-message');
    expect(receipt.mock.calls[0]![0].messageId).toBe(appended[0].id);
    expect(secondReceipt.mock.calls[0]![0].messageId).toBe(appended[1].id);
    expect(appended[1].details.submissionId).toBe('second-steer-message');
    expect(appended[1].id).not.toBe(appended[0].id);
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain('submissionId');
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain('steer-message');
    expect(bodies[0]!.system).toEqual(bodies[1]!.system);
    expect(bodies[0]!.tools).toEqual(bodies[1]!.tools);
    const usage = handle.getUsageSnapshot!();
    expect(usage).toMatchObject({ tokenUsage: 51, contextTokens: 30, outputTokens: 21 });
    const firstFile = handle.id, screen = handle.presentation!.attach('fixture-controller', () => {});
    expect(screen.acquireControl()).not.toBeNull();
    const assistantLeaf = rows.findLast(row => row.type === 'message' && row.message?.role === 'assistant').id;
    const committed = await session.navigateSessionTreeAndPersist(assistantLeaf, {}, async result => {
      expect(screen.acquireControl(true)).toBeNull();
      expect(result.messages.some(message => message.agentMeta?.uuid === appended[0].id)).toBe(true);
      return result.tree.leafId;
    });
    expect(committed.result.tree.activePathIds).toContain(appended[0].id);
    const edited = await session.navigateSessionTreeAndPersist(appended[0].id, {}, async result => result.tree.leafId);
    expect(edited.result.tree.activePathIds).not.toContain(appended[0].id);
    expect(edited.result.draftText).toBe('STEER');
    await writeFile(cancelTreeMarker, 'cancel this native history operation');
    const cancelledTree = await session.navigateSessionTreeAndPersist(appended[1].id, {}, async result => result.tree.leafId);
    expect(cancelledTree.result.cancelled).toBe(true);
    expect(cancelledTree.result.draftText).toBeUndefined();
    expect(cancelledTree.result.tree.leafId).toBe(edited.result.tree.leafId);
    expect(handle.id).toBe(firstFile); expect(screen.acquireControl()).not.toBeNull(); screen.detach();
    expect(bodies).toHaveLength(3);
    if (handled === 'restart' || handled === 'crossfile') {
      await rm(cancelTreeMarker);
      await handle.restoreNativeEditorDraft!('UNSENT_NATIVE_DRAFT');
      expect(await session.readNativeEditorDraft()).toBe('UNSENT_NATIVE_DRAFT');
      let checkpoint: { entryId: string; nativeId: string; targetNativeId?: string; nativeDraft?: string; draftText?: string; cancelled?: boolean };
      await expect(session.navigateSessionTreeAndPersist(assistantLeaf, { fork: handled === 'crossfile' }, async () => { throw new Error('synthetic host persistence failure'); }, {
        async beforeNavigate() {
          checkpoint = { entryId: assistantLeaf, nativeId: handle.id, nativeDraft: await session!.readNativeEditorDraft() };
          await writeFile(checkpointFile, JSON.stringify(checkpoint));
        },
        async afterNavigate(result) {
          checkpoint = { ...checkpoint, draftText: result.draftText, cancelled: result.cancelled };
          await writeFile(checkpointFile, JSON.stringify(checkpoint));
        },
        async beforeReplacement() {},
        async target(nativeId) {
          checkpoint.targetNativeId = nativeId;
          await writeFile(checkpointFile, JSON.stringify(checkpoint));
        },
      })).rejects.toThrow('synthetic host persistence failure');
      const originalState = await handle.readSessionTree!();
      const mutationTrace = await readFile(treeTrace, 'utf8');
      await session.close(); await nativeExit;
      const reopened = await agent.startSession({ sessionId: 'native-steer-fixture', nativePresentation: true,
        workingDir: cwd, model: 'pi-test-model', resumeSessionId: checkpoint!.targetNativeId ?? firstFile });
      session = new Session({ id: 'native-steer-fixture', agentKind: 'pi', workDir: cwd, handle: reopened, logger, turnStallMs: 0,
        capabilities: { sessionTree: { supported: true } } as never });
      const disk = JSON.parse(await readFile(checkpointFile, 'utf8'));
      session.restoreSessionTreeHandoff(disk);
      const peer = reopened.presentation!.attach('reopened-peer', () => {});
      expect(peer.acquireControl()).toBeNull();
      await session.restoreNativeEditorDraft(disk.nativeDraft);
      const recovery = await session.navigateSessionTreeAndPersist(disk.entryId, {}, async result => result.tree.leafId);
      expect(reopened.id).toBe(disk.targetNativeId ?? firstFile); expect(recovery.result.tree).toEqual(originalState.tree);
      if (handled === 'crossfile') {
        expect(reopened.id).not.toBe(firstFile);
        expect(recovery.result.nativeIdentity).toEqual({ source: firstFile, target: disk.targetNativeId });
      }
      expect(recovery.result.messages).toEqual(originalState.messages);
      expect(await session.readNativeEditorDraft()).toBe('UNSENT_NATIVE_DRAFT');
      expect(await readFile(treeTrace, 'utf8')).toBe(mutationTrace);
      expect(peer.acquireControl()).not.toBeNull(); peer.detach();
      expect(bodies).toHaveLength(3);
      process.stdout.write(JSON.stringify({ nativePiRestart: { crossfile: handled === 'crossfile', nativeIdUnchanged: handled !== 'crossfile', mutationRepeated: false,
        draftRestored: true, requests: bodies.length, contextTokens: recovery.result.contextTokens,
        contextWindow: recovery.result.contextWindow } }) + newline);
      return;
    }
    const beforeCancel = events.filter(event => event.type === 'done').length;
    await session.send('CANCEL_ROOT', { [GUI_NATIVE_BODY]: true });
    await vi.waitFor(() => expect(bodies).toHaveLength(4), { timeout: 15000 });
    const canceled = session.steer('MUST_NOT_REPLAY', { [GUI_NATIVE_APPEND]: true }); void canceled.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 250));
    await session.abort();
    await expect(canceled).rejects.toThrow();
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done').length).toBeGreaterThan(beforeCancel));
    expect(bodies).toHaveLength(4);
    process.stdout.write(JSON.stringify({ nativePiSteer: { requests: bodies.length, receipts: receipt.mock.calls.length,
      prefixSHA256: createHash('sha256').update(JSON.stringify([bodies[0]!.system, bodies[0]!.tools])).digest('hex'),
      firstToConsumedMs: requestTimes[1]! - started, usage, doneCount: events.filter(event => event.type === 'done').length } }) + newline);
  } finally {
    await session?.close();
    if (handled === 'crossfile') process.stdout.write(JSON.stringify({ piLifecycle: await readFile(lifecycleTrace, 'utf8').catch(() => '') }) + newline);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
