/** Opt-in original CLI + Main MCP factory; only synthetic accounts and loopback traffic. */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLiziMcpProviders, getLiziMcpSessionContext, type OrcaMcpDeps } from '@cindy/mcps';
import { createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow';
import { ClaudeCodeAgent, type AgentDeps, type AgentEvent, type AgentSessionHandle, type Logger } from '@cindy/maker-core';
import { createClaudeNativeHostSession } from '../claude-native-host.js';
import { nativeRoleDb } from './nativeRoleDb.fixture.js';

const binary = process.env.CINDY_TEST_CLAUDE_BINARY;
const newline = String.fromCharCode(10), escape = String.fromCharCode(27);
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };

it.skipIf(!binary).each(['idle-reopen', 'active-identity', 'failed-revocation', 'retired-revocation'] as const)('uses original Claude and Main MCP for %s', async mode => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lex-claude-role-reopen-')));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), config = path.join(home, '.claude');
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  const key = 'sk-ant-api03-lex-native-probe-not-a-real-key';
  const bodies: any[] = [], events: AgentEvent[] = [], contexts: any[] = [];
  const executors: Array<{ exited: boolean; mcp: Record<string, any>; release: boolean }> = [];
  let handle: AgentSessionHandle | undefined;
  let roleStore: Awaited<ReturnType<typeof nativeRoleDb>> | undefined;
  const roleWarnings: unknown[][] = [];
  const rawHandles: Awaited<ReturnType<typeof createClaudeNativeHostSession>>[] = [];
  const recoveryRoles: unknown[] = [];
  let terminalTail = '';
  const usesRoleDb = mode === 'failed-revocation' || mode === 'retired-revocation';
  const activeCalls = ['mcp__cindy_orca__start_team', 'mcp__cindy_orca__end_team', 'mcp__cindy_orca__end_team',
    'mcp__orca_worker_bridge__send_to_lead', 'mcp__cindy_orca__start_team', 'mcp__cindy_orca__end_team'];
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8'); // Decode split UTF-8 sequences across network chunks.
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw); bodies.push(body);
    const toolResult = mode === 'active-identity' ? bodies.length > activeCalls.length
      : body.messages.at(-1)?.content?.some?.((item: any) => item.type === 'tool_result');
    const name = mode === 'active-identity' ? activeCalls[bodies.length - 1] : 'mcp__lex_role_fixture__context';
    const input = name === 'mcp__orca_worker_bridge__send_to_lead' ? { worker_id: 'not-this-task', message: 'must be rejected' } : {};
    const block = toolResult ? { type: 'text', text: '' }
      : { type: 'tool_use', id: 'fixture-call-' + bodies.length, name, input: {} };
    const frames = [
      { type: 'message_start', message: { id: 'fixture-' + bodies.length, role: 'assistant', type: 'message', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block },
      ...(toolResult ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FAKE_ROLE_CHECKED' } }] : []),
      ...(!toolResult ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }] : []),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: toolResult ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map(frame => 'event: ' + frame.type + newline + 'data: ' + JSON.stringify(frame) + newline + newline).join(''));
  });
  try {
    if (usesRoleDb) roleStore = await nativeRoleDb(root, () => handle, (...args) => roleWarnings.push(args));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture endpoint');
    const env: Record<string, string> = {};
    for (const name of Object.keys(process.env)) if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(name)) env[name] = process.env[name]!;
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + address.port, ANTHROPIC_API_KEY: key,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', TERM: 'xterm-256color' });
    await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [cwd.split(path.sep).join('/')]: { hasTrustDialogAccepted: true } } }));
    const pty = createRequire(path.resolve('../../package.json'))('node-pty');
    const makeServer = (name: string) => {
      const mcp = new McpServer({ name, version: '1.0.0' });
      mcp.tool('context', 'Read this synthetic task role.', {}, async () => {
        const ctx = getLiziMcpSessionContext();
        if (roleStore) expect(ctx?.vendorOptions?.orcaRole ?? null).toBe(await roleStore.role());
        contexts.push({ sessionId: ctx?.sessionId, instance: ctx?.sessionInstanceId, role: ctx?.vendorOptions?.orcaRole ?? null });
        return { content: [{ type: 'text' as const, text: String(ctx?.vendorOptions?.orcaRole ?? 'ordinary') }] };
      });
      return { type: 'sdk' as const, name, instance: mcp };
    };
    const deps: AgentDeps = {
      binaryPath: binary!, logger, runtimeConfig: { systemPrompt: 'Synthetic isolated fixture.' },
      auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; },
        async logout() {}, async getAuthEnv() { return { ...env }; } },
      mcpProviders: [
        { name: 'lex_role_fixture', toClaudeSdkConfig: () => makeServer('lex_role_fixture') },
        { name: 'lex_lead_fixture', isEnabled: ctx => ctx.vendorOptions?.orcaRole === 'lead', toClaudeSdkConfig: () => makeServer('lex_lead_fixture') },
      ],
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
      async createLocalClaudeNativeSession(options) {
        expect(executors.every(executor => executor.exited)).toBe(true);
        recoveryRoles.push(options.launch.mcpSources?.context.vendorOptions?.orcaRole ?? null);
        const record = { exited: false, mcp: {} as Record<string, any>, release: false }; executors.push(record);
        const release = options.launch.releaseNativeResources;
        options.launch.releaseNativeResources = async () => { record.release = true; await release?.(); };
        const raw = await createClaudeNativeHostSession(options, spec => {
          // A fixture owns these launch files and all their fake tokens. Never print them.
          const childEnv = { ...env };
          for (const [name, value] of Object.entries(spec.env)) {
            if (name.startsWith('LEX_CLAUDE_BRIDGE_') || name.startsWith('XDT_MAKER_')
              || name === 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST' || name === 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING') childEnv[name] = value;
          }
          const mcpIndex = spec.args.indexOf('--mcp-config');
          if (mcpIndex >= 0) {
            const mcpPath = spec.args[mcpIndex + 1]!;
            const text = readFileSync(mcpPath, 'utf8');
            record.mcp = JSON.parse(text.replace(/\$\{(LEX_CLAUDE_MCP_[A-Za-z0-9_]+)\}/g, (_match, name: string) => {
              childEnv[name] = spec.env[name]!;
              return JSON.stringify(spec.env[name]).slice(1, -1);
            })).mcpServers;
          }
          const child = pty.spawn(spec.executable, spec.args, { cwd: spec.cwd, env: childEnv, cols: 100, rows: 30, name: 'xterm-256color' });
          const exit = new Promise<void>(resolve => child.onExit(() => { record.exited = true; resolve(); }));
          let text = '', trusted = false;
          child.onData((data: string) => {
            text = (text + stripVTControlCharacters(data)).slice(-10000);
            terminalTail = text;
            if (!trusted && text.replace(/\s/g, '').includes('Yes,Itrustthisfolder')) {
              trusted = true; child.write(escape + '[B'); setTimeout(() => child.write(String.fromCharCode(13)), 100);
            }
            if (data.includes(escape + '[6n')) child.write(escape + '[1;1R');
            if (data.includes(escape + '[c')) child.write(escape + '[?1;2c');
          });
          return { pid: child.pid, write: (value: string) => child.write(value), resize: (cols: number, rows: number) => child.resize(cols, rows),
            onData: (listener: (data: string) => void) => { const sub = child.onData(listener); return () => sub.dispose(); },
            onExit: (listener: (exit: { code: number }) => void) => { const sub = child.onExit((exit: { exitCode: number }) => listener({ code: exit.exitCode })); return () => sub.dispose(); },
            async close() {
              // Main must revoke this exact token before waiting for native exit.
              const selected = record.mcp.lex_role_fixture;
              if (selected) {
                const response = await fetch(selected.url, { method: 'POST', headers: { ...selected.headers,
                  'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} } }) });
                await response.text(); expect(response.status).toBe(401);
              }
              if (!record.exited) { child.write(String.fromCharCode(3)); await new Promise(resolve => setTimeout(resolve, 100)); child.write(String.fromCharCode(3)); }
              for (let i = 0; i < 20 && !record.exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
              if (!record.exited) child.kill(); await exit;
            },
          };
        });
        rawHandles.push(raw);
        let ready = false;
        let readyError: unknown;
        void raw.nativeRuntime.ready.then(() => { ready = true; }, error => { readyError = error; });
        await vi.waitFor(() => {
          if (readyError) throw readyError;
          expect(ready, terminalTail).toBe(true);
        }, { timeout: 20000 });
        if (mode === 'idle-reopen' && options.launch.mcpSources?.context.vendorOptions?.orcaRole === 'lead') {
          await vi.waitFor(async () => {
            const tools = await raw.nativeRuntime.command('tool-list', {}) as Array<{ name: string }>;
            expect(tools.map(tool => tool.name)).toContain('mcp__lex_lead_fixture__context');
          }, { timeout: 10000, interval: 200 });
        }
        if (usesRoleDb) await vi.waitFor(async () => {
          const tools = await raw.nativeRuntime.command('tool-list', {}) as Array<{ name: string }>;
          expect(tools.map(tool => tool.name)).toContain('mcp__cindy_orca__start_team');
          expect(tools.map(tool => tool.name)).toContain('mcp__orca_worker_bridge__send_to_lead');
        }, { timeout: 10000, interval: 200 });
        if (mode === 'retired-revocation' && rawHandles.length > 1 && rawHandles.length < 4) {
          const command = raw.nativeRuntime.command;
          raw.nativeRuntime.command = async (kind, payload) => {
            if (kind === 'snapshot') throw new Error('injected replacement snapshot failure');
            return command(kind, payload);
          };
        }
        return raw;
      },
    };
    if (mode !== 'idle-reopen') {
      const recordContext = () => {
        const ctx = getLiziMcpSessionContext();
        expect(handle!.isTurnRunning?.()).toBe(true);
        contexts.push({ sessionId: ctx?.sessionId, instance: ctx?.sessionInstanceId, role: ctx?.vendorOptions?.orcaRole ?? null });
      };
      // Real MCP manifests/handlers; only the persistent host store is synthetic.
      // Any unexpected host operation fails rather than touching a real team.
      const host = new Proxy({
        async startTeam({ leadSessionId }: { leadSessionId: string }) {
          recordContext(); expect(leadSessionId).toBe('fixture-task');
          await handle!.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'fixture-team', orcaLeadSessionId: leadSessionId });
          return { ok: true as const, teamId: 'fixture-team', workerPermissionMode: 'auto' as const };
        },
        async endTeam({ leadSessionId }: { leadSessionId: string }) {
          recordContext(); expect(leadSessionId).toBe('fixture-task');
          await handle!.setVendorOptions!({ orcaRole: null, orcaWorkflowId: null, orcaLeadSessionId: null, initialWorker: null });
          return { ok: true as const };
        },
      }, { get(target, name) { return name in target ? Reflect.get(target, name)
        : () => { throw new Error('Unexpected synthetic Orca host operation: ' + String(name)); }; } }) as unknown as OrcaMcpDeps;
      deps.mcpProviders = [
        ...(usesRoleDb ? [{ name: 'lex_role_fixture', toClaudeSdkConfig: () => makeServer('lex_role_fixture') }] : []),
        ...createLiziMcpProviders({ enabled: ['cindy_orca'], orca: host }),
        createOrcaWorkerBridgeMcpProvider({ logger,
          getMaker() { throw new Error('No real maker in fixture'); },
          async persistUserMessage() { throw new Error('No real message store in fixture'); },
          wireSession() { throw new Error('No real task in fixture'); },
          orcaTeamStore: { async getWorkerLink() { throw new Error('Ordinary role must be denied before store lookup'); },
            async updateWorkerStatus() { throw new Error('No worker mutation in fixture'); } },
        }),
      ];
    }
    const agent = new ClaudeCodeAgent(deps);
    handle = await agent.startSession({ sessionId: 'fixture-task', sessionInstanceId: 'fixture-instance', workingDir: cwd,
      model: 'claude-sonnet-4-6', permissionMode: 'ask', vendorOptions: { orcaRole: null } });
    let actualId: string | undefined;
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    void (async () => { for await (const event of handle!.events()) events.push(event); })();
    if (mode === 'retired-revocation') {
      await handle.send({ type: 'user', content: 'ESTABLISH_SYNTHETIC_HISTORY' });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 20000 });
      const id = handle.id;
      await roleStore!.setRole('fixture-task', 'lead');
      await handle.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'fixture-team', orcaLeadSessionId: 'fixture-task' });
      await handle.restoreNativeEditorDraft!('retained retired role draft');
      const beforeRequests = bodies.length, beforeUsage = handle.getUsageSnapshot();
      await expect(handle.setModel!('claude-haiku-4-5')).rejects.toThrow('snapshot failure');
      await roleStore!.clear('fixture-task');
      expect(roleWarnings).toHaveLength(1); expect(await roleStore!.role()).toBeNull();
      await handle.setModel!('claude-sonnet-4-6');
      expect(recoveryRoles).toEqual([null, 'lead', null, null]);
      expect(executors.slice(0, -1).every(executor => executor.exited && executor.release)).toBe(true);
      expect(handle.id).toBe(id); expect(handle.model).toBe('claude-sonnet-4-6');
      expect(bodies).toHaveLength(beforeRequests); expect(handle.getUsageSnapshot()).toEqual(beforeUsage);
      expect(await handle.readNativeEditorDraft!()).toBe('retained retired role draft');
      const recovered = rawHandles.at(-1) as Awaited<ReturnType<typeof createClaudeNativeHostSession>>;
      expect(recovered.readOrcaIdentity!().orcaRole).toBeNull();
      await handle.send({ type: 'user', content: 'VERIFY_REVOKED_CONTEXT' });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(2), { timeout: 20000 });
      expect(contexts.map(context => context.role)).toEqual([null, null]);
      expect(JSON.stringify(bodies)).not.toContain('retained retired role draft');
      process.stdout.write(JSON.stringify({ claudeRetiredRevocationRecovery: { nativeHistory: id, recoveryRoles,
        productionMainClear: true, workerBackedSqlite: true, handlerMatchesDb: true,
        failures: 'two injected snapshot failures after real native startup', draftRetained: true, zeroReplay: true } }) + newline);
      return;
    }
    if (mode === 'failed-revocation') {
      // Actual CLI, adapter and Main MCP; only the failed catalog reply is
      // injected. No model request or input is replayed by the replacement.
      await handle.send({ type: 'user', content: 'ESTABLISH_SYNTHETIC_HISTORY' });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 20000 });
      const id = handle.id, role = { orcaRole: 'lead', orcaWorkflowId: 'fixture-team', orcaLeadSessionId: 'fixture-task' };
      await roleStore!.setRole('fixture-task', 'lead');
      await handle.setVendorOptions!(role);
      await handle.restoreNativeEditorDraft!('retained unsent role draft');
      const beforeRequests = bodies.length, beforeUsage = handle.getUsageSnapshot();
      const raw = rawHandles[0] as Awaited<ReturnType<typeof createClaudeNativeHostSession>>;
      const original = raw.nativeRuntime.command;
      raw.nativeRuntime.command = async (kind, payload) => {
        if (kind === 'tool-list') throw new Error('injected catalog rejection');
        return original(kind, payload);
      };
      await roleStore!.clear('fixture-task');
      expect(roleWarnings).toHaveLength(1);
      expect(await roleStore!.role()).toBeNull();
      raw.nativeRuntime.command = original;
      expect(raw.readOrcaIdentity!().orcaRole).toBeNull();
      await handle.setModel!('claude-haiku-4-5');
      expect(handle.id).toBe(id); expect(handle.model).toBe('claude-haiku-4-5');
      expect(bodies).toHaveLength(beforeRequests); expect(handle.getUsageSnapshot()).toEqual(beforeUsage);
      expect(await handle.readNativeEditorDraft!()).toBe('retained unsent role draft');
      const next = rawHandles[1] as Awaited<ReturnType<typeof createClaudeNativeHostSession>>;
      expect(next.readOrcaIdentity!().orcaRole).toBeNull();
      expect(await roleStore!.role()).toBeNull();
      await handle.send({ type: 'user', content: 'VERIFY_REVOKED_CONTEXT' });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(2), { timeout: 20000 });
      expect(contexts.map(context => context.role)).toEqual([null, null]);
      expect(JSON.stringify(bodies)).not.toContain('retained unsent role draft');
      await roleStore!.setRole('fixture-task', 'lead');
      await handle.setVendorOptions!(role);
      const command = next.nativeRuntime.command;
      next.nativeRuntime.command = async (kind, payload) => {
        if (kind === 'tool-list') throw new Error('injected catalog timeout');
        return command(kind, payload);
      };
      await roleStore!.clear('fixture-task');
      expect(roleWarnings).toHaveLength(2);
      expect(await roleStore!.role()).toBeNull();
      let confirmations = 0;
      next.nativeRuntime.command = async (kind, payload) => {
        if (kind === 'tool-list') confirmations++;
        return command(kind, payload);
      };
      await roleStore!.setRole('fixture-task', 'lead');
      await handle.setVendorOptions!(role);
      expect(confirmations).toBe(1); expect(next.readOrcaIdentity!().orcaRole).toBe('lead');
      expect(bodies).toHaveLength(beforeRequests + 2);
      process.stdout.write(JSON.stringify({ claudeRevocationRecovery: { nativeHistory: id, requests: bodies.length,
        handlers: contexts, replacementRole: null, reentryConfirmations: confirmations,
        catalogFailures: 'injected rejection/timeout, real native confirmation',
        productionMainClear: true, workerBackedSqlite: true, handlerMatchesDb: true, draftRetained: true, zeroReplay: true } }) + newline);
      return;
    }
    if (mode === 'active-identity') {
      await handle.send({ type: 'user', content: 'SYNTHETIC_ACTIVE_ROLE_LIFECYCLE' });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 30000 });
      expect(executors).toHaveLength(1); expect(executors[0]!.exited).toBe(false);
      expect(bodies).toHaveLength(7);
      expect(contexts.map(ctx => ctx.role)).toEqual([null, 'lead', null, 'lead']);
      expect(contexts.every(ctx => ctx.sessionId === 'fixture-task' && ctx.instance === 'fixture-instance')).toBe(true);
      expect(JSON.stringify(bodies[3].messages)).toContain('NOT_ENABLED');
      expect(JSON.stringify(bodies[4].messages)).toContain('not an orca worker session');
      expect(bodies.every(body => JSON.stringify(body.tools) === JSON.stringify(bodies[0].tools))).toBe(true);
      expect(bodies.every(body => body.model === bodies[0].model)).toBe(true);
      process.stdout.write(JSON.stringify({ nativeClaudeActiveRole: { requests: bodies.length, executors: executors.length,
        transitions: 4, handlerContexts: contexts, catalogUnchanged: true, exitRoleRevoked: true, workerBridgeDenied: true } }) + newline);
      return;
    }
    for (const [index, role] of [null, 'lead', null].entries()) {
      if (index) {
        await handle.restoreNativeEditorDraft!('unsent role draft');
        const beforeRequests = bodies.length, beforeUsage = handle.getUsageSnapshot();
        await handle.setVendorOptions!({ orcaRole: role, orcaWorkflowId: role ? 'fixture-team' : null });
        expect(handle.id).toBe(actualId);
        expect(bodies).toHaveLength(beforeRequests); expect(handle.getUsageSnapshot()).toEqual(beforeUsage);
        expect(await handle.readNativeEditorDraft!()).toBe('unsent role draft');
        expect(executors[index - 1]!.exited).toBe(true); expect(executors[index - 1]!.release).toBe(true);
      }
      await handle.send({ type: 'user', content: 'ROLE_' + index });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(index + 1), { timeout: 20000 });
      actualId ??= handle.id;
      expect(actualId).not.toBe('<pending>');
      expect(contexts[index]).toMatchObject({ sessionId: 'fixture-task', instance: 'fixture-instance', role });
      // New Claude versions defer MCP schemas on the wire; query the native
      // registry to verify availability and revocation, not eager serialization.
      const tools = (await rawHandles[index]!.nativeRuntime.command('tool-list', {}) as Array<{ name: string }>).map(tool => tool.name);
      process.stdout.write(JSON.stringify({ nativeRoleCatalog: { index, role, tools,
        selectedServers: Object.keys(executors[index]!.mcp), handlerContext: contexts[index], requestCount: bodies.length } }) + newline);
      expect(tools).toContain('mcp__lex_role_fixture__context');
      expect(tools.includes('mcp__lex_lead_fixture__context')).toBe(role === 'lead');
      expect(JSON.stringify(bodies[index * 2].messages)).not.toContain('unsent role draft');
    }
    expect(bodies).toHaveLength(6);
    expect(JSON.stringify(bodies[4].messages)).toContain('ROLE_0');
    process.stdout.write(JSON.stringify({ nativeClaudeRoleReopen: { requests: bodies.length, transitions: 2,
      sameHistory: true, realMcpHandlerContexts: contexts, oldTokensRevokedBeforeExit: true, draftRetained: true } }) + newline);
  } finally {
    await handle?.close(); for (const raw of rawHandles) await raw.close();
    await roleStore?.db.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90000);
