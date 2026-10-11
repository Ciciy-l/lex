import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const env = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  trusted: true,
  generation: 4,
  owner: 'owner-a' as string | null,
  install: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  read: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      name: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => env.handlers.set(name, handler),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!env.trusted) throw new Error('UNTRUSTED');
  },
  isTrustedAppRendererWindow: () => env.trusted,
}));
vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ generation: env.generation, dataOwnerId: env.owner }),
}));
vi.mock('../agent-binaries/harness-manager.js', () => ({
  harnessState: env.read,
  checkHarness: env.read,
  installHarness: env.install,
  cancelHarness: vi.fn(),
  onHarnessProgress: vi.fn(),
}));
vi.mock('../maker-host/omp-harness-settings.js', () => ({
  ompHarnessState: env.read,
  parseOmpHarnessPatch: (raw: unknown) => raw, // Value validation is covered by the store tests.
  writeOmpHarnessSettings: env.write,
  clearOmpNativeMemory: env.clear,
}));
import { registerHarnessSettingsIpc } from '../harness-settings-ipc.js';
const invoke = (channel: string, ...args: unknown[]) =>
  env.handlers.get(channel)!({} as IpcMainInvokeEvent, ...args);
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(env, { trusted: true, generation: 4, owner: 'owner-a' });
  env.handlers.clear();
  registerHarnessSettingsIpc();
});
describe('local Harness IPC boundaries', () => {
  it('rejects every channel before accessing settings or runtimes for an untrusted sender', async () => {
    env.trusted = false;
    for (const channel of env.handlers.keys())
      await expect(invoke(channel)).rejects.toThrow('UNTRUSTED');
    expect(env.install).not.toHaveBeenCalled();
    expect(env.read).not.toHaveBeenCalled();
    expect(env.clear).not.toHaveBeenCalled();
    expect(env.write).not.toHaveBeenCalled();
  });
  it('accepts only a known runtime and host-resolved release identity', async () => {
    const selection = { kind: 'omp', source: 'upstream', version: '18.2.0' };
    for (const raw of [
      null,
      [],
      { ...selection, url: 'https://other.invalid/run' },
      { ...selection, kind: '../omp' },
      { ...selection, source: 'custom' },
      { ...selection, version: '18.2.0; run' },
    ]) {
      await expect(invoke('harness:install', raw)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    }
    expect(env.install).not.toHaveBeenCalled();
    await invoke('harness:install', selection);
    expect(env.install).toHaveBeenCalledWith(selection);
  });
  it('rejects stale account confirmations and unknown reset keys', async () => {
    await expect(invoke('harness:omp:set', { nativeMemory: true }, 3)).rejects.toThrow(
      'ACCOUNT_CHANGED',
    );
    await expect(invoke('harness:omp:reset', ['nativeMemory'], 3)).rejects.toThrow(
      'ACCOUNT_CHANGED',
    );
    await expect(invoke('harness:omp:clear-memory', 3)).rejects.toThrow('ACCOUNT_CHANGED');
    await expect(invoke('harness:omp:reset', ['dbPath'], 4)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(env.clear).not.toHaveBeenCalled();
    expect(env.write).not.toHaveBeenCalled();
    env.owner = null;
    await expect(invoke('harness:omp:clear-memory', 4)).rejects.toThrow('ACCOUNT_CHANGED');
  });
  it('encodes failures without exposing local paths or arbitrary error messages', async () => {
    env.install.mockRejectedValueOnce(new Error('secret local path'));
    await expect(
      invoke('harness:install', { kind: 'omp', source: 'baseline', version: '18.1.18' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.not.stringContaining('secret'),
    });
    env.clear.mockRejectedValueOnce(new Error('OMP_MEMORY_BUSY'));
    await expect(invoke('harness:omp:clear-memory', 4)).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
  });
});
