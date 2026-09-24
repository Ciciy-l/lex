import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({ forkSession: vi.fn(), query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: sdkMock.forkSession, query: sdkMock.query }));

import { ClaudeCodeAgent, setClaudeSupportedModelsListener } from '../index.js';

function logger(): Logger {
  const value: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => value };
  return value;
}
function agentFor(auth: AuthAdapter) {
  const deps: AgentDeps = { auth, runtimeConfig: {}, binaryPath: process.execPath, logger: logger() };
  return new ClaudeCodeAgent(deps);
}
function auth(states: Array<{ authenticated: boolean; identity?: string }>, generations = ['gen-a', 'gen-a']) {
  const getState = vi.fn(async () => states.shift() ?? { authenticated: false });
  const captureCredentialGeneration = vi.fn(() => generations.shift() ?? 'gen-a');
  const getAuthEnv = vi.fn(async (options) => {
    expect(options).toMatchObject({ credentialMode: 'oauth-bearer', providerId: 'anthropic' });
    return { CLAUDE_CODE_OAUTH_TOKEN: 'adapter-owned-token' };
  });
  const adapter: AuthAdapter = {
    getState, getAuthEnv, captureCredentialGeneration,
    async triggerLogin() { return { authenticated: false }; },
    async logout() {},
  };
  return { adapter, getState, captureCredentialGeneration, getAuthEnv };
}
function fakeQuery(models: unknown[]) {
  return { supportedModels: vi.fn(async () => models), close: vi.fn() };
}

afterEach(() => { setClaudeSupportedModelsListener(null); sdkMock.query.mockReset(); });

describe('Claude supportedModels isolated probe', () => {
  it('uses the current AuthAdapter, reads no settings and sends no prompt', async () => {
    const models = [{ value: 'claude-sonnet-6', displayName: 'Sonnet 6' }];
    const query = fakeQuery(models);
    sdkMock.query.mockReturnValue(query);
    const authState = auth([{ authenticated: true, identity: 'account-a' }, { authenticated: true, identity: 'account-a' }]);
    const onSupportedModels = vi.fn();
    const instance = agentFor(authState.adapter);

    await expect(instance.refreshLocalModels({ providerId: 'anthropic', credentialMode: 'oauth-bearer', onSupportedModels })).resolves.toBe(true);
    expect(authState.getAuthEnv).toHaveBeenCalledOnce();
    expect(onSupportedModels).toHaveBeenCalledWith(models);
    expect(query.close).toHaveBeenCalledOnce();
    const [{ prompt, options }] = sdkMock.query.mock.calls[0] as [{ prompt: AsyncIterable<unknown>; options: Record<string, unknown> }];
    const env = options.env as Record<string, string>;
    expect(options.settingSources).toEqual([]);
    expect(env.CLAUDE_CONFIG_DIR).toBe(options.cwd);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('adapter-owned-token');
    expect(options).not.toHaveProperty('nativeCliAuth');
    const input: unknown[] = [];
    for await (const item of prompt) input.push(item);
    expect(input).toEqual([]);
    await expect(fs.access(String(options.cwd))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(path.dirname(String(options.cwd))).toBe(path.resolve(os.tmpdir()));
  });

  it('does not deliver results after the account identity or credential generation changes', async () => {
    const onSupportedModels = vi.fn();
    sdkMock.query.mockReturnValue(fakeQuery([{ value: 'claude-sonnet-6' }]));
    const switched = auth([
      { authenticated: true, identity: 'account-a' },
      { authenticated: true, identity: 'account-b' },
    ]);
    await expect(agentFor(switched.adapter).refreshLocalModels({ providerId: 'anthropic', onSupportedModels })).resolves.toBe(false);
    expect(onSupportedModels).not.toHaveBeenCalled();

    sdkMock.query.mockReturnValue(fakeQuery([{ value: 'claude-sonnet-6' }]));
    const rotated = auth([
      { authenticated: true, identity: 'account-a' },
      { authenticated: true, identity: 'account-a' },
    ], ['gen-a', 'gen-b']);
    await expect(agentFor(rotated.adapter).refreshLocalModels({ providerId: 'anthropic', onSupportedModels })).resolves.toBe(false);
    expect(onSupportedModels).not.toHaveBeenCalled();
  });
});
