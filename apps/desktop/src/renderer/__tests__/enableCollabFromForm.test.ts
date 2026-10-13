import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateWorkerForm } from '@/features/cc-agent/CreateWorkerPopover';

const mocks = vi.hoisted(() => ({
  sticky: vi.fn(),
  localEnable: vi.fn(),
  remoteEnable: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: mocks.sticky,
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { forceRefresh: mocks.refresh } }));
vi.mock('@/features/cc-agent/remoteCollabHandoff', () => ({
  enableRemoteCollabForSession: mocks.remoteEnable,
}));
import { enableCollabFromForm } from '@/features/cc-agent/enableCollabFromForm';

const form: CreateWorkerForm = {
  role: 'Code Reviewer',
  agent: 'codex',
  model: 'gpt-5.4',
  effort: 'high',
  fast: true,
  providerId: 'selected-provider',
  initialTask: 'Review the pending change',
  workerPermissionMode: 'auto',
};
const expectedOptions = {
  workerAgent: 'codex',
  role: 'Code Reviewer',
  label: 'code-reviewer',
  model: 'gpt-5.4',
  effort: 'high',
  fast: true,
  providerId: 'selected-provider',
  delegateTask: 'Review the pending change',
  workerPermissionMode: 'auto',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.localEnable.mockResolvedValue({ workerSessionId: 'local-worker' });
  mocks.remoteEnable.mockResolvedValue({ focusWorkerSessionId: 'remote-worker' });
  mocks.refresh.mockResolvedValue(undefined);
  vi.stubGlobal('window', { electronAPI: { maker: { enableOrca: mocks.localEnable } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('enableCollabFromForm', () => {
  it('preserves the complete local Worker form and refreshes after successful creation', async () => {
    await expect(enableCollabFromForm('lead', form)).resolves.toBe('local-worker');
    expect(mocks.sticky).toHaveBeenCalledWith('lead');
    expect(mocks.localEnable).toHaveBeenCalledExactlyOnceWith('lead', expectedOptions);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('active');
    expect(mocks.remoteEnable).not.toHaveBeenCalled();
  });

  it('uses the sticky remote owner and delegates recovery and mirroring to the existing handoff', async () => {
    mocks.sticky.mockReturnValue('sticky-device');
    await expect(enableCollabFromForm('lead', form)).resolves.toBe('remote-worker');
    expect(mocks.remoteEnable).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'sticky-device',
      leadSessionId: 'lead',
      options: expectedOptions,
      logTag: 'sidebar enable collab',
    });
    expect(mocks.localEnable).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('keeps an explicit local owner and allocated label without resolving ownership again', async () => {
    mocks.sticky.mockReturnValue('other-device');
    await expect(enableCollabFromForm('lead', form, 'code-reviewer-2', null)).resolves.toBe(
      'local-worker',
    );
    expect(mocks.sticky).not.toHaveBeenCalled();
    expect(mocks.localEnable).toHaveBeenCalledExactlyOnceWith('lead', {
      ...expectedOptions,
      label: 'code-reviewer-2',
    });
    expect(mocks.remoteEnable).not.toHaveBeenCalled();
  });

  it.each(['DEVICE_LINK_TIMEOUT', 'PERMISSION_DENIED'])(
    'propagates remote %s without retrying or creating a local team',
    async (code) => {
      mocks.sticky.mockReturnValue('other-device');
      const error = new Error(`[${code}] enable failed`);
      mocks.remoteEnable.mockRejectedValue(error);
      await expect(enableCollabFromForm('lead', form, 'code-reviewer-2', 'pinned')).rejects.toBe(
        error,
      );
      expect(mocks.sticky).not.toHaveBeenCalled();
      expect(mocks.remoteEnable).toHaveBeenCalledExactlyOnceWith({
        deviceId: 'pinned',
        leadSessionId: 'lead',
        options: { ...expectedOptions, label: 'code-reviewer-2' },
        logTag: 'sidebar enable collab',
      });
      expect(mocks.localEnable).not.toHaveBeenCalled();
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );
});
