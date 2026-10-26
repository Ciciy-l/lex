/** Opt-in pinned OMP + production factory/Host journal, with private data and loopback only. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { OmpAgent, Session, buildOmpCindyModelsYaml, type AgentDeps, type Logger } from '@cindy/maker-core';
import { createOmpNativeHostSession } from '../omp-native-host.js';
import { createNativeHistoryHandoff } from '../../maker-ipc/nativeHistoryHandoff.js';
import { withNativeHistoryOperation } from '../../maker-ipc/nativeHistoryOperation.js';
import { nativeHistoryStartupTarget } from '../../maker-ipc/nativeHistoryJournal.js';

const binary = process.env.CINDY_TEST_OMP_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
it.skipIf(!binary)('recovers one OMP fork through the production factory and durable Host journal after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-omp-history-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), journalRoot = path.join(root, 'history-handoffs');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8'); // Decode split UTF-8 sequences across network chunks.
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw); requests.push(body);
    const frames = [
      { type: 'message_start', message: { id: 'fixture', role: 'assistant', type: 'message', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_COMPLETE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map(frame => 'event: ' + frame.type + '\n' + 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  });
  let session: Session | undefined;
  const nativeRuns: Array<{ resume?: string; exited: boolean; model: string; permission: string }> = [];
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture endpoint');
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const deps: AgentDeps = {
      binaryPath: binary!, logger, runtimeConfig: {},
      auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; }, async logout() {}, async getAuthEnv() { return {}; } },
      resolveOmpAgentHome: () => home,
      resolveOmpExecutableEnvironment: () => ({ systemRoot: process.env.SystemRoot, path: process.env.PATH }),
      resolveOmpCredentials: () => ({ proxyKey: 'invalid-loopback-fixture', sessionId: 'history-task' }),
      resolveOmpModelsYaml: context => buildOmpCindyModelsYaml({ baseUrl: 'http://127.0.0.1:' + address.port,
        api: 'anthropic-messages', sessionId: 'history-task', models: [{ id: context.model, name: context.model,
          input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 4096 }] }),
      async createLocalOmpNativeSession(options) {
        expect(nativeRuns.every(run => run.exited)).toBe(true);
        const run = { resume: options.resumeSessionId, exited: false, model: options.model, permission: options.permissionMode }; nativeRuns.push(run);
        return createOmpNativeHostSession(options, spec => {
          const child = pty.spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, name: 'xterm-256color', cols: 100, rows: 30 });
          const exit = new Promise<void>(resolve => child.onExit(() => { run.exited = true; resolve(); }));
          child.onData((data: string) => {
            if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
            if (data.includes('\x1b[c')) child.write('\x1b[?1;2c');
          });
          return { pid: child.pid, write: (data: string) => child.write(data), resize: (cols: number, rows: number) => child.resize(cols, rows),
            onData(listener) { const sub = child.onData(listener); return () => sub.dispose(); },
            onExit(listener) { const sub = child.onExit((event: { exitCode: number }) => listener({ code: event.exitCode })); return () => sub.dispose(); },
            async close() {
              if (!run.exited) child.write('\x03');
              await new Promise(resolve => setTimeout(resolve, 100));
              if (!run.exited) child.write('\x03');
              for (let index = 0; index < 20 && !run.exited; index++) await new Promise(resolve => setTimeout(resolve, 50));
              if (!run.exited) child.kill(); await exit;
            },
          };
        });
      },
    };
    const agent = new OmpAgent(deps);
    const start = async (resumeSessionId?: string) => {
      const handle = await agent.startSession({ sessionId: 'history-task', workingDir: cwd, model: 'omp-test-model',
        permissionMode: 'ask', effort: 'high', nativePresentation: true, resumeSessionId });
      session = new Session({ id: 'history-task', agentKind: 'omp', workDir: cwd, handle, logger, turnStallMs: 0, capabilities: agent.capabilities });
      return handle;
    };
    const handle = await start();
    const source = handle.id;
    await session!.send('FIRST');
    await vi.waitFor(() => { expect(requests).toHaveLength(1); expect(session!.isTurnRunning()).toBe(false); }, { timeout: 15000 });
    const before = await handle.readSessionTree!();
    const selected = before.tree.leafId!;
    await handle.restoreNativeEditorDraft!('UNSENT_NATIVE_DRAFT');
    const spend = handle.getUsageSnapshot();
    const handoff = createNativeHistoryHandoff({ root: journalRoot, session: session!, assertCurrent() {},
      exclusive: operation => withNativeHistoryOperation(journalRoot, session!.id, operation),
      async persist() { throw new Error('synthetic projection failure'); } });
    await expect(handoff.navigate(selected, {})).rejects.toThrow('synthetic projection failure');
    expect(handle.id).not.toBe(source);
    expect(handle.getEffort!()).toBe('high');
    expect(handle.getUsageSnapshot()).toMatchObject({ tokenUsage: spend.tokenUsage, costUsd: spend.costUsd });
    const held = handle.presentation!.attach('peer', () => {}); expect(held.acquireControl()).toBeNull(); held.detach();
    const target = nativeHistoryStartupTarget(journalRoot, { sessionId: 'history-task', nativeId: source, agentKind: 'omp', workingDir: cwd, model: 'omp-test-model' });
    expect(target).toMatchObject({ source, target: handle.id, pending: true });
    await session!.close();
    const reopened = await start(target.target);
    const persist = vi.fn(async () => 'committed');
    const recovery = createNativeHistoryHandoff({ root: journalRoot, session: session!, assertCurrent() {}, persist,
      exclusive: operation => withNativeHistoryOperation(journalRoot, session!.id, operation) });
    const peer = reopened.presentation!.attach('recovered', () => {}); expect(peer.acquireControl()).toBeNull();
    const result = await recovery.recover();
    expect(result!.result.nativeIdentity).toEqual({ source, target: target.target });
    expect(result!.result.messages.map(message => message.agentMeta?.uuid)).toEqual(before.messages.map(message => message.agentMeta?.uuid));
    expect(await session!.readNativeEditorDraft()).toBe('UNSENT_NATIVE_DRAFT');
    expect(peer.acquireControl()).not.toBeNull(); peer.detach();
    expect(persist).toHaveBeenCalledOnce(); expect(requests).toHaveLength(1);
    expect(nativeRuns.map(run => run.resume)).toEqual([undefined, target.target, target.target]);
    expect(nativeRuns.every(run => run.model === 'omp-test-model' && run.permission === 'ask')).toBe(true);
    expect(nativeHistoryStartupTarget(journalRoot, { sessionId: 'history-task', nativeId: target.target, agentKind: 'omp', workingDir: cwd, model: 'omp-test-model' }).pending).toBe(false);
    process.stdout.write(JSON.stringify({ ompFactoryHistory: { nativeExecutors: nativeRuns.length, model: reopened.model, permission: 'ask', effort: reopened.getEffort!(),
      requests: requests.length, distinctTarget: source !== target.target, durableRestart: true, draftPreserved: true, mutationReplayed: false } }) + '\n');
  } finally {
    await session?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90000);
