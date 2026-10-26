/** Real pinned frontends + Main MCP/dispatcher/queue + Core Session. Store/provider are synthetic. */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unsupportedOrcaService } from './unsupportedOrcaService.fixture.js';
import { expect, it, vi } from 'vitest';
import { OmpAgent, buildOmpCindyModelsYaml, Session, ORCA_NATIVE_BODY, type OrcaNativeBodySource, type AgentDeps, type Logger, type Maker } from '@cindy/maker-core';
import type { NativeMessageSource } from '@cindy/maker-shared/message-presentation';
import { createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow';
import { createLiziMcpProviders, type OrcaMcpDeps } from '@cindy/mcps';
import { createOmpNativeHostSession } from '../omp-native-host.js';

import { createOrcaInterAgentDispatcher } from '../../maker-ipc/orcaInterAgentDispatcher.js';
import { AgentInputCoordinator } from '../../maker-ipc/agent-input-coordinator.js';
import { createOrcaTeamService, type OrcaTeamServiceDeps, type OrcaWorkerStatus } from '../../maker-ipc/orcaTeamService.js';

vi.mock('../plugins/index.js', () => ({ createPluginRegistry: () => ({ isEnabled: () => true, getDisabledRuntimePluginIds: () => [] }) }));
const binary = process.env.CINDY_TEST_OMP_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn(message, data) { process.stdout.write(JSON.stringify({ warning: message, data }) + '\n'); }, error() {}, fatal() {}, child() { return logger; } };

it.skipIf(!binary)('OMP native Worker receives distinct idle/queued Orca inputs and reports through the actual Main MCP dispatcher', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-omp-orca-dispatch-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, home);
  const sessions = new Map<string, Session>(), bodies: any[] = [], responses: ServerResponse[] = [];
  const rows = new Map<string, { sessionId: string; content: string; source?: NativeMessageSource }>();
  const approvals: string[] = [], outcomes: unknown[] = [];
  let terminalTail = ''; const nativeDialogs: string[] = [];
  const approvedNativeCalls = new Set<number>(), approvalTimers = new Set<ReturnType<typeof setTimeout>>();
  let coordinator: AgentInputCoordinator | undefined, counter = 0;
  let active = true;
  let workerStatus: OrcaWorkerStatus = 'idle';
  let manualInterrupt: { markedAt: number; reason: string } | null = null;
  const terminalTasks: Promise<void>[] = [];
  const role = (id: string) => ({ orcaRole: id === 'lead-task' ? 'lead' : 'worker', orcaLeadSessionId: 'lead-task',
    orcaWorkflowId: 'team-1', ...(id === 'worker-task' ? { orcaWorkerId: 'worker-1', orcaWorkerSessionId: id } : {}) });
  const source = (id: string, clientId: string): OrcaNativeBodySource => ({ version: 1, targetSessionId: id, clientId,
    role: id === 'lead-task' ? 'lead' : 'worker', leadSessionId: 'lead-task', teamId: 'team-1',
    ...(id === 'worker-task' ? { workerId: 'worker-1' } : {}) });
  const assertSource = async (value: OrcaNativeBodySource) => {
    expect(value).toEqual(source(value.targetSessionId, value.clientId));
    if (!active) throw new Error('synthetic team retired');
  };
  const link = (id: string, clientId: string) => async (value: NativeMessageSource) => {
    const row = rows.get(clientId); expect(row?.sessionId).toBe(id);
    expect(value.bridge?.submissionId).toBe(clientId); row!.source = value; return true;
  };
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8'); // Decode split UTF-8 sequences across network chunks.
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    bodies.push(JSON.parse(raw)); responses.push(res);
  });
  const reply = (index: number, tool?: { name: string; args: unknown }) => {
    const frames = [
      { type: 'message_start', message: { id: 'fixture-' + index, role: 'assistant', type: 'message', model: bodies[index].model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-' + index, name: tool.name, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text: 'SYNTHETIC_DONE_' + index } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    responses[index]!.writeHead(200, { 'content-type': 'text/event-stream' });
    responses[index]!.end(frames.map(frame => 'event: ' + frame.type + '\n' + 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  };
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture endpoint');
    const createOpts = (id: string) => ({ agentKind: 'omp' as const, workingDir: cwd, model: 'omp-test-model', permissionMode: 'ask', vendorOptions: role(id) });
    const dispatcher = createOrcaInterAgentDispatcher({
      createId: () => 'orca-' + ++counter, getSessionMeta: async id => createOpts(id),
      getSessionRowSnapshot: async () => ({ title: 'Synthetic task', status: 'active', userSendAt: null }),
      getLiveSession: id => sessions.get(id), shouldQueueNewTurn: id => coordinator!.shouldQueueNewTurn(id),
      hasSendToSessionLock: () => false, buildCreateOptsForQueuedSession: async id => createOpts(id),
      enqueueQueuedMessage: (id, item) => coordinator!.enqueue(id, item),
      reserveNextQueuedMessage: async (id, item, onReserved, beforeReserve) => { await beforeReserve?.(); return coordinator!.reserveNextInput(id, item, { onReserved }).reserved; },
      sendToSessionInternal: async () => { throw new Error('Unexpected cold dispatch'); },
      createDbMessage: async (sessionId, message) => { rows.set(message.clientId, { sessionId, content: message.content }); },
      beginDirectTurnChangeSet: async () => {}, abortDirectTurnChangeSet() {}, resolveWorkerSenderLabel: async () => 'Synthetic worker',
      isSessionRunningError: () => false, captureOrcaNativeBody: async (id, clientId) => source(id, clientId),
      assertOrcaNativeBody: assertSource, captureNativeUserMessageLink: link,
    });
    coordinator = new AgentInputCoordinator({
      sendToAgent: async (id, message, _create, options) => {
        const session = sessions.get(id)!;
        await assertSource(options[ORCA_NATIVE_BODY]!);
        const result = await session.send(message as never, { ...options,
          onNativeUserMessage: async value => { await link(id, options.persistUserMessage!.clientId)(value); },
          onAccepted: async () => {
            const persisted = options.persistUserMessage!;
            rows.set(persisted.clientId, { sessionId: id, content: persisted.content });
            await persisted.onPersisted?.();
          },
        });
        if (!result.accepted) throw new Error('Native dispatch rejected: ' + JSON.stringify(result));
        const outcome = { kind: 'session-dispatch' as const, source: 'fixture-main', dispatched: true as const };
        await dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(id, options, outcome);
        return outcome;
      },
      steerToAgent: async () => { throw new Error('Delegated steer must not run'); },
      abortSession: async id => { await sessions.get(id)!.abort(); },
      isTurnRunning: id => sessions.get(id)?.isTurnRunning() ?? false,
      getTurnSessionIdentity: id => sessions.get(id) ?? null, getTurnGeneration: id => sessions.get(id)?.getTurnGeneration() ?? null,
      hasPendingInteraction: () => false, getAgentKind: () => 'omp', getSdkSessionId: async id => sessions.get(id)?.sdkSessionId,
      emitProjection() {}, onAcceptedQueuedMessage: (id, item) => dispatcher.runQueuedOrcaInterAgentAcceptedCallback(id, item),
    });
    const workerLink = { workerId: 'worker-1', teamId: 'team-1', workerSessionId: 'worker-task', leadSessionId: 'lead-task' };
    const service = createOrcaTeamService(new Proxy({
      ...unsupportedOrcaService,
      captureControlAuthority: async (id: string) => async () => {
        if (!active || id !== 'lead-task') throw new Error('Synthetic authority retired');
      },
      getWorkerLinkBySessionId: async (id: string) => id === 'worker-task' ? workerLink : null,
      getWorkerLinkByWorkerId: async (id: string) => id === 'worker-1' ? workerLink : null,
      listWorkersByLead: async (id: string) => id !== 'lead-task' ? [] : [{ id: 'worker-1', teamId: 'team-1', leadSessionId: id,
        sessionId: 'worker-task', status: workerStatus, label: 'Synthetic worker', role: 'developer', focused: false, idleSince: null,
        session: { title: 'Synthetic worker', agentKind: 'omp', model: 'omp-test-model', effort: null, permissionMode: 'ask', fastMode: false } }],
      getLiveSession: (id: string) => sessions.get(id) ?? null,
      updateWorkerStatus: async (_id: string, value: OrcaWorkerStatus) => { workerStatus = value; },
      markWorkerIdle: async () => { workerStatus = 'idle'; },
      getManualInterrupt: () => manualInterrupt, clearManualInterrupt() { manualInterrupt = null; }, broadcastOrcaWorkerChanged() {},
      restoreManualInterrupt(_id: string, value: typeof manualInterrupt) { manualInterrupt = value; }, onLeadWorkerReportsSettled() {},
      hasPendingWorkerInput: async (id: string) => coordinator!.shouldQueueNewTurn(id),
      hasSendToSessionLock: () => false,
      dispatchWorkerMessage: async (params: Parameters<OrcaTeamServiceDeps['dispatchWorkerMessage']>[0]) => {
        const result = await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ targetSessionId: params.targetSessionId, rawContent: params.message,
          source: 'lead', senderLabel: 'Lead', workerId: params.workerId, delivery: params.delivery, meta: params.dispatchMeta,
          onAccepted: params.onAccepted, onAcceptedCommit: params.onAcceptedCommit, onAcceptedRollback: params.onAcceptedRollback });
        return result.ok ? { ...result, targetTitle: result.targetTitle ?? null, targetLastUserSendAt: result.targetLastUserSendAt ?? null } : result;
      },
      reserveWorkerMessage: async (params: Parameters<OrcaTeamServiceDeps['reserveWorkerMessage']>[0]) => {
        const result = await dispatcher.reserveNextOrcaInterAgentMessage({ targetSessionId: params.targetSessionId, rawContent: params.message,
          source: 'lead', senderLabel: 'Lead', workerId: params.workerId, meta: params.dispatchMeta,
          beforeReserve: params.beforeReserve, onReserved: params.onReserved,
          onAccepted: params.onAccepted, onAcceptedCommit: params.onAcceptedCommit, onAcceptedRollback: params.onAcceptedRollback });
        return result.ok ? { ...result, targetTitle: result.targetTitle ?? null, targetLastUserSendAt: result.targetLastUserSendAt ?? null } : result;
      },
      requestWorkerInterrupt: async (id: string) => {
        manualInterrupt = { markedAt: Date.now(), reason: 'lead_interrupt' };
        const result = await sessions.get(id)!.requestGracefulStop();
        return { stopOutcome: result.status, queuePaused: coordinator!.getProjection(id).queuePaused };
      },
      getWorkerQueuePaused: (id: string) => coordinator!.isQueuePaused(id),
      sendAutoBridgeToLead: async (id: string, message: string, workerId: string) => {
        const result = await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ targetSessionId: id, rawContent: message,
          source: 'worker', senderLabel: 'Worker', workerId, meta: { source: 'fixture', context: 'auto-bridge' } });
        outcomes.push(result); return { accepted: result.ok };
      },
      log: logger,
    }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => { throw new Error('Unexpected service operation ' + String(key)); } }) as OrcaTeamServiceDeps);
    const providers = [...createLiziMcpProviders({ enabled: ['cindy_orca'], orca: new Proxy({}, {
      get: (_target, key) => () => { throw new Error('Unexpected synthetic Lead operation ' + String(key)); },
    }) as OrcaMcpDeps }), createOrcaWorkerBridgeMcpProvider({ logger,
      getMaker: () => ({ getSession: (id: string) => sessions.get(id) }) as Maker,
      async persistUserMessage() { throw new Error('Must use production dispatcher'); }, wireSession() {},
      orcaTeamStore: { async getWorkerLink() { return { workerId: 'worker-1', workflowId: 'team-1', workerSessionId: 'worker-task', leadSessionId: 'lead-task',
        leadSession: { sessionId: 'lead-task', agentKind: 'omp', workingDir: cwd, model: 'omp-test-model', permissionMode: 'ask' } }; },
        async updateWorkerStatus(_id, status) { workerStatus = status; } },
      dispatchInterAgentMessage: async params => { const result = await dispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params); outcomes.push(result); return result; },
    })];
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const deps: AgentDeps = { binaryPath: binary!, logger, runtimeConfig: {}, mcpProviders: providers,
      auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; }, async logout() {}, async getAuthEnv() { return {}; } },
      resolveOmpAgentHome: () => home,
      resolveOmpExecutableEnvironment: () => ({ systemRoot: process.env.SystemRoot, path: process.env.PATH }),
      resolveOmpCredentials: () => ({ proxyKey: 'invalid-loopback-fixture', sessionId: 'synthetic-orca' }),
      resolveOmpModelsYaml: options => buildOmpCindyModelsYaml({ baseUrl: 'http://127.0.0.1:' + address.port, api: 'anthropic-messages',
        sessionId: options.sessionId, models: [{ id: options.model, name: options.model, input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 4096 }] }),
      createLocalOmpNativeSession(options) {
        return createOmpNativeHostSession(options, spec => {
          const child = pty.spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, name: 'xterm-256color', cols: 100, rows: 30 });
          let exited = false;
          const exit = new Promise<void>(resolve => child.onExit(() => { exited = true; resolve(); }));
          child.onData((data: string) => {
            terminalTail = (terminalTail + data).slice(-10000);
            if (/approve|deny|allow|permission/i.test(data) && nativeDialogs.length < 12) nativeDialogs.push(data.slice(-5000));
            // This fixture acts as the synthetic terminal user. Production
            // does not auto-approve or relax OMP's original approval mode.
            if (data.includes('Ctrl+Q approve') && !approvedNativeCalls.has(bodies.length)) {
              expect(bodies.length).toBeGreaterThan(0);
              const call = bodies.length;
              approvedNativeCalls.add(call);
              // OMP 18.10.4 ApprovalDialogComponent deliberately ignores
              // approve keys for 500 ms after mount. Respect its arm interval;
              // an immediate synthetic key tests that guard, not approval.
              const timer = setTimeout(() => {
                approvalTimers.delete(timer);
                if (!exited && bodies.length === call) child.write('\x1b[13;5u');
              }, 650);
              approvalTimers.add(timer);
            }
            if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
            if (data.includes('\x1b[c')) child.write('\x1b[?1;2c');
          });
          return { pid: child.pid, write: (text: string) => child.write(text), resize: (cols: number, rows: number) => child.resize(cols, rows),
            onData(listener) { const sub = child.onData(listener); return () => sub.dispose(); },
            onExit(listener) { const sub = child.onExit((event: { exitCode: number }) => listener({ code: event.exitCode })); return () => sub.dispose(); },
            async close() {
              if (!exited) child.write('\x03'); await new Promise(resolve => setTimeout(resolve, 100)); if (!exited) child.write('\x03');
              for (let i = 0; i < 20 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
              if (!exited) child.kill(); await exit;
            },
          };
        });
      },
    };
    const agent = new OmpAgent(deps);
    for (const id of ['lead-task', 'worker-task']) {
      const handle = await agent.startSession({ ...createOpts(id), sessionId: id, sessionInstanceId: id + '-instance', nativePresentation: true, permissionMode: 'ask' });
      const session = new Session({ id, sessionInstanceId: id + '-instance', agentKind: 'omp', workDir: cwd, handle, logger, turnStallMs: 0, capabilities: agent.capabilities });
      sessions.set(id, session);
      handle.setInteractionResolver(async request => { if (request.kind === 'permission') approvals.push(request.toolName); return { kind: 'permission', behavior: 'allow' }; });
      session.onEvent(event => {
        if (id === 'worker-task' && event.type === 'text') service.captureWorkerText(id, String((event.data as { text?: string }).text ?? ''),
          { isFinal: (event.data as { isFinal?: boolean }).isFinal === true });
        if (event.type === 'done') {
          const capture = id === 'worker-task' ? service.captureWorkerTerminalTurn(id) : undefined;
          coordinator!.onTurnEvent(id, 'done');
          if (capture) {
            const task = service.handleWorkerTerminalTurn({ sessionId: id, status: 'done', finalText: '', capture });
            void task.catch(() => {}); terminalTasks.push(task);
          }
        }
      });
    }
    const dispatch = () => service.sendToWorker({ callerLeadSessionId: 'lead-task', targetSessionId: 'worker-task', message: 'SAME_ASSIGNMENT' });
    expect(await service.sendToWorker({ callerLeadSessionId: 'foreign-lead', targetSessionId: 'worker-task', message: 'must refuse' })).toMatchObject({ ok: false });
    expect(await dispatch()).toMatchObject({ ok: true, wakeKind: 'already-active' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 15000 });
    expect(await dispatch()).toMatchObject({ ok: true, wakeKind: 'queued', queuedMessageId: 'orca-2' });
    // The actual OMP catalog supplies the wire name; no Pi discovery API.
    const reportName = bodies[0].tools.find((tool: { name: string }) => tool.name === 'send_to_lead' || tool.name === '_send_to_lead')?.name;
    expect(reportName).toBeDefined();
    reply(0, { name: reportName, args: { worker_id: 'worker-1', message: 'SYNTHETIC_REPORT' } });
    await vi.waitFor(() => expect(bodies).toHaveLength(3), { timeout: 20000 });
    expect(outcomes).toEqual([expect.objectContaining({ ok: true, mode: 'dispatched', clientId: 'orca-3' })]);
    expect(JSON.stringify(bodies[1].messages)).toContain('SYNTHETIC_REPORT');
    reply(1); reply(2);
    await vi.waitFor(() => expect(bodies).toHaveLength(4), { timeout: 20000 }); reply(3);
    await vi.waitFor(() => expect(bodies).toHaveLength(5), { timeout: 15000 }); reply(4);
    await vi.waitFor(() => expect([...sessions.values()].every(session => !session.isTurnRunning())).toBe(true), { timeout: 15000 });
    await Promise.all(terminalTasks);
    expect(outcomes).toHaveLength(2); expect(approvals).toContain('send_to_lead');
    expect(rows.size).toBe(4);
    expect(new Set([...rows.values()].map(row => row.source?.messageId)).size).toBe(4);
    for (const [clientId, row] of rows) {
      expect(row.source?.bridge?.submissionId).toBe(clientId);
      const journal = (await readFile(row.source!.sessionId, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(journal.find(entry => entry.id === row.source!.messageId)).toMatchObject({ type: 'message', message: { role: 'user' } });
    }
    expect(bodies.every(body => !JSON.stringify(body.messages).includes('submissionId'))).toBe(true);
    const sendWorker = (message: string) => service.sendToWorker({ callerLeadSessionId: 'lead-task', targetSessionId: 'worker-task', message });
    expect(await sendWorker('ORIGINAL_BUSY')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(bodies).toHaveLength(6), { timeout: 15000 });
    expect(await sendWorker('PENDING_TAIL')).toMatchObject({ ok: true, wakeKind: 'queued' });
    expect(await service.interruptWorker({ callerLeadSessionId: 'lead-task', targetSessionId: 'worker-task', message: 'PRIORITY_REPLACEMENT' }))
      .toMatchObject({ ok: true, stopOutcome: 'requested', queuePaused: false });
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(7), { timeout: 15000 });
    const lastUser = (body: any) => JSON.stringify(body.messages.filter((message: any) => message.role === 'user').at(-1));
    expect(lastUser(bodies[6])).toContain('PRIORITY_REPLACEMENT');
    // Settle the two replacement turns and their normal auto-reports; the
    // interrupted turn must not auto-report or consume the queued tail first.
    for (let index = 6; index < 10; index++) {
      await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(index), { timeout: 15000 });
      reply(index);
    }
    await vi.waitFor(() => expect([...sessions.values()].every(session => !session.isTurnRunning())).toBe(true), { timeout: 15000 });
    await Promise.all(terminalTasks);
    expect(bodies).toHaveLength(10);
    expect(bodies.slice(6).filter(body => lastUser(body).includes('PENDING_TAIL'))).toHaveLength(1);
    expect(bodies.slice(6).filter(body => lastUser(body).includes('PRIORITY_REPLACEMENT'))).toHaveLength(1);
    expect(outcomes).toHaveLength(4);
    active = false;
    await sessions.get('worker-task')!.setVendorOptions({ orcaRole: null, orcaWorkflowId: null, orcaWorkerId: null, orcaLeadSessionId: null, orcaWorkerSessionId: null });
    expect(await dispatch()).toMatchObject({ ok: false });
    expect(bodies).toHaveLength(10);
    process.stdout.write(JSON.stringify({ ompNativeOrca: { requests: bodies.length, rows: [...rows], approvals, outcomes, revoked: true,
      actual: ['native Worker + Lead', 'Main MCP handlers', 'OrcaTeamService', 'dispatcher', 'coordinator', 'Session'], synthetic: ['DB adapter', 'provider'] } }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ompOrcaFailure: { error: String(error), outcomes, approvals,
      lastMessages: bodies.map(body => body.messages.slice(-2)), rows: [...rows] } }) + '\n');
    throw error;
  } finally {
    for (const id of sessions.keys()) coordinator?.clearSession(id);
    for (const session of sessions.values()) await session.close();
    for (const timer of approvalTimers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90000);
