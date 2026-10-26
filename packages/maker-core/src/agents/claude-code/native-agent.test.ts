import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';
import type { ClaudeLocalNativeSessionOptions } from './local-session-launch.js';
import type { ClaudeNativeRuntimeOptions } from './native-runtime.js';
import { AgentPresentationRuntime } from '../presentation.js';
import { createClaudeNativeSession } from './native-session.js';
import { ClaudeCodeAgent } from './index.js';
import { Session } from '../../session.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), runtime: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query, forkSession: vi.fn() }));
vi.mock('./native-runtime.js', () => ({ createClaudeNativeRuntime: mocks.runtime }));
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-native-agent-test-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  let launch!: ClaudeLocalNativeSessionOptions, callbacks!: ClaudeNativeRuntimeOptions;
  const driver = { write: vi.fn(), resize: vi.fn(), close: vi.fn(), onData: () => vi.fn(), onExit: () => vi.fn() };
  const presentation = new AgentPresentationRuntime('native', driver);
  const runtime = { presentation, ready: Promise.resolve(), command: vi.fn(async () => ({})),
    submit: vi.fn(async () => ({ nativeMessageId: 'row' })), close: vi.fn(async () => { await presentation.close(); }) };
  mocks.runtime.mockImplementation(async options => { callbacks = options; return runtime; });
  const factory = vi.fn(async (options: ClaudeLocalNativeSessionOptions) => {
    launch = options;
    const handle = await createClaudeNativeSession({ ...options, nativeModel: options.launch.model, runtime: {
      nativeSessionId: options.launch.resume ?? options.launch.sessionId!, executable: options.launch.binaryPath, cwd: root,
      args: [], env: options.launch.env, onEvent: options.onEvent, launch: () => driver, canUseTool: options.launch.canUseTool,
    } });
    cleanups.push(async () => { await handle.close(); await options.launch.releaseNativeResources?.(); });
    return handle;
  });
  const deps: AgentDeps = { binaryPath: process.execPath, logger, runtimeConfig: { systemPrompt: 'fixture system prefix' }, createLocalClaudeNativeSession: factory,
    auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; },
      async logout() {}, async getAuthEnv() { return { CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'fixture-key' }; } },
    mcpProviders: [{ name: 'custom__tool', toClaudeSdkConfig: () => ({ type: 'sdk', name: 'custom__tool', instance: {} }) }],
    getMcpToolApprovalPolicy: () => 'prompt-each-time',
  };
  const agent = new ClaudeCodeAgent(deps);
  const start = (extra = {}) => agent.startSession({ workingDir: root, model: 'claude-sonnet-4-6',
    sessionId: 'business-task', sessionInstanceId: 'business-instance', permissionMode: 'ask', ...extra });
  return { root, deps, agent, factory, start, driver, runtime, launch: () => launch, callbacks: () => callbacks };
}

describe('Claude production agent native factory selection', () => {
  it.each(['lead', 'worker'] as const)('does not resurrect a revoked %s after failed catalog readback and model reopen', async role => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    const controls: Array<{ command: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> }> = [];
    mocks.runtime.mockImplementation(async (options: ClaudeNativeRuntimeOptions) => {
      const presentation = new AgentPresentationRuntime(options.nativeSessionId, { write() {}, resize() {}, onData: () => () => {}, onExit: () => () => {}, close() {} });
      const exactModel = f.launch().launch.model;
      let draft = '';
      const command = vi.fn(async (kind: string, payload: { text?: string }) => {
        if (kind === 'tool-list') throw new Error('catalog rejected');
        if (kind === 'restore-draft') draft = payload.text!;
        return { sessionId: options.nativeSessionId, cwd: f.root, model: exactModel, draft: { text: draft } };
      });
      const runtime = { presentation, ready: Promise.resolve(), command, submit: vi.fn(), close: vi.fn(async () => { await presentation.close(); }) };
      controls.push(runtime); return runtime;
    });
    const id = '76de74f7-694a-45bd-8337-8a5f837c9e13';
    const handle = await f.start({ resumeSessionId: id, vendorOptions: { orcaRole: role, orcaWorkflowId: 'team',
      orcaLeadSessionId: 'lead-task', orcaWorkerId: role === 'worker' ? 'worker' : null,
      orcaWorkerSessionId: role === 'worker' ? 'business-task' : null } });
    await handle.restoreNativeEditorDraft!('unsent exact text');
    const usage = handle.getUsageSnapshot();
    await expect(handle.setVendorOptions!({ orcaRole: null })).rejects.toThrow('catalog rejected');
    expect(f.launch().launch.mcpSources!.context.vendorOptions?.orcaRole).toBeNull();
    await handle.setModel!('claude-haiku-4-5');
    expect(f.launch().launch.mcpSources!.context.vendorOptions).toMatchObject({
      orcaRole: null, orcaWorkflowId: null, orcaLeadSessionId: null, orcaWorkerId: null, orcaWorkerSessionId: null,
    });
    expect(handle.id).toBe(id); expect(await handle.readNativeEditorDraft!()).toBe('unsent exact text');
    expect(handle.getUsageSnapshot()).toEqual(usage);
    expect(controls.every(control => control.submit.mock.calls.length === 0)).toBe(true);
    await handle.close();
  });

  it.each(['reject', 'timeout'] as const)('requires a new real catalog confirmation to reenter after %s', async failure => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    const role = { orcaRole: 'lead', orcaWorkflowId: 'team', orcaLeadSessionId: 'business-task' };
    const handle = await f.start({ vendorOptions: role });
    let reject!: (reason: Error) => void;
    f.runtime.command.mockImplementation(() => new Promise<{}>((_resolve, fail) => { reject = fail; }));
    const leaving = handle.setVendorOptions!({ orcaRole: null });
    expect(f.launch().launch.mcpSources!.context.vendorOptions?.orcaRole).toBeNull();
    reject(new Error('catalog ' + failure));
    await expect(leaving).rejects.toThrow('catalog ' + failure);
    f.runtime.command.mockResolvedValue([{ name: 'mcp__cindy_orca__start_team' }, { name: 'mcp__orca_worker_bridge__send_to_lead' }]);
    await handle.setVendorOptions!(role);
    expect(f.runtime.command).toHaveBeenCalledTimes(2);
    expect(f.launch().launch.mcpSources!.context.vendorOptions?.orcaRole).toBe('lead');
    expect(f.runtime.submit).not.toHaveBeenCalled();
    await handle.close();
  });

  it.each(['revoke', 'close'] as const)('discards a late successful role readback after %s', async action => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    const handle = await f.start({ vendorOptions: { orcaRole: null } });
    const context = f.launch().launch.mcpSources!.context;
    let finish!: (value: unknown) => void;
    f.runtime.command.mockImplementation(() => new Promise<{}>(resolve => { finish = value => resolve(value as {}); }));
    const entering = handle.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'team' });
    if (action === 'close') await handle.close();
    else await expect(handle.setVendorOptions!({ orcaRole: null })).rejects.toThrow('not ready');
    finish([{ name: 'mcp__cindy_orca__start_team' }, { name: 'mcp__orca_worker_bridge__send_to_lead' }]);
    await expect(entering).rejects.toThrow();
    expect(context.vendorOptions?.orcaRole).toBeNull();
    expect(f.runtime.submit).not.toHaveBeenCalled();
    await handle.close();
  });

  it('revokes an existing Lead before native catalog IO and keeps it revoked if readback fails', async () => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    f.runtime.command.mockResolvedValue([{ name: 'mcp__cindy_orca__start_team' }, { name: 'mcp__orca_worker_bridge__send_to_lead' }]);
    const handle = await f.start({ vendorOptions: { orcaRole: null } });
    await handle.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'owned-team' });
    const context = f.launch().launch.mcpSources!.context;
    expect(context.vendorOptions?.orcaRole).toBe('lead');
    let reject!: (reason: Error) => void;
    f.runtime.command.mockImplementation(() => new Promise<{}>((_resolve, fail) => { reject = fail; }));
    const leaving = handle.setVendorOptions!({ orcaRole: null });
    expect(context.vendorOptions?.orcaRole).toBeNull();
    reject(new Error('native connection lost'));
    await expect(leaving).rejects.toThrow('native connection lost');
    expect(context.vendorOptions?.orcaRole).toBeNull();
    await handle.close();
  });
  it('updates the already registered Orca identity during an active turn without restarting or changing tools', async () => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    f.runtime.command.mockResolvedValue([
      { name: 'mcp__cindy_orca__start_team' }, { name: 'mcp__orca_worker_bridge__send_to_lead' },
    ]);
    const handle = await f.start({ vendorOptions: { orcaRole: null } });
    await handle.send({ type: 'user', content: 'synthetic user request' }, { messageUuid: 'initial' });
    expect(handle.isTurnRunning?.()).toBe(true);
    const context = f.launch().launch.mcpSources!.context;
    await handle.setVendorOptions!({ orcaRole: 'lead', orcaWorkflowId: 'team', orcaLeadSessionId: 'business-task' });
    expect(context.vendorOptions).toMatchObject({ orcaRole: 'lead', orcaWorkflowId: 'team' });
    await handle.setVendorOptions!({ orcaRole: null, orcaWorkflowId: null });
    expect(context.vendorOptions).toMatchObject({ orcaRole: null, orcaWorkflowId: null });
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.submit).toHaveBeenCalledOnce();
    expect(f.runtime.command.mock.calls).toEqual([['tool-list', {}], ['tool-list', {}]]);
    await handle.close();
  });

  it.each(['missing-native-tool', 'new-server'] as const)('refuses an active Orca update with %s instead of claiming a hot catalog', async mode => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    if (mode === 'new-server') f.deps.mcpProviders.push({ name: 'only-lead', isEnabled: ctx => ctx.vendorOptions?.orcaRole === 'lead',
      toClaudeSdkConfig: () => ({ type: 'sdk', name: 'only-lead', instance: {} }) });
    f.runtime.command.mockResolvedValue(mode === 'missing-native-tool' ? [] : [
      { name: 'mcp__cindy_orca__start_team' }, { name: 'mcp__orca_worker_bridge__send_to_lead' },
    ]);
    const handle = await f.start({ vendorOptions: { orcaRole: null } });
    await handle.send({ type: 'user', content: 'synthetic user request' }, { messageUuid: 'initial' });
    await expect(handle.setVendorOptions!({ orcaRole: 'lead' })).rejects.toThrow('idle');
    expect(f.launch().launch.mcpSources!.context.vendorOptions?.orcaRole).toBeNull();
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.runtime.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it('does not apply an Orca identity after the native input owner changes during catalog readback', async () => {
    const f = await fixture();
    f.deps.mcpProviders = ['cindy_orca', 'orca_worker_bridge'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'sdk', name, instance: {} }) }));
    let finish!: (value: unknown) => void;
    f.runtime.command.mockImplementation(() => new Promise<{}>(resolve => { finish = value => resolve(value as {}); }));
    const handle = await f.start({ vendorOptions: { orcaRole: null } });
    handle.setNativeInputResolver!(vi.fn());
    const change = handle.setVendorOptions!({ orcaRole: 'lead' });
    handle.setNativeInputResolver!(vi.fn());
    finish([{ name: 'mcp__cindy_orca__start_team' }, { name: 'mcp__orca_worker_bridge__send_to_lead' }]);
    await expect(change).rejects.toThrow('owner changed');
    expect(f.launch().launch.mcpSources!.context.vendorOptions?.orcaRole).toBeNull();
    await handle.close();
  });

  it('rebuilds the real policy and MCP sources for a same-history idle model change', async () => {
    const f = await fixture();
    const controls: Array<{ close: ReturnType<typeof vi.fn>; command: ReturnType<typeof vi.fn> }> = [];
    mocks.runtime.mockImplementation(async (options: ClaudeNativeRuntimeOptions) => {
      const presentation = new AgentPresentationRuntime(options.nativeSessionId, { write() {}, resize() {}, onData: () => () => {}, onExit: () => () => {}, close() {} });
      let draft = '';
      const command = vi.fn(async (kind: string, payload: { text?: string }) => {
        if (kind === 'restore-draft') draft = payload.text!;
        return { sessionId: options.nativeSessionId, cwd: f.root, model: f.launch().launch.model, draft: { text: draft } };
      });
      const runtime = { presentation, ready: Promise.resolve(), command, submit: vi.fn(), close: vi.fn(async () => { await presentation.close(); }) };
      controls.push(runtime); return runtime;
    });
    const id = '76de74f7-694a-45bd-8337-8a5f837c9e13';
    const handle = await f.start({ resumeSessionId: id, vendorOptions: { orcaRole: 'lead', orcaWorkflowId: 'synthetic-team' } });
    const first = f.launch();
    await handle.restoreNativeEditorDraft!('unsent exact text');
    await handle.setModel!('claude-haiku-4-5');
    const next = f.launch();
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(controls[0]!.close).toHaveBeenCalledOnce();
    expect(first.launch.abortController.signal.aborted).toBe(true);
    expect(next.launch.abortController.signal.aborted).toBe(false);
    expect(next.usageTracker).toBe(first.usageTracker);
    expect(next.launch.resume).toBe(id); expect(handle.id).toBe(id);
    expect(next.launch.permissionMode).toBe(first.launch.permissionMode);
    expect(next.launch.mcpSources?.context).not.toBe(first.launch.mcpSources?.context);
    expect(next.launch.mcpSources?.context).toMatchObject({ sessionId: 'business-task', sessionInstanceId: 'business-instance',
      vendorOptions: { orcaRole: 'lead', orcaWorkflowId: 'synthetic-team' } });
    expect(await handle.readNativeEditorDraft!()).toBe('unsent exact text');
    expect(mocks.query).not.toHaveBeenCalled();
    await handle.close();
  });
  it.each([false, true])('confirms frozen startup directory grants without terminating native onboarding (populated=%s)', async populated => {
    const f = await fixture();
    const extraDirs = populated ? [path.join(f.root, 'reference')] : [];
    const writableDirs = populated ? [path.join(f.root, 'output')] : [];
    const handle = await f.start({ extraDirs, writableDirs });
    const session = new Session({ id: 'business-task', agentKind: 'claude-code', workDir: f.root,
      logger, handle, capabilities: f.agent.capabilities, turnStallMs: 0 });
    expect(f.launch().launch.additionalDirectories).toEqual([...extraDirs, ...writableDirs]);
    await session.setExtraDirs([...extraDirs]);
    await session.setWritableDirs([...writableDirs]);
    await expect(session.setExtraDirs([path.join(f.root, 'new-reference')])).rejects.toThrow('extraDirs');
    await expect(session.setWritableDirs([path.join(f.root, 'new-output')])).rejects.toThrow('writableDirs');
    // Failed changes have not mutated either snapshot; the atomic grant
    // transaction can restore the old policy without closing the live task.
    await session.setExtraDirs([...extraDirs]);
    await session.setWritableDirs([...writableDirs]);
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.submit).not.toHaveBeenCalled();
    expect(f.runtime.command).not.toHaveBeenCalled();
    expect(handle.presentation).toBe(f.runtime.presentation);
    await handle.close();
    await expect(handle.setExtraDirs!([...extraDirs])).rejects.toThrow('not active');
  });

  it('keeps ordinary SDK creation until the host explicitly selects a native presentation', async () => {
    const f = await fixture();
    f.deps.useLocalClaudeNativePresentation = options => options.nativePresentation === true;
    mocks.query.mockImplementationOnce(() => { throw new Error('SDK selected'); });
    await expect(f.start()).rejects.toThrow('SDK selected');
    expect(f.factory).not.toHaveBeenCalled();
    const id = '76de74f7-694a-45bd-8337-8a5f837c9e13';
    const handle = await f.start({ nativePresentation: true, resumeSessionId: id });
    expect(handle.presentation).toBe(f.runtime.presentation);
    expect(handle.id).toBe(id); expect(f.factory).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
  });
  it('shares the route-resolved usage tracker with the native runtime before the first provider reply', async () => {
    const f = await fixture(); f.deps.resolveModelContextLimit = () => 64000;
    const handle = await f.start();
    expect(handle.getUsageSnapshot()).toMatchObject({ contextWindow: 64000, costUsd: 0 });
    expect(f.callbacks().usageTracker).toBe(f.launch().usageTracker);
    expect(f.callbacks().usageTracker?.snapshot().contextWindow).toBe(64000);
  });


  it('hands the explicit resume identity to the native host without creating an SDK Query', async () => {
    const f = await fixture();
    const id = '76de74f7-694a-45bd-8337-8a5f837c9e13';
    const invalidResume = vi.fn(async () => true);
    const handle = await f.start({ resumeSessionId: id, onInvalidResumeSession: invalidResume });
    expect(f.launch().launch.resume).toBe(id); expect(f.launch().launch.sessionId).toBeUndefined();
    expect(handle.id).toBe(id); expect(handle.requestSessionId).toBe(id);
    expect(f.factory).toHaveBeenCalledOnce(); expect(mocks.query).not.toHaveBeenCalled();
    // This fixture deliberately has no transcript. Native resume, not the SDK's
    // fresh-session recovery, owns the outcome and the original persisted id.
    expect(invalidResume).not.toHaveBeenCalled();
  });

  it('returns the native handle from startSession with the existing launch policy and never starts an SDK Query', async () => {
    const f = await fixture(), handle = await f.start();
    expect(f.factory).toHaveBeenCalledOnce(); expect(mocks.query).not.toHaveBeenCalled();
    expect(handle.presentation).toBe(f.runtime.presentation);
    expect(f.launch().launch).toMatchObject({ cwd: f.root, model: 'claude-sonnet-4-6[1m]', permissionMode: 'default',
      env: { ANTHROPIC_API_KEY: 'fixture-key' }, mcpSources: { context: { sessionId: 'business-task', sessionInstanceId: 'business-instance' } } });
    expect(f.launch().launch.hooks.PreToolUse?.length).toBeGreaterThan(0);
    expect(f.launch().launch.systemPromptAppend).toContain('fixture system prefix');
    await handle.send({ type: 'user', content: 'hello from GUI' }, { messageUuid: 'host-row' });
    expect(f.runtime.submit).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello from GUI', messageId: 'host-row' }));
    const view = handle.presentation!.attach('desktop', vi.fn()); view.detach();
    expect(f.runtime.close).not.toHaveBeenCalled();
  });

  it('uses the existing permission resolver and delivers retirement on the native handle event stream', async () => {
    const f = await fixture(), handle = await f.start();
    const resolver = vi.fn(() => new Promise<never>(() => {})); handle.setInteractionResolver(resolver);
    const events: string[] = [];
    const drained = (async () => { for await (const event of handle.events()) events.push(event.type); })();
    const controller = new AbortController();
    const decision = f.launch().launch.canUseTool('mcp__custom__tool__write', { payload: 'fixture' }, {
      toolUseID: 'permission-1', signal: controller.signal,
    });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    expect(resolver.mock.calls[0]).toEqual([expect.objectContaining({ requestId: 'permission-1', kind: 'permission' })]);
    controller.abort(); expect((await decision).behavior).toBe('deny');
    await handle.close(); await drained;
    expect(events).toContain('session_id'); expect(events).toContain('interaction_dismissed');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('keeps turn policy validation and refuses unimplemented native plan/history rather than creating a replacement query', async () => {
    const f = await fixture();
    await expect(f.start({ planMode: true })).rejects.toThrow('plan controls');
    await expect(f.start({ vendorOptions: { resumeSessionAt: 'old-message' } })).rejects.toThrow('history');
    expect(f.factory).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
    const handle = await f.start();
    await expect(handle.send({ type: 'user', content: 'plan' }, { planMode: true })).rejects.toThrow('plan controls');
    expect(f.runtime.submit).not.toHaveBeenCalled();
  });

  it('does not fall back to the SDK or retry native startup when the host refuses', async () => {
    const f = await fixture();
    f.factory.mockImplementation(async options => { await options.launch.releaseNativeResources?.(); throw new Error('host refused'); });
    await expect(f.start()).rejects.toThrow('host refused');
    expect(f.factory).toHaveBeenCalledOnce(); expect(mocks.query).not.toHaveBeenCalled();
  });
});
