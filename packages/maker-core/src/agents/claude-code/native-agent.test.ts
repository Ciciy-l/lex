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
    const handle = await createClaudeNativeSession({ ...options, runtime: {
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
