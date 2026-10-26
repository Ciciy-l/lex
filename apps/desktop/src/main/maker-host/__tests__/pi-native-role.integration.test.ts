/** Original pinned Pi, actual Main MCP routing and real Orca handlers. Synthetic store/provider only. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { createLiziMcpProviders, getLiziMcpSessionContext, type OrcaMcpDeps } from '@cindy/mcps';
import { createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow';
import { PiAgent, GUI_NATIVE_BODY, type AgentDeps, type AgentEvent, type AgentSessionHandle, type Logger } from '@cindy/maker-core';
import { createPiNativeHostSession } from '../pi-native-host.js';
import { getPiExtraSpawnConfig, shutdownPiEnvironment } from '../../mcp-integrations/piEnvironment.js';

vi.mock('../plugins/index.js', () => ({ createPluginRegistry: () => ({ isEnabled: () => true, getDisabledRuntimePluginIds: () => [] }) }));
const binary = process.env.CINDY_TEST_PI_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn(message, data) { process.stdout.write(JSON.stringify({ warning: message, data }) + '\n'); }, error() {}, fatal() {}, child() { return logger; } };
it.skipIf(!binary)('Pi fixed native MCP gateways follow active Lead promotion, revocation and reentry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-pi-role-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, home);
  let handle: AgentSessionHandle | undefined;
  const contexts: unknown[] = [], bodies: any[] = [], events: AgentEvent[] = [];
  const calls = [
    ['cindy_mcp_list_tools', { server: 'cindy_orca', tool: 'start_team' }],
    ['cindy_mcp_call_tool', { server: 'cindy_orca', tool: 'start_team', args: {} }],
    ['cindy_mcp_list_tools', { server: 'cindy_orca', tool: 'end_team' }],
    ['cindy_mcp_call_tool', { server: 'cindy_orca', tool: 'end_team', args: {} }],
    ['cindy_mcp_call_tool', { server: 'cindy_orca', tool: 'end_team', args: {} }],
    ['cindy_mcp_list_tools', { server: 'orca_worker_bridge', tool: 'send_to_lead' }],
    ['cindy_mcp_call_tool', { server: 'orca_worker_bridge', tool: 'send_to_lead', args: { worker_id: 'foreign', message: 'must refuse' } }],
    ['cindy_mcp_call_tool', { server: 'cindy_orca', tool: 'start_team', args: {} }],
    ['cindy_mcp_call_tool', { server: 'cindy_orca', tool: 'end_team', args: {} }],
  ] as const;
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8'); // Decode split UTF-8 sequences across network chunks.
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw); bodies.push(body);
    const call = calls[bodies.length - 1];
    const frames = [
      { type: 'message_start', message: { id: 'fixture-' + bodies.length, role: 'assistant', type: 'message', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'call-' + bodies.length, name: call[0], input: {} } : { type: 'text', text: '' } },
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
        expect(leadSessionId).toBe('pi-role-task'); contexts.push(getLiziMcpSessionContext()?.vendorOptions?.orcaRole ?? null);
        await handle!.setVendorOptions!({ orcaRole: 'lead', orcaLeadSessionId: leadSessionId, orcaWorkflowId: 'synthetic-team' });
        return { ok: true, teamId: 'synthetic-team', workerPermissionMode: 'auto' };
      },
      async endTeam({ leadSessionId }: { leadSessionId: string }) {
        expect(leadSessionId).toBe('pi-role-task'); contexts.push(getLiziMcpSessionContext()?.vendorOptions?.orcaRole ?? null);
        await handle!.setVendorOptions!({ orcaRole: null, orcaLeadSessionId: null, orcaWorkflowId: null, initialWorker: null });
        return { ok: true };
      },
    }, { get(target, key) { return key in target ? Reflect.get(target, key) : () => { throw new Error('Unexpected fixture operation: ' + String(key)); }; } }) as unknown as OrcaMcpDeps;
    const providers = [...createLiziMcpProviders({ enabled: ['cindy_orca'], orca: host }),
      createOrcaWorkerBridgeMcpProvider({ logger, getMaker() { throw new Error('No real maker'); },
        async persistUserMessage() { throw new Error('No real store'); }, wireSession() { throw new Error('No real task'); },
        orcaTeamStore: { async getWorkerLink() { throw new Error('Must refuse before store access'); }, async updateWorkerStatus() { throw new Error('No real worker'); } } })];
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const deps: AgentDeps = { binaryPath: binary!, logger, runtimeConfig: { endpoint: 'http://127.0.0.1:' + address.port },
      auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; }, async logout() {}, async getAuthEnv() { return { CINDY_PI_API_KEY: 'invalid-loopback-fixture' }; } },
      resolvePiAgentHome: () => home, resolvePiGlobalContextHome: () => home, resolvePiGatewayModelApi: () => 'anthropic-messages',
      capabilityAdditions: { availableModels: [{ id: 'pi-test-model', displayName: 'Fixture', contextWindow: 200000, efforts: [], defaultEffort: null }] },
      mcpProviders: providers, preparePiExtraSpawnConfig: (supplied, ctx) => getPiExtraSpawnConfig(supplied, logger, ctx),
      createLocalPiNativeSession: options => createPiNativeHostSession(options, spec => {
        const env: Record<string, string> = {};
        for (const key of Object.keys(spec.env)) if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key) || /^(CINDY_PI_|PI_|LEX_PI_)/.test(key)) env[key] = spec.env[key]!;
        Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), XDG_CONFIG_HOME: path.join(home, '.config'), NO_PROXY: '127.0.0.1,localhost' });
        const child = pty.spawn(spec.executable, spec.args, { cwd: spec.cwd, env, name: 'xterm-256color', cols: 100, rows: 30 });
        let exited = false;
        const exit = new Promise<void>(resolve => child.onExit(() => { exited = true; resolve(); }));
        child.onData((data: string) => {
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
      }),
    };
    handle = await new PiAgent(deps).startSession({ sessionId: 'pi-role-task', sessionInstanceId: 'pi-role-instance', nativePresentation: true,
      workingDir: cwd, model: 'pi-test-model', permissionMode: 'ask' });
    const approvals: string[] = [];
    handle.setInteractionResolver(async request => { if (request.kind === 'permission') approvals.push(request.toolName); return { kind: 'permission', behavior: 'allow' }; });
    void (async () => { for await (const event of handle!.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'SYNTHETIC_ROLE_LIFECYCLE' }, { [GUI_NATIVE_BODY]: true });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 30000 });
    expect(bodies).toHaveLength(10); expect(contexts).toEqual([null, 'lead', null, 'lead']);
    expect(JSON.stringify(bodies[5].messages)).toContain('NOT_ENABLED');
    expect(JSON.stringify(bodies[7].messages)).toContain('not an orca worker session');
    expect(bodies.every(body => JSON.stringify(body.tools) === JSON.stringify(bodies[0].tools))).toBe(true);
    expect(approvals).toContain('mcp__cindy_orca__start_team');
    process.stdout.write(JSON.stringify({ piNativeRoles: { requests: bodies.length, contexts, approvals, catalogUnchanged: true, revoked: true } }) + '\n');
  } finally {
    await handle?.close(); await shutdownPiEnvironment();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
