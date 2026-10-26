/** Pinned OMP, production factory and real Orca handlers; loopback and synthetic host only. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { createLiziMcpProviders, type OrcaMcpDeps } from '@cindy/mcps';
import { createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow';
import { OmpAgent, buildOmpCindyModelsYaml, type AgentDeps, type AgentEvent, type AgentSessionHandle, type Logger } from '@cindy/maker-core';
import { createOmpNativeHostSession } from '../omp-native-host.js';

const binary = process.env.CINDY_TEST_OMP_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn(message, data) { process.stdout.write(JSON.stringify({ warning: message, data }) + '\n'); }, error() {}, fatal() {}, child() { return logger; } };
it.skipIf(!binary).each(['ask', 'bypassPermissions'] as const)('OMP real Orca tools promote, revoke and reenter without dropping the initiating tool receipt (%s)', async permissionMode => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-omp-role-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  let handle: AgentSessionHandle | undefined, context: Record<string, unknown> | undefined;
  let terminalTail = '';
  const nativeDialogs: string[] = [];
  const approvedNativeCalls = new Set<number>();
  const approvalTimers = new Set<ReturnType<typeof setTimeout>>();
  const approvals: string[] = [];
  const roles: unknown[] = [], bodies: any[] = [], events: AgentEvent[] = [];
  const calls = [
    ['start_team', {}], ['end_team', {}], ['end_team', {}],
    ['send_to_lead', { worker_id: 'foreign', message: 'must refuse' }], ['start_team', {}], ['end_team', {}],
  ] as const;
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8'); // Decode split UTF-8 sequences across network chunks.
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw); bodies.push(body);
    const call = calls[bodies.length - 1];
    const wireName = call && body.tools?.find((tool: { name: string }) => tool.name === call[0] || tool.name === '_' + call[0])?.name || call?.[0];
    const frames = [
      { type: 'message_start', message: { id: 'fixture-' + bodies.length, role: 'assistant', type: 'message', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'call-' + bodies.length, name: wireName, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call[1]) } : { type: 'text_delta', text: 'SYNTHETIC_ROLES_COMPLETE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map(frame => 'event: ' + frame.type + '\n' + 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture endpoint');
    const host = new Proxy({
      async startTeam({ leadSessionId }: { leadSessionId: string }) {
        expect(leadSessionId).toBe('omp-role-task'); roles.push(context?.orcaRole ?? null);
        await handle!.setVendorOptions!({ orcaRole: 'lead', orcaLeadSessionId: leadSessionId, orcaWorkflowId: 'synthetic-team' });
        return { ok: true, teamId: 'synthetic-team', workerPermissionMode: 'auto' };
      },
      async endTeam({ leadSessionId }: { leadSessionId: string }) {
        expect(leadSessionId).toBe('omp-role-task'); roles.push(context?.orcaRole ?? null);
        await handle!.setVendorOptions!({ orcaRole: null, orcaLeadSessionId: null, orcaWorkflowId: null, initialWorker: null });
        return { ok: true };
      },
    }, { get(target, key) { return key in target ? Reflect.get(target, key) : () => { throw new Error('Unexpected fixture operation: ' + String(key)); }; } }) as unknown as OrcaMcpDeps;
    const providers = [...createLiziMcpProviders({ enabled: ['cindy_orca'], orca: host }),
      createOrcaWorkerBridgeMcpProvider({ logger, getMaker() { throw new Error('No real maker'); },
        async persistUserMessage() { throw new Error('No real store'); }, wireSession() { throw new Error('No real task'); },
        orcaTeamStore: { async getWorkerLink() { throw new Error('Must refuse before store access'); }, async updateWorkerStatus() { throw new Error('No real worker'); } } })];
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const deps: AgentDeps = { binaryPath: binary!, logger, runtimeConfig: {}, mcpProviders: providers,
      auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; }, async logout() {}, async getAuthEnv() { return {}; } },
      resolveOmpAgentHome: () => home,
      resolveOmpExecutableEnvironment: () => ({ systemRoot: process.env.SystemRoot, path: process.env.PATH }),
      resolveOmpCredentials: () => ({ proxyKey: 'invalid-loopback-fixture', sessionId: 'omp-role-task' }),
      resolveOmpModelsYaml: options => buildOmpCindyModelsYaml({ baseUrl: 'http://127.0.0.1:' + address.port, api: 'anthropic-messages',
        sessionId: 'omp-role-task', models: [{ id: options.model, name: options.model, input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 4096 }] }),
      createLocalOmpNativeSession(options) {
        context = options.vendorOptions;
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
              expect(calls[bodies.length - 1]).toBeDefined();
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
    handle = await new OmpAgent(deps).startSession({ sessionId: 'omp-role-task', sessionInstanceId: 'omp-role-instance', nativePresentation: true,
      workingDir: cwd, model: 'omp-test-model', permissionMode });
    handle.setInteractionResolver(async request => { if (request.kind === 'permission') approvals.push(request.toolName); return { kind: 'permission', behavior: 'allow' }; });
    void (async () => { for await (const event of handle!.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'SYNTHETIC_ROLE_LIFECYCLE' });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 30000 });
    expect(bodies).toHaveLength(7); expect(roles).toEqual([null, 'lead', null, 'lead']);
    expect(JSON.stringify(bodies[3].messages)).toContain('NOT_ENABLED');
    // Ordinary OMP has no Worker catalog at all; unlike Pi's generic gateway,
    // the original engine rejects this invented tool before host dispatch.
    expect(JSON.stringify(bodies[4].messages)).toContain('Tool send_to_lead not found');
    expect(bodies.every(body => JSON.stringify(body.tools) === JSON.stringify(bodies[0].tools))).toBe(true);
    expect(approvals).toContain('start_team');
    expect(approvedNativeCalls.size).toBe(permissionMode === 'ask' ? calls.length - 1 : 0);
    expect(context?.orcaRole).toBeNull();
    process.stdout.write(JSON.stringify({ ompNativeRoles: { permissionMode, requests: bodies.length, roles, approvals,
      nativeTerminalApprovals: approvedNativeCalls.size, catalogUnchanged: true, revoked: true } }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ompRoleFailure: { requests: bodies.length, roles,
      approvals, nativeDialogs, terminalTail, events: events.slice(-12), lastMessages: JSON.stringify(bodies.at(-1)?.messages).slice(-6000) } }) + '\n');
    process.stdout.write(JSON.stringify({ catalogs: bodies.map(body => body.tools) }) + '\n');
    throw error;
  } finally {
    for (const timer of approvalTimers) clearTimeout(timer);
    await handle?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
