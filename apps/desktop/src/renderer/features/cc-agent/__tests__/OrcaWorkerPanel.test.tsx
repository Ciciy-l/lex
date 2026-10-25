// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrcaWorkerPanel } from '../OrcaWorkerPanel';
import { requestNewWorkerFromShortcut } from '../lib/newWorkerShortcut';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  hardLimit: 2,
  createOpen: false,
  refreshCreationState: vi.fn(),
  setCreateOpen: vi.fn(),
  toastError: vi.fn(),
  toolbarProps: {} as Record<string, unknown>,
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useAgentIslandSettings', () => ({ isAgentIslandSupported: () => false }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../CCAgentSessionView', () => ({ CCAgentSessionView: () => null }));
vi.mock('../CreateWorkerPopover', () => ({ CreateWorkerPopover: () => null }));
vi.mock('../RolePillDropdown', () => ({
  WorkerListToolbar: (props: Record<string, unknown>) => {
    mocks.toolbarProps = props;
    return null;
  },
}));
vi.mock('../hooks/useOrcaWorkerSelection', () => ({
  useOrcaWorkerSelection: () => ({
    workers: [],
    focusedWorker: null,
    activeWorkerCount: 0,
    softLimit: 1,
    hardLimit: mocks.hardLimit,
    refresh: vi.fn(),
    refreshCreationState: mocks.refreshCreationState,
    selectedWorkerRecord: null,
    selectedWorkerId: null,
    workerSessionId: null,
    createOpen: mocks.createOpen,
    setCreateOpen: mocks.setCreateOpen,
    handleCreateWorker: vi.fn(),
    handleSwitchFocus: vi.fn(),
    handleArchiveWorker: vi.fn(),
    workerPermissionMode: 'auto',
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OrcaWorkerPanel New Maker shortcut', () => {
  beforeEach(() => {
    mocks.hardLimit = 2;
    mocks.createOpen = false;
    mocks.refreshCreationState.mockReset();
    mocks.setCreateOpen.mockReset();
    mocks.toastError.mockReset();
    mocks.toolbarProps = {};
  });

  afterEach(() => {
    cleanup();
  });

  it.each(['hide and return', 'lead', 'device', 'remote host', 'owner', 'unmount'])('discards a pending mouse open after %s', async change => {
    const pending = deferred<unknown>();
    mocks.refreshCreationState.mockReturnValue(pending.promise);
    const panel = render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    act(() => (mocks.toolbarProps.onOpenCreate as () => void)());
    expect(mocks.refreshCreationState).toHaveBeenCalledOnce();
    if (change === 'unmount') panel.unmount();
    else if (change === 'owner') { setDataOwnerGeneration('another-owner'); setDataOwnerGeneration(null); }
    else if (change === 'hide and return') {
      panel.rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible={false} />);
      panel.rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    } else panel.rerender(<OrcaWorkerPanel leadSessionId={change === 'lead' ? 'lead-2' : 'lead-1'}
      deviceId={change === 'device' ? 'device-2' : null} remoteHostId={change === 'remote host' ? 'host-2' : undefined} viewVisible />);
    await act(async () => pending.resolve({ status: 'applied', workers: [], hardLimit: 2 }));
    expect(mocks.setCreateOpen).not.toHaveBeenCalledWith(true);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('coalesces mouse and shortcut opens while refreshing, then permits a fresh open', async () => {
    const pending = deferred<unknown>();
    mocks.refreshCreationState.mockReturnValue(pending.promise);
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    act(() => { (mocks.toolbarProps.onOpenCreate as () => void)(); (mocks.toolbarProps.onOpenCreate as () => void)(); });
    const shortcut = requestNewWorkerFromShortcut();
    expect(mocks.refreshCreationState).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ status: 'applied', workers: [], hardLimit: 2 }));
    await shortcut;
    expect(mocks.setCreateOpen).toHaveBeenCalledTimes(1);
    act(() => (mocks.toolbarProps.onOpenCreate as () => void)());
    await waitFor(() => expect(mocks.setCreateOpen).toHaveBeenCalledTimes(2));
  });

  it('opens the existing create dialog only from the visible collaboration panel', async () => {
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied',
      workers: [],
      hardLimit: 2,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.refreshCreationState).toHaveBeenCalledOnce();
    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);
  });

  it('does not start another open transaction while the dialog is already open', async () => {
    mocks.createOpen = true;
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.refreshCreationState).not.toHaveBeenCalled();
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
  });

  it.each(['failed', 'rejected'])('reports a current mouse refresh %s without opening', async failure => {
    if (failure === 'rejected') mocks.refreshCreationState.mockRejectedValue(new Error('unavailable'));
    else mocks.refreshCreationState.mockResolvedValue({ status: 'failed', workers: [], hardLimit: null });
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    act(() => (mocks.toolbarProps.onOpenCreate as () => void)());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
  });

  it('allows a new owner to open while an old owner refresh is still pending', async () => {
    const old = deferred<unknown>();
    mocks.refreshCreationState.mockReturnValueOnce(old.promise).mockResolvedValue({ status: 'applied', workers: [], hardLimit: 2 });
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    act(() => (mocks.toolbarProps.onOpenCreate as () => void)());
    setDataOwnerGeneration('next-owner');
    act(() => (mocks.toolbarProps.onOpenCreate as () => void)());
    await waitFor(() => expect(mocks.setCreateOpen).toHaveBeenCalledOnce());
    await act(async () => old.resolve({ status: 'failed', workers: [], hardLimit: null }));
    expect(mocks.setCreateOpen).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('consumes the shortcut without opening when the refreshed team is at the hard limit', async () => {
    mocks.hardLimit = 1;
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied',
      workers: [{ status: 'running' }],
      hardLimit: 1,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
  });

  it('consumes the shortcut and reports an error when authoritative creation state cannot be refreshed', async () => {
    mocks.refreshCreationState.mockResolvedValue({
      status: 'failed',
      workers: [],
      hardLimit: null,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'newChat.collaboration.createWorkerRefreshFailed',
    );
  });

  it('does not retain an in-flight shortcut after the visible panel unmounts', async () => {
    const pending = deferred<{ status: 'applied'; workers: []; hardLimit: number }>();
    mocks.refreshCreationState.mockReturnValue(pending.promise);
    const panel = render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);

    const request = requestNewWorkerFromShortcut();
    await waitFor(() => expect(mocks.refreshCreationState).toHaveBeenCalledOnce());
    panel.unmount();
    await act(async () => pending.resolve({ status: 'applied', workers: [], hardLimit: 2 }));

    await expect(request).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    await expect(requestNewWorkerFromShortcut()).resolves.toBe(false);
  });
});

describe('OrcaWorkerPanel settings navigation wiring', () => {
  afterEach(() => {
    cleanup();
  });

  it('omits settings navigation for device-link controlled leads', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
  });

  it('wires settings navigation for local leads', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeTypeOf('function');
  });

  it('fails closed for unresolved device ownership', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
  });
});
