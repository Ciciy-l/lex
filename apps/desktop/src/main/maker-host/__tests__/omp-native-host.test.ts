import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOmpSessionLaunchPlan, type AgentTerminalDriver, type Logger, type OmpLocalNativeSessionOptions } from '@cindy/maker-core';
import { createOmpNativeHostSession } from '../omp-native-host.js';
import type { AgentTerminalLaunch } from '../../terminal/agentTerminalDriver.js';

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@cindy/maker-core', async importOriginal => ({
  ...await importOriginal<typeof import('@cindy/maker-core')>(), createOmpNativeSession: native.create,
}));
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-omp-native-host-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const resume = path.join(root, 'original.jsonl'); await fs.writeFile(resume, '{}\n');
  const plan = createOmpSessionLaunchPlan({ roots: { home: path.join(root, 'home'), workingDir: root,
    platform: process.platform, ...(process.platform === 'win32' ? { windowsSystemRoot: path.win32.resolve('C:/Windows') } : {}) },
    permissionMode: 'ask', model: { provider: 'cindy', model: 'fixture-model' } });
  type ExitListener = Parameters<AgentTerminalDriver['onExit']>[0];
  const exits = new Set<ExitListener>();
  const driver = { pid: 54321, write: vi.fn(), resize: vi.fn(), onData: () => vi.fn(),
    onExit: (fn: ExitListener) => { exits.add(fn); return () => { exits.delete(fn); }; }, close: vi.fn(async () => {}) };
  const createTerminal = vi.fn((_spec: AgentTerminalLaunch) => driver), releaseResources = vi.fn(async () => {});
  const options: OmpLocalNativeSessionOptions = { sessionId: 'task', model: 'fixture-model', providerId: 'actual-source',
    permissionMode: 'ask', resumeSessionId: resume, executable: 'original-omp', hostTools: [], plan, logger, releaseResources };
  native.create.mockImplementation(async input => {
    const terminal = await input.launch({ LEX_OMP_BRIDGE_TOKEN: 'test-only-secret' }, [{ name: 'real_tool', label: 'real tool', description: 'original definition', parameters: { type: 'object' }, loadMode: 'essential' }]);
    return { close: () => terminal.close() };
  });
  return { options, driver, createTerminal, releaseResources, exit() { for (const fn of [...exits]) fn({ code: 0 }); } };
}
describe('OMP interactive Main resource ownership', () => {
  it('keeps the prepared provider/permission/config and resumes only the original session file', async () => {
    const f = await fixture(), handle = await createOmpNativeHostSession(f.options, f.createTerminal);
    const spec = f.createTerminal.mock.calls[0]![0];
    expect(spec.executable).toBe('original-omp');
    expect(spec.args).toEqual([...f.options.plan.arguments.slice(2), '--session-dir', f.options.plan.roots.sessions,
      '--extension', path.join(f.options.plan.roots.temporary, 'lex-native-extension.ts'), '--resume', f.options.resumeSessionId]);
    expect(spec.args).not.toContain('--mode'); expect(spec.args).not.toContain('--no-tools');
    expect(spec.env).toMatchObject({ ...f.options.plan.environment, LEX_OMP_BRIDGE_TOKEN: 'test-only-secret' });
    const schemas = await fs.readFile(spec.env.LEX_OMP_HOST_TOOLS_FILE, 'utf8');
    expect(JSON.parse(schemas)).toMatchObject([{ name: 'real_tool', parameters: { type: 'object' }, loadMode: 'essential' }]);
    expect(schemas).not.toContain('test-only-secret');
    await handle.close(); expect(f.releaseResources).toHaveBeenCalledOnce();
    await expect(fs.stat(spec.env.LEX_OMP_HOST_TOOLS_FILE)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains startup files/leases after unconfirmed close and releases them on the exact later exit', async () => {
    const f = await fixture(), handle = await createOmpNativeHostSession(f.options, f.createTerminal);
    const file = f.createTerminal.mock.calls[0]![0].env.LEX_OMP_HOST_TOOLS_FILE;
    f.driver.close.mockRejectedValue(new Error('exit unconfirmed'));
    await expect(handle.close()).rejects.toThrow('exit unconfirmed');
    expect(f.releaseResources).not.toHaveBeenCalled(); expect((await fs.stat(file)).isFile()).toBe(true);
    f.exit(); await vi.waitFor(() => expect(f.releaseResources).toHaveBeenCalledOnce());
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never falls back to a new task when the original history is missing', async () => {
    const f = await fixture(); await fs.rm(f.options.resumeSessionId!);
    await expect(createOmpNativeHostSession(f.options, f.createTerminal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.createTerminal).not.toHaveBeenCalled(); expect(native.create).not.toHaveBeenCalled();
    expect(f.releaseResources).toHaveBeenCalledOnce();
  });
});
