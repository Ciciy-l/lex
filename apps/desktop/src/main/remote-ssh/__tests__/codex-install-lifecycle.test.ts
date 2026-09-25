import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRemoteCodexActivityAdmission,
  acquireRemoteCodexInstallation,
  prepareRemoteAgentInstall,
  withRemoteCodexInstallation,
} from '../codex-install-lifecycle.js';

describe('remote Codex package replacement lifecycle', () => {
  let deps: {
    isInstalled: ReturnType<typeof vi.fn>;
    hasLiveTurn: ReturnType<typeof vi.fn>;
    stopDaemon: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    deps = {
      isInstalled: vi.fn(async () => false),
      hasLiveTurn: vi.fn(() => false),
      stopDaemon: vi.fn(async () => ({ ok: true })),
    };
  });

  it('leaves other engines and the exact current Codex pin untouched', async () => {
    await expect(prepareRemoteAgentInstall('omp', deps)).resolves.toBeUndefined();
    deps.isInstalled.mockResolvedValueOnce(true);
    await expect(prepareRemoteAgentInstall('codex', deps)).resolves.toBeUndefined();
    expect(deps.hasLiveTurn).toHaveBeenCalledOnce();
    expect(deps.stopDaemon).not.toHaveBeenCalled();
  });

  it('refuses to upgrade a stale Codex package while any remote turn is active', async () => {
    deps.hasLiveTurn.mockReturnValue(true);
    await expect(prepareRemoteAgentInstall('codex', deps))
      .rejects.toThrow('upgrade deferred while a remote task is running');
    expect(deps.stopDaemon).not.toHaveBeenCalled();
  });

  it('fails closed when the old daemon cannot be stopped, otherwise permits the pinned installer', async () => {
    deps.stopDaemon.mockResolvedValueOnce({ ok: false });
    await expect(prepareRemoteAgentInstall('codex', deps))
      .rejects.toThrow('Unable to stop the old Codex daemon');

    deps.stopDaemon.mockResolvedValueOnce({ ok: true });
    await expect(prepareRemoteAgentInstall('codex', deps)).resolves.toBeUndefined();
    expect(deps.stopDaemon).toHaveBeenCalledTimes(2);
  });

  it('refuses package replacement when an installed Codex session is already running', async () => {
    deps.isInstalled.mockResolvedValue(true);
    deps.hasLiveTurn.mockReturnValue(true);

    await expect(prepareRemoteAgentInstall('codex', deps))
      .rejects.toThrow('upgrade deferred while a remote task is running');
    expect(deps.stopDaemon).not.toHaveBeenCalled();
  });

  it('serializes session and send admission against the asynchronous daemon stop', async () => {
    let finishStop!: (result: { ok: boolean }) => void;
    const stop = new Promise<{ ok: boolean }>((resolve) => { finishStop = resolve; });
    deps.stopDaemon.mockReturnValueOnce(stop);
    const installing = withRemoteCodexInstallation('builder', () =>
      prepareRemoteAgentInstall('codex', deps),
    );
    await vi.waitFor(() => expect(deps.stopDaemon).toHaveBeenCalledOnce());

    expect(() => acquireRemoteCodexActivityAdmission('builder'))
      .toThrow('installation is in progress');
    finishStop({ ok: true });
    await expect(installing).resolves.toBeUndefined();

    const releaseAdmission = acquireRemoteCodexActivityAdmission('builder');
    expect(() => acquireRemoteCodexInstallation('builder'))
      .toThrow('session startup is in progress');
    releaseAdmission();
  });
});
