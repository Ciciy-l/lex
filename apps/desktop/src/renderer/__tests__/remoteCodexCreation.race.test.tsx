// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { StartRemoteSessionPanel } from '@/components/settings/RemoteHostDetail';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  listModels: vi.fn(),
  statusChanged: null as null | ((snapshot: { config: { id: string }; status: string }) => void),
  stopStatus: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
  };
}

function nativeProvider(models: CatalogModel[]): ProviderView {
  return {
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    auth: { method: 'oauth' },
    routing: {
      codex: {
        upstream: 'https://chatgpt.com/backend-api/codex',
        authStrategy: 'oauth-passthrough',
      },
    },
    models: { codex: models },
  };
}

function start(hostId = 'remote-host') {
  const view = render(<StartRemoteSessionPanel hostId={hostId} />);
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.startSession.start' }));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner', 1);
  mocks.listModels.mockResolvedValue([nativeProvider([model('host-default'), model('other-valid-model')])]);
  mocks.create.mockResolvedValue({ id: 'created-session' });
  mocks.stat.mockResolvedValue({ kind: 'dir', resolvedPath: '/remote/project' });
  mocks.mkdir.mockResolvedValue({ resolvedPath: '/remote/project' });
  mocks.confirm.mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      remoteSsh: {
        listCodexModels: mocks.listModels,
        onStatusChanged: (callback: typeof mocks.statusChanged) => {
          mocks.statusChanged = callback;
          return mocks.stopStatus;
        },
        statRemotePath: mocks.stat,
        mkdirPRemote: mocks.mkdir,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
});

describe('settings SSH Codex creation race', () => {
  it('stops creation when the host default route changes during remote path validation', async () => {
    let releaseStat!: (result: { kind: 'dir'; resolvedPath: string }) => void;
    const delayedStat = new Promise<{ kind: 'dir'; resolvedPath: string }>((resolve) => {
      releaseStat = resolve;
    });
    mocks.stat.mockReturnValueOnce(delayedStat);

    start();
    await waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(1));

    mocks.listModels.mockResolvedValueOnce([
      nativeProvider([model('other-valid-model'), model('host-default')]),
    ]);
    releaseStat({ kind: 'dir', resolvedPath: '/remote/project' });

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.selectionChanged'),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('creates a stable selected OpenAI subscription route successfully', async () => {
    start();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/created-session'));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      agentKind: 'codex',
      workingDir: '/remote/project',
      workspaceKind: 'project',
      permissionMode: 'auto',
      model: 'host-default',
      providerId: 'openai',
      effort: 'high',
      fastMode: false,
      remoteHostId: 'remote-host',
    });
  });

  it('does not use controller preferences when the remote model list fails', async () => {
    mocks.listModels.mockRejectedValueOnce(new Error('private remote failure'));

    start();

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.modelCatalogFailed'),
    );
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('stops after an account generation change during remote path validation', async () => {
    let releaseStat!: (result: { kind: 'dir'; resolvedPath: string }) => void;
    mocks.stat.mockReturnValueOnce(new Promise((resolve) => { releaseStat = resolve; }));

    start();
    await waitFor(() => expect(mocks.stat).toHaveBeenCalledOnce());
    setDataOwnerGeneration('owner-b', 2);
    releaseStat({ kind: 'dir', resolvedPath: '/remote/project' });

    await waitFor(() => expect(mocks.create).not.toHaveBeenCalled());
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('stops after the selected host changes during remote path validation', async () => {
    let releaseStat!: (result: { kind: 'dir'; resolvedPath: string }) => void;
    mocks.stat.mockReturnValueOnce(new Promise((resolve) => { releaseStat = resolve; }));

    const view = start('remote-host');
    await waitFor(() => expect(mocks.stat).toHaveBeenCalledOnce());
    view.rerender(<StartRemoteSessionPanel hostId="other-host" />);
    releaseStat({ kind: 'dir', resolvedPath: '/remote/project' });

    await waitFor(() => expect(mocks.create).not.toHaveBeenCalled());
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('stops after the SSH host disconnects during remote path validation', async () => {
    let releaseStat!: (result: { kind: 'dir'; resolvedPath: string }) => void;
    mocks.stat.mockReturnValueOnce(new Promise((resolve) => { releaseStat = resolve; }));

    start();
    await waitFor(() => expect(mocks.stat).toHaveBeenCalledOnce());
    act(() => mocks.statusChanged?.({ config: { id: 'remote-host' }, status: 'disconnected' }));
    releaseStat({ kind: 'dir', resolvedPath: '/remote/project' });

    await waitFor(() => expect(mocks.create).not.toHaveBeenCalled());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.stopStatus).toHaveBeenCalledOnce();
  });

  it('does not create a session when the confirmed missing directory becomes a file', async () => {
    mocks.stat
      .mockResolvedValueOnce({ kind: 'missing', resolvedPath: '/remote/project' })
      .mockResolvedValueOnce({ kind: 'file', resolvedPath: '/remote/project' });

    start();

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.errorWorkdirIsFile'),
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
