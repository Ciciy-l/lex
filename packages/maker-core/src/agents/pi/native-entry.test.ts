import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../base-agent.js';
import type { NativeSessionBridgeOptions } from '../shared/native-session-bridge.js';

const mock = vi.hoisted(() => ({ bridges: [] as NativeSessionBridgeOptions[], history: '', model: 'fixture-model', rpc: vi.fn() }));
vi.mock('../shared/native-session-bridge.js', () => ({ NativeSessionBridge: class {
  constructor(options: NativeSessionBridgeOptions) { mock.bridges.push(options); }
  async start() {} environment() { return {}; } async close() {}
  async command(_kind: string, payload: Record<string, unknown>) {
    return { ok: true, data: payload.type === 'get_state'
      ? { sessionFile: mock.history, model: { id: mock.model, provider: 'cindy', contextWindow: 200000 } }
      : payload.type === 'get_entries' ? { entries: [] } : { commands: [] } };
  }
} }));
vi.mock('./rpc-client.js', () => ({ PiRpcProcess: class { constructor() { mock.rpc(); throw new Error('RPC frontend must not start'); } } }));
import { PiNativeSessionControl } from './native-session.js';
import { PiAgent } from './index.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); mock.bridges.length = 0; vi.clearAllMocks(); });
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };

describe('ordinary Pi production frontend selection', () => {
  it.each([false, true])('uses the prepared native factory for new and original-history tasks (resume=%s)', async resume => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-native-selection-'));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    mock.history = path.join(root, 'original.jsonl'); await fs.writeFile(mock.history, '{}\n');
    const launch = vi.fn(async () => {
      const bridge = mock.bridges.at(-1)!;
      queueMicrotask(() => bridge.onEvent({ sequence: 1, kind: 'ready', value: { sessionFile: mock.history, model: mock.model, provider: 'cindy' } }));
      return { pid: 54321, write: vi.fn(), resize: vi.fn(), onData: () => vi.fn(), onExit: () => vi.fn(), close: vi.fn(async () => {}) };
    });
    const native = vi.fn<NonNullable<AgentDeps['createLocalPiNativeSession']>>(async options => new PiNativeSessionControl({ ...options, launch }));
    const deps: AgentDeps = { binaryPath: process.execPath, logger, auth: {
      getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {}, getAuthEnv: async () => ({ PI_NATIVE_EMPTY: '', PI_NATIVE_AUTH: 'fixture-auth' }),
    }, runtimeConfig: { endpoint: 'http://127.0.0.1:9', systemPrompt: 'Host fixture addition' }, resolvePiAgentHome: () => path.join(root, 'agent-home'), createLocalPiNativeSession: native,
      resolvePiGatewayModelApi: () => 'openai-responses',
      capabilityAdditions: { availableModels: [{ id: mock.model, displayName: 'Fixture', contextWindow: 200000, efforts: [], defaultEffort: null }] } };
    const agent = new PiAgent(deps);
    const handle = await agent.startSession({ sessionId: 'product-task', sessionInstanceId: 'product-instance',
      workingDir: root, model: mock.model, nativePresentation: true, permissionMode: 'ask',
      ...(resume ? { resumeSessionId: mock.history } : {}),
    });
    cleanup.push(() => handle.close({ reason: 'navigation' }));
    expect(handle.id).toBe(mock.history); expect(handle.presentation).toBeDefined();
    expect(native).toHaveBeenCalledOnce(); expect(mock.rpc).not.toHaveBeenCalled(); expect(launch).toHaveBeenCalledOnce();
    const options = native.mock.calls[0]![0];
    expect(options).toMatchObject({ sessionId: 'product-task', model: mock.model, provider: 'cindy',
      ...(resume ? { resumeSessionId: mock.history } : {}) });
    expect(options.args).toContain('--no-approve'); expect(options.args).toContain('--append-system-prompt');
    expect(options.env.CINDY_PI_PERMISSION_FILE).toBeTruthy();
    expect(options.env).toMatchObject({ PI_NATIVE_EMPTY: '', PI_NATIVE_AUTH: 'fixture-auth' });
    expect(Object.values(options.env).every(value => typeof value === 'string')).toBe(true);
    expect(await fs.readFile(options.env.CINDY_PI_PERMISSION_FILE, 'utf8')).toContain('ask');
    expect(options.extensionPath).toContain('lex-native-presentation.ts');
    expect(await handle.previewModelSwitch!(mock.model)).toMatchObject({ action: 'hot', windowVerified: true });
    expect(handle.requiresModelSwitchRebuild!('another-model')).toBe(true);
  });
  it.each([{ remoteHostId: 'remote' }, { reviewMode: true as const }, { vendorOptions: { orcaRole: 'worker' } }])(
    'keeps nonordinary environments on their existing transport: %j', async mode => {
      const native = vi.fn<NonNullable<AgentDeps['createLocalPiNativeSession']>>();
      const agent = new PiAgent({ binaryPath: process.execPath, logger, runtimeConfig: {}, createLocalPiNativeSession: native,
        auth: { getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}) } });
      await expect(agent.startSession({ sessionId: 'task', workingDir: os.tmpdir(), model: mock.model, nativePresentation: true, ...mode })).rejects.toThrow(
        'remoteHostId' in mode ? 'remoteSession' : 'ordinary local interactive host');
      expect(native).not.toHaveBeenCalled(); expect(mock.rpc).not.toHaveBeenCalled();
    },
  );
});
