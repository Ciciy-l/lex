import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTerminalDriver, ClaudeLocalSessionLaunch, Logger } from '@cindy/maker-core';
import { createClaudeNativeHostSession } from '../claude-native-host.js';

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@cindy/maker-core', async importOriginal => ({
  ...await importOriginal<typeof import('@cindy/maker-core')>(), createClaudeNativeSession: native.create,
}));
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-native-host-test-'));
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
  type ExitListener = Parameters<AgentTerminalDriver['onExit']>[0];
  const unregister = vi.fn(), exits = new Set<ExitListener>();
  const terminal = { pid: 12345, write: vi.fn(), resize: vi.fn(), snapshot: vi.fn(() => ({ data: '', cols: 120, rows: 36 })),
    onData: () => vi.fn(), onExit: (fn: ExitListener) => { exits.add(fn); return () => { exits.delete(fn); }; }, close: vi.fn(async () => {}) };
  const launch: ClaudeLocalSessionLaunch = { cwd, abortController: new AbortController(), additionalDirectories: [], managedSkillPluginRoots: [],
    model: 'fixture-model', permissionMode: 'default', binaryPath: 'fixture-native', sessionId: randomUUID(), enableFileCheckpointing: true,
    env: { ANTHROPIC_API_KEY: 'fixture-secret' }, systemPromptAppend: 'same prefix', settingSources: [], settings: {},
    allowDangerouslySkipPermissions: false, debug: false, hooks: {}, registerProcess: vi.fn(() => unregister), releaseNativeResources: vi.fn(async () => {}),
    canUseTool: async () => ({ behavior: 'deny', message: 'fixture' }) };
  const createTerminal = vi.fn(() => terminal), onEvent = vi.fn();
  const options = { launch, logger, model: launch.model, onEvent, onFault: vi.fn(),
    policy: { setInteractionResolver() {}, beforeInput() {}, close() {} }, prepareInput: async () => ({ text: 'fixture' }) };
  native.create.mockImplementation(async input => {
    const driver = await input.runtime.launch({ executable: input.runtime.executable, args: [...input.runtime.args], env: { ...input.runtime.env },
      cwd: input.runtime.cwd, cols: 120, rows: 36 });
    return { close: () => driver.close() };
  });
  const root = () => { const args = native.create.mock.calls.at(-1)![0].runtime.args; return path.dirname(args[args.indexOf('--settings') + 1]); };
  return { options, launch, terminal, unregister, createTerminal, root,
    exit() { for (const fn of [...exits]) fn({ code: 0 }); } };
}
describe('native Claude Main resource ownership', () => {
  it('passes the real launch and policy into Core, retaining resources until confirmed native exit', async () => {
    const f = await fixture(), handle = await createClaudeNativeHostSession(f.options, f.createTerminal);
    cleanups.push(() => handle.close());
    expect(native.create).toHaveBeenCalledOnce();
    expect(native.create.mock.calls[0]![0]).toMatchObject({ policy: f.options.policy, prepareInput: f.options.prepareInput,
      runtime: { nativeSessionId: f.launch.sessionId, hooks: f.launch.hooks, canUseTool: f.launch.canUseTool, onEvent: f.options.onEvent } });
    expect(f.launch.registerProcess).toHaveBeenCalledWith(12345);
    expect(f.createTerminal.mock.calls[0]).toBeDefined();
    expect(JSON.stringify(f.createTerminal.mock.calls)).toContain('fixture-secret'); // env-only host spec
    expect(JSON.stringify(native.create.mock.calls[0]![0].runtime.args)).not.toContain('fixture-secret');
    let complete!: () => void; f.terminal.close.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const closing = handle.close();
    await vi.waitFor(() => expect(complete).toBeDefined());
    expect((await fs.stat(f.root())).isDirectory()).toBe(true); expect(f.unregister).not.toHaveBeenCalled();
    expect(f.launch.releaseNativeResources).not.toHaveBeenCalled();
    complete(); await closing;
    await expect(fs.stat(f.root())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.unregister).toHaveBeenCalledOnce();
    expect(f.launch.releaseNativeResources).toHaveBeenCalledOnce();
    f.terminal.close.mockResolvedValue();
  });

  it('releases resources after natural exit without closing a still-readable terminal view', async () => {
    const f = await fixture(), handle = await createClaudeNativeHostSession(f.options, f.createTerminal); cleanups.push(() => handle.close());
    f.exit();
    await vi.waitFor(async () => expect(await fs.stat(f.root()).then(() => true, () => false)).toBe(false));
    expect(f.terminal.close).not.toHaveBeenCalled(); expect(f.unregister).toHaveBeenCalledOnce();
    await handle.close(); expect(f.unregister).toHaveBeenCalledOnce();
  });

  it('retains files and process registration when native exit is uncertain', async () => {
    const f = await fixture(), handle = await createClaudeNativeHostSession(f.options, f.createTerminal);
    f.terminal.close.mockRejectedValue(new Error('exit unconfirmed'));
    await expect(handle.close()).rejects.toThrow('exit unconfirmed');
    expect((await fs.stat(f.root())).isDirectory()).toBe(true); expect(f.unregister).not.toHaveBeenCalled();
    f.exit();
    await vi.waitFor(async () => expect(await fs.stat(f.root()).then(() => true, () => false)).toBe(false));
    expect(f.unregister).toHaveBeenCalledOnce();
  });

  it('cleans prepared files when startup fails before a process exists', async () => {
    const f = await fixture(); native.create.mockRejectedValue(new Error('startup refused'));
    await expect(createClaudeNativeHostSession(f.options, f.createTerminal)).rejects.toThrow('startup refused');
    expect(f.createTerminal).not.toHaveBeenCalled();
    await expect(fs.stat(f.root())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.launch.releaseNativeResources).toHaveBeenCalledOnce();
  });

  it('releases owned skill resources when launch preparation rejects before spawning', async () => {
    const f = await fixture(); f.launch.getOAuthToken = async () => 'fixture-token';
    await expect(createClaudeNativeHostSession(f.options, f.createTerminal)).rejects.toThrow('subscription refresh');
    expect(f.createTerminal).not.toHaveBeenCalled(); expect(native.create).not.toHaveBeenCalled();
    expect(f.launch.releaseNativeResources).toHaveBeenCalledOnce();
  });
});
